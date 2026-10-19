// T3.S6: a client frame over 1 MiB never reaches the DocDO (workerd closes the socket and the reconnect resends it
// whole), so a large update leaves the client as pieces. Each piece is a valid update: its structs in clock order, cut
// only before an embedded type (a block, a list item, a table row or cell, a text run), so a peer never renders an
// element that arrived without its attributes: @lexical/yjs writes a new element's attributes before its children, and
// a type's own items follow it in clock order. The deletes ride in the last piece. A piece then needs only what the
// server holds and the pieces before it carry (A§10.10's "missing").
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

type Struct = Y.Item | Y.GC | Y.Skip;
type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

export interface UpdatePiece {
  update: Uint8Array;
  /** Per client, the clock just past this piece's structs. */
  ends: Map<number, number>;
  /** This piece carries the update's deletes. */
  deletes: boolean;
}

/** Room for each piece's client headers. */
const HEADER_BYTES = 256;

/** True when `struct` starts an embedded type, the only place a piece may start within one client's run. */
const startsType = (struct: Struct): boolean => struct instanceof Y.Item && struct.content instanceof Y.ContentType;

function writeDeletes(encoder: Y.UpdateEncoderV1, ds: DeleteSet | null): void {
  const clients = ds ? [...ds.clients].filter(([, items]) => items.length > 0) : [];
  encoding.writeVarUint(encoder.restEncoder, clients.length);
  for (const [client, items] of clients) {
    encoder.resetDsCurVal();
    encoding.writeVarUint(encoder.restEncoder, client);
    encoding.writeVarUint(encoder.restEncoder, items.length);
    for (const item of items) {
      encoder.writeDsClock(item.clock);
      encoder.writeDsLen(item.len);
    }
  }
}

function encodePiece(structs: Struct[], ds: DeleteSet | null): UpdatePiece {
  const encoder = new Y.UpdateEncoderV1();
  const groups = new Map<number, Struct[]>();
  for (const struct of structs) {
    const group = groups.get(struct.id.client);
    if (group) group.push(struct);
    else groups.set(struct.id.client, [struct]);
  }
  const ends = new Map<number, number>();
  encoding.writeVarUint(encoder.restEncoder, groups.size);
  for (const [client, group] of groups) {
    encoding.writeVarUint(encoder.restEncoder, group.length);
    encoder.writeClient(client);
    encoding.writeVarUint(encoder.restEncoder, group[0].id.clock);
    for (const struct of group) struct.write(encoder, 0);
    const last = group[group.length - 1];
    ends.set(client, last.id.clock + last.length);
  }
  writeDeletes(encoder, ds);
  return { update: encoder.toUint8Array(), ends, deletes: ds !== null };
}

/**
 * `update` (Yjs v1) as pieces of at most about `limit` bytes. One text run larger than `limit` stays one piece.
 * Pieces follow the update's client order, so the update must not have one client's structs depend on another
 * client's in the same update: one session's writes (and their merged backlog) never do, since what they build on
 * from peers the server already holds. Otherwise a piece can need a later one, which the DocDO refuses as a missing
 * dependency.
 */
export function splitUpdate(update: Uint8Array, limit: number): UpdatePiece[] {
  if (update.byteLength <= limit) return [{ update, ends: Y.parseUpdateMeta(update).to, deletes: true }];
  const { structs, ds } = Y.decodeUpdate(update);
  const budget = Math.max(1, limit - HEADER_BYTES);
  const scratch = new Y.UpdateEncoderV1();
  const sized = (write: (encoder: Y.UpdateEncoderV1) => void): number => {
    const before = encoding.length(scratch.restEncoder);
    write(scratch);
    return encoding.length(scratch.restEncoder) - before;
  };
  const runs: Struct[][] = [];
  let run: Struct[] = [];
  let size = 0;
  let client: number | null = null;
  for (const struct of structs) {
    const bytes = sized((encoder) => struct.write(encoder, 0));
    const cut = struct.id.client !== client || startsType(struct);
    if (run.length > 0 && size + bytes > budget && cut) {
      runs.push(run);
      run = [];
      size = 0;
    }
    run.push(struct);
    size += bytes;
    client = struct.id.client;
  }
  if (run.length > 0) runs.push(run);
  const deletes = [...ds.clients.values()].some((items) => items.length > 0) ? ds : null;
  const fits = size + sized((encoder) => writeDeletes(encoder, deletes)) <= budget;
  const pieces = runs.map((structsOf, index) => encodePiece(structsOf, index === runs.length - 1 && fits ? deletes : null));
  if (deletes && (!fits || runs.length === 0)) pieces.push(encodePiece([], deletes));
  return pieces;
}

/** The ids an item needs before it can integrate: its left and right origins and an explicit parent. */
function dependencies(struct: Struct): Y.ID[] {
  if (!(struct instanceof Y.Item)) return [];
  const ids: Y.ID[] = [];
  if (struct.origin) ids.push(struct.origin);
  if (struct.rightOrigin) ids.push(struct.rightOrigin);
  if (struct.parent instanceof Y.ID) ids.push(struct.parent);
  return ids;
}

/**
 * A server answer (B212): `update` (Yjs v1, any number of authors) as pieces of at most about `limit` bytes, its structs
 * in dependency order, so each piece needs only what the receiver holds and the pieces before it. An item goes once its
 * origins and explicit parent are in an earlier struct (or before the update's range of their client) and every
 * earlier clock of its own client has gone. Cut only between clients or before an embedded type, as splitUpdate is.
 */
export function splitAnswer(update: Uint8Array, limit: number): Uint8Array[] {
  if (update.byteLength <= limit) return [update];
  const { structs, ds } = Y.decodeUpdate(update);
  const byClient = new Map<number, Struct[]>();
  for (const struct of structs) {
    const run = byClient.get(struct.id.client);
    if (run) run.push(struct);
    else byClient.set(struct.id.client, [struct]);
  }
  // Per client in the update: the clock up to which its structs are placed, and the next one to place.
  const placed = new Map<number, number>();
  const next = new Map<number, number>();
  for (const [client, run] of byClient) {
    placed.set(client, run[0].id.clock);
    next.set(client, 0);
  }
  const present = (id: Y.ID) => {
    const upTo = placed.get(id.client);
    return upTo === undefined || id.clock < upTo;
  };
  // Clients blocked on another's clock, keyed by that client.
  const waiting = new Map<number, number[]>();
  const ready = [...byClient.keys()];
  const ordered: Struct[] = [];
  while (ready.length > 0) {
    const client = ready.pop()!;
    const run = byClient.get(client)!;
    const from = next.get(client)!;
    let at = from;
    while (at < run.length) {
      const struct = run[at];
      const missing = dependencies(struct).find((id) => !present(id));
      if (missing) {
        const list = waiting.get(missing.client);
        if (list) list.push(client);
        else waiting.set(missing.client, [client]);
        break;
      }
      ordered.push(struct);
      placed.set(client, struct.id.clock + struct.length);
      at += 1;
    }
    next.set(client, at);
    // Only progress wakes the clients waiting on this one: two clients each waiting on the other would otherwise
    // wake each other forever.
    const woken = at > from ? waiting.get(client) : undefined;
    if (woken) {
      waiting.delete(client);
      ready.push(...woken.filter((other) => other !== client));
    }
  }
  // A cycle (only a crafted frame makes one) or a dependency outside the update: anything left goes in client order,
  // as the receiver would hold it pending anyway.
  for (const [client, run] of byClient) ordered.push(...run.slice(next.get(client)!));

  const budget = Math.max(1, limit - HEADER_BYTES);
  const scratch = new Y.UpdateEncoderV1();
  const runs: Struct[][] = [];
  let run: Struct[] = [];
  let size = 0;
  let previous: number | null = null;
  for (const struct of ordered) {
    const before = encoding.length(scratch.restEncoder);
    struct.write(scratch, 0);
    const bytes = encoding.length(scratch.restEncoder) - before;
    if (run.length > 0 && size + bytes > budget && (struct.id.client !== previous || startsType(struct))) {
      runs.push(run);
      run = [];
      size = 0;
    }
    run.push(struct);
    size += bytes;
    previous = struct.id.client;
  }
  if (run.length > 0) runs.push(run);
  const deletes = [...ds.clients.values()].some((items) => items.length > 0) ? ds : null;
  const pieces = runs.map((structsOf) => encodePiece(structsOf, null).update);
  if (deletes) pieces.push(encodePiece([], deletes).update);
  return pieces;
}
