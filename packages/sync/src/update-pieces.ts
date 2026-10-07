// T3.S6: a client frame over 1 MiB never reaches the DocDO (workerd closes the socket and the reconnect resends it
// whole), so a large update leaves the client as pieces. Each piece is a valid update: its structs in clock order, cut
// only before a top-level block, so a peer never renders a block that arrived without its attributes; the deletes ride
// in the last. A piece then needs only what the server holds and the pieces before it carry (A§10.10's "missing").
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

/** True when `struct` starts a block at the top of the doc's `root`, the only place a piece may start. */
function startsBlock(doc: Y.Doc, root: unknown, struct: Struct): boolean {
  if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) return false;
  if ((struct.parent as unknown) === 'root') return true;
  try {
    const live = Y.getItem(doc.store, struct.id);
    return live instanceof Y.Item && live.parent === root;
  } catch {
    return false;
  }
}

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
 * `update` (Yjs v1, made from `doc`, which holds every struct in it) as pieces of at most about `limit` bytes. A
 * single block larger than `limit` stays one piece.
 */
export function splitUpdate(doc: Y.Doc, update: Uint8Array, limit: number): UpdatePiece[] {
  if (update.byteLength <= limit) return [{ update, ends: Y.parseUpdateMeta(update).to, deletes: true }];
  const { structs, ds } = Y.decodeUpdate(update);
  const root = doc.share.get('root');
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
    const cut = struct.id.client !== client || startsBlock(doc, root, struct);
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
