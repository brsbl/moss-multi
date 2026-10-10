// The bucket a client address is counted under (A§7): an IPv4 address as itself, an IPv6 address as its /64, since one
// subscriber usually holds a whole /64. Null for an absent or malformed address, which callers refuse, never pool.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function ipv4(text: string): number[] | null {
  const match = IPV4.exec(text);
  const octets = match?.slice(1).map(Number);
  return octets && octets.every((octet) => octet <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parts = halves.map((half) => (half ? half.split(':') : []));
  // A dotted IPv4 tail (`::ffff:192.0.2.1`) is the last two groups.
  const last = parts.at(-1)!;
  if (last.at(-1)?.includes('.')) {
    const octets = ipv4(last.pop()!);
    if (!octets) return null;
    last.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
  }
  if (!parts.every((groups) => groups.every((group) => HEX_GROUP.test(group)))) return null;
  const [head, tail = []] = parts as [string[], string[]?];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill('0'), ...tail].map((group) => parseInt(group, 16));
}

export function addressBucket(raw: string | null): string | null {
  const text = raw?.trim().toLowerCase() ?? '';
  if (!text || text.length > 64) return null;
  const v4 = ipv4(text);
  if (v4) return v4.join('.');
  const groups = ipv6Groups(text);
  if (!groups) return null;
  // An IPv4-mapped address is that IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}
