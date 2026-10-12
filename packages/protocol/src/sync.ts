// The doc socket's wire vocabulary (A§4.1, A§5.1, A§10.5): close codes and what a client does on each, the server's
// unicast events and the trusted headers the Worker sets on a party request.
import type { TerminalReason } from './dom-contract.ts';
import type { SuggestReply } from './suggest.ts';

/** Close codes, defined once. 1001, 1006, 1011-1013, 4408 and 4420 are transient; the 44xx below are designed. */
export const CLOSE = {
  normal: 1000,
  noPrincipal: 4401,
  sessionEnded: 4402,
  revoked: 4403,
  unavailable: 4404,
  heartbeat: 4408,
  writeRefused: 4409,
  deleted: 4410,
  writeRate: 4420,
  connectionLimit: 4429,
} as const;
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/** What a client does when its doc socket closes with a code (A§10.5), decided once here. */
export type CloseAction =
  /** 1000: an intentional close or a superseded socket; nothing to dispatch. */
  | { kind: 'normal' }
  /** 1001, 1006, 1011-1013, 4408, 4420 and any undefined code: reconnect with backoff, keeping the Y.Doc. */
  | { kind: 'retry' }
  /** The doc is over for this client: stop reconnecting at once. */
  | { kind: 'terminal'; reason: TerminalReason }
  /** 4403: ask REST, then rebind read-only or go terminal `revoked`. */
  | { kind: 'reask' }
  /** 4409: the write-refused reason arrived just before; the local doc cannot be delivered. */
  | { kind: 'refused' };

export function closeAction(code: number): CloseAction {
  switch (code) {
    case CLOSE.normal:
      return { kind: 'normal' };
    case CLOSE.noPrincipal:
    case CLOSE.sessionEnded:
      return { kind: 'terminal', reason: 'session-ended' };
    case CLOSE.unavailable:
      return { kind: 'terminal', reason: 'unavailable' };
    case CLOSE.deleted:
      return { kind: 'terminal', reason: 'deleted' };
    case CLOSE.connectionLimit:
      return { kind: 'terminal', reason: 'conn-limit' };
    case CLOSE.revoked:
      return { kind: 'reask' };
    case CLOSE.writeRefused:
      return { kind: 'refused' };
    default:
      return { kind: 'retry' };
  }
}

/** Unicast events travel as `__YPS:<json>`, the envelope the provider delivers as `custom-message`. */
export const CUSTOM_PREFIX = '__YPS:';

/** `protected-type`: the frame writes `comments`, `suggestions` or a leased suggestion client id (A§5.1 steps 2b and 4). */
export type WriteRefusalReason = 'role' | 'doc-cap' | 'suggest' | 'unresolved' | 'protected-type';

export type ServerEvent =
  /** A write that did not land; the close follows. */
  | { t: 'write-refused'; reason: WriteRefusalReason }
  /**
   * The server state vector (base64) after persisting this connection's writes, and the deletes those frames
   * carried (base64 `Y.encodeSnapshot` of a snapshot with an empty state vector): a delete never moves a state
   * vector, so `sv` alone cannot say a delete has landed.
   */
  | { t: 'ack'; sv: string; ds?: string; p?: Record<string, PayloadAck>; pb?: number }
  /**
   * After the sync step 1 on connect: `pb` is the bytes of every payload doc the DocDO stores for the note, withheld
   * ones too, as it counts them against the state cap (A§5.1). Acks carry it as well. A client holds only the payloads
   * its tree names, so it adds this, not its own, to its cap estimate (T3.S6). Sent only when there are any; an ack
   * without `pb` means none.
   */
  | { t: 'usage'; pb: number }
  | { t: 'doc-deleted' }
  | SuggestReply;

/** The same coverage for one payload doc (A§10.10), keyed by its block id in the ack's `p`. */
export interface PayloadAck {
  sv: string;
  ds?: string;
}

/**
 * A decorator payload's own sync on the doc socket (A§10.10): `[PAYLOAD_MESSAGE, regId, y-protocols sync message]`,
 * the sync message being a step (0 step 1, 1 step 2, 2 update) and its length-prefixed bytes. y-protocols uses 0-3.
 */
export const PAYLOAD_MESSAGE = 7;
export const PAYLOAD_STEP1 = 0;
export const PAYLOAD_STEP2 = 1;
export const PAYLOAD_UPDATE = 2;

/** Longest block id a payload frame may carry; minted ids are UUIDs, import ids a type, a hash and an ordinal. */
export const PAYLOAD_ID_MAX = 200;

export interface PayloadFrame {
  id: string;
  step: number;
  /** The state vector (step 1) or the update (step 2, update). */
  data: Uint8Array;
}

function writeVarUint(out: number[], value: number): void {
  let rest = value;
  while (rest > 0x7f) {
    out.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

/** A y-protocols sync frame: message 0, the step, then its length-prefixed payload. */
export function encodeSyncFrame(step: number, data: Uint8Array): Uint8Array {
  const head = [0, step];
  writeVarUint(head, data.length);
  const frame = new Uint8Array(head.length + data.length);
  frame.set(head);
  frame.set(data, head.length);
  return frame;
}

export function encodePayloadFrame(id: string, step: number, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(id);
  const head: number[] = [PAYLOAD_MESSAGE];
  writeVarUint(head, name.length);
  const middle: number[] = [];
  writeVarUint(middle, step);
  writeVarUint(middle, data.length);
  const frame = new Uint8Array(head.length + name.length + middle.length + data.length);
  frame.set(head);
  frame.set(name, head.length);
  frame.set(middle, head.length + name.length);
  frame.set(data, head.length + name.length + middle.length);
  return frame;
}

/** The frame's parts, or null when it is not a well-formed payload frame. */
export function decodePayloadFrame(bytes: Uint8Array): PayloadFrame | null {
  let at = 0;
  const varUint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= bytes.length || scale > 2 ** 35) throw new RangeError('truncated');
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
  };
  try {
    if (varUint() !== PAYLOAD_MESSAGE) return null;
    const length = varUint();
    if (length === 0 || at + length > bytes.length) return null;
    const id = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(at, at + length));
    at += length;
    if (id.length > PAYLOAD_ID_MAX) return null;
    const step = varUint();
    if (step !== PAYLOAD_STEP1 && step !== PAYLOAD_STEP2 && step !== PAYLOAD_UPDATE) return null;
    const size = varUint();
    if (at + size !== bytes.length) return null;
    return { id, step, data: bytes.subarray(at, at + size) };
  } catch {
    return null;
  }
}

/** Headers the Worker sets after stripping every client `x-moss-*` and `x-partykit-*` header. */
export const TRUSTED = {
  principal: 'x-moss-principal',
  role: 'x-moss-role',
  session: 'x-moss-session',
  share: 'x-moss-share',
  presence: 'x-moss-presence',
  /** Epoch ms taken before the role was resolved: a DocDO refuses a socket resolved before a principal's revocation. */
  resolvedAt: 'x-moss-resolved-at',
  /** The doc's access epoch, read before the role was resolved: a DocDO re-resolves a socket admitted under an older one. */
  epoch: 'x-moss-epoch',
} as const;

export const PRINCIPAL_KINDS = ['user', 'agent', 'anonymous'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface PartyPrincipal {
  id: string;
  kind: PrincipalKind;
  name: string;
}

/** Header values are ASCII; names are not. */
export const encodePartyPrincipal = (principal: PartyPrincipal): string => encodeURIComponent(JSON.stringify(principal));

export function decodePartyPrincipal(value: string | null): PartyPrincipal | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<PartyPrincipal>;
    if (typeof parsed.id !== 'string' || !parsed.id || typeof parsed.name !== 'string') return null;
    if (!(PRINCIPAL_KINDS as readonly unknown[]).includes(parsed.kind)) return null;
    return { id: parsed.id, kind: parsed.kind as PrincipalKind, name: parsed.name };
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
