// The local client's awareness identity (A§10.7), read once per binding mount (seam c of the vendored plugin). The
// principal, its claimed color and the agent flag arrive with presence (T1.5).
export interface LocalIdentity {
  name: string;
  color: string;
  awarenessData: Record<string, unknown>;
}

export function localIdentity(): LocalIdentity {
  return { name: '', color: '', awarenessData: {} };
}
