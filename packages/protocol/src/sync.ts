// The doc socket's wire vocabulary (A§4.1, A§5.1, A§10.5): close codes, the server's unicast events and the
// trusted headers the Worker sets on a party request.

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

/** Unicast events travel as `__YPS:<json>`, the envelope the provider delivers as `custom-message`. */
export const CUSTOM_PREFIX = '__YPS:';

export type WriteRefusalReason = 'role' | 'doc-cap' | 'suggest';

export type ServerEvent =
  /** A write that did not land; the close follows. */
  | { t: 'write-refused'; reason: WriteRefusalReason }
  /**
   * The server state vector (base64) after persisting this connection's writes, and the deletes those frames
   * carried (base64 `Y.encodeSnapshot` of a snapshot with an empty state vector): a delete never moves a state
   * vector, so `sv` alone cannot say a delete has landed.
   */
  | { t: 'ack'; sv: string; ds?: string }
  | { t: 'doc-deleted' };

/** Headers the Worker sets after stripping every client `x-moss-*` and `x-partykit-*` header. */
export const TRUSTED = {
  principal: 'x-moss-principal',
  role: 'x-moss-role',
  session: 'x-moss-session',
  share: 'x-moss-share',
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
