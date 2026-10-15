// Terminal safety (A§17): server text (titles, names, codes, messages) never reaches the terminal raw, and a credential
// never reaches any output. `cat` is the one exception: it writes the doc's bytes as they are.

/** C0 controls but tab and LF, DEL, C1 controls, bidi marks, overrides and isolates, and the Unicode line separators. */
export function isUnsafeChar(code: number): boolean {
  return (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c || code === 0x200e || code === 0x200f || code === 0x2028 || code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

const hex = (code: number, width: number) => code.toString(16).padStart(width, '0');

function escapeUnsafe(text: string, escape: (code: number) => string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += char.length === 1 && isUnsafeChar(code) ? escape(code) : char;
  }
  return out;
}

/** Human-readable text with every unsafe character shown as a visible escape (ESC becomes `\x1b`). */
export const ttySafe = (text: string): string =>
  escapeUnsafe(text, (code) => (code <= 0xff ? `\\x${hex(code, 2)}` : `\\u${hex(code, 4)}`));

/** JSON text whose unsafe characters are `\uXXXX` escapes; it parses to the same value. */
export const jsonSafe = (json: string): string => escapeUnsafe(json, (code) => `\\u${hex(code, 4)}`);

const AGENT_KEY = /mm_sk_[A-Za-z0-9_-]{8,}/g;
export const REDACTED = '[redacted]';

/** Replaces every agent key and each of `secrets` (the session token in use) with a placeholder. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text.replace(AGENT_KEY, REDACTED);
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  return out;
}
