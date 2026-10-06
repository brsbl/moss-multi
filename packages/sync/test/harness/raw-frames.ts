// Hand-encoded V1 updates, as a client that ignores the binding can send them: any struct kind, any origin, right
// origin or parent, and any delete set.
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

type Struct = Y.Item | Y.GC | Y.Skip;

/** Each client's structs must be consecutive and in clock order. Deletes are [client, clock, length]. */
export function raw(structs: Struct[], deletes: [number, number, number][] = []): Uint8Array {
  const byClient = new Map<number, Struct[]>();
  for (const struct of structs) byClient.set(struct.id.client, [...(byClient.get(struct.id.client) ?? []), struct]);
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, byClient.size);
  for (const [client, list] of byClient) {
    encoding.writeVarUint(encoder.restEncoder, list.length);
    encoder.writeClient(client);
    encoding.writeVarUint(encoder.restEncoder, list[0].id.clock);
    for (const struct of list) struct.write(encoder, 0);
  }
  const byDeleted = new Map<number, [number, number][]>();
  for (const [client, clock, length] of deletes) byDeleted.set(client, [...(byDeleted.get(client) ?? []), [clock, length]]);
  encoding.writeVarUint(encoder.restEncoder, byDeleted.size);
  for (const [client, ranges] of byDeleted) {
    encoder.resetDsCurVal();
    encoding.writeVarUint(encoder.restEncoder, client);
    encoding.writeVarUint(encoder.restEncoder, ranges.length);
    for (const [clock, length] of ranges) {
      encoder.writeDsClock(clock);
      encoder.writeDsLen(length);
    }
  }
  return encoder.toUint8Array();
}

export interface At {
  origin?: Y.ID;
  right?: Y.ID;
  parent?: string | Y.ID;
  sub?: string;
}

export const forged = (id: Y.ID, at: At, content: ConstructorParameters<typeof Y.Item>[7]) =>
  new Y.Item(id, null, at.origin ?? null, null, at.right ?? null, (at.parent ?? null) as never, at.sub ?? null, content);

export const gcStruct = (id: Y.ID, length = 1) => new Y.GC(id, length);
export const skipStruct = (id: Y.ID, length = 1) => new Y.Skip(id, length);
