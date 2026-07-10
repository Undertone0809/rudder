import { isIP } from "node:net";

function normalizeIpLiteral(value: string) {
  return value.replace(/^\[|\]$/gu, "").toLowerCase();
}

function parseIpv4Octets(value: string): [number, number, number, number] | null {
  const parts = normalizeIpLiteral(value).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

function parseIpv6Segments(value: string): number[] | null {
  let normalized = normalizeIpLiteral(value);
  if (!normalized || normalized.includes("%")) return null;

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4Octets(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = (ipv4[0] << 8) | ipv4[1];
    const low = (ipv4[2] << 8) | ipv4[3];
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => {
    if (!half) return [];
    const pieces = half.split(":");
    if (pieces.some((piece) => !/^[\da-f]{1,4}$/u.test(piece))) return null;
    return pieces.map((piece) => Number.parseInt(piece, 16));
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function mappedIpv4Octets(segments: number[]): [number, number, number, number] | null {
  if (segments.length !== 8) return null;
  const isIpv4Mapped = segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;
  const isIpv4Compatible = segments.slice(0, 6).every((segment) => segment === 0);
  if (!isIpv4Mapped && !isIpv4Compatible) return null;
  return [segments[6] >> 8, segments[6] & 0xff, segments[7] >> 8, segments[7] & 0xff];
}

function translatedIpv4Octets(segments: number[]): [number, number, number, number] | null {
  if (segments.length !== 8) return null;
  const isWellKnownNat64 = segments[0] === 0x0064
    && segments[1] === 0xff9b
    && segments.slice(2, 6).every((segment) => segment === 0);
  const isIpv4Translated = segments.slice(0, 4).every((segment) => segment === 0)
    && segments[4] === 0xffff
    && segments[5] === 0;
  if (!isWellKnownNat64 && !isIpv4Translated) return null;
  return [segments[6] >> 8, segments[6] & 0xff, segments[7] >> 8, segments[7] & 0xff];
}

function isNonPublicIpv4(octets: [number, number, number, number]) {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

/**
 * Returns true for private, loopback, link-local, documentation, benchmark,
 * multicast, transition, and otherwise non-routable IP literals.
 */
export function isNonPublicIpAddress(value: string) {
  const normalized = normalizeIpLiteral(value);
  const ipv4 = parseIpv4Octets(normalized);
  if (ipv4) return isNonPublicIpv4(ipv4);

  const segments = parseIpv6Segments(normalized);
  if (!segments) return true;
  const embeddedIpv4 = mappedIpv4Octets(segments) ?? translatedIpv4Octets(segments);
  if (embeddedIpv4 && isNonPublicIpv4(embeddedIpv4)) return true;

  const first = segments[0] ?? 0;
  const isUnspecified = segments.every((segment) => segment === 0);
  const isLoopback = segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isDeprecatedSiteLocal = (first & 0xffc0) === 0xfec0;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isDocumentation = first === 0x2001 && segments[1] === 0x0db8;
  const isBenchmark = first === 0x2001 && segments[1] === 0x0002 && segments[2] === 0;
  const isTeredo = first === 0x2001 && segments[1] === 0;
  const isSixToFour = first === 0x2002;
  const isDiscardOnly = first === 0x0100 && segments.slice(1, 4).every((segment) => segment === 0);
  const isLocalNat64 = first === 0x0064 && segments[1] === 0xff9b && segments[2] === 1;
  return isUnspecified
    || isLoopback
    || isUniqueLocal
    || isLinkLocal
    || isDeprecatedSiteLocal
    || isMulticast
    || isDocumentation
    || isBenchmark
    || isTeredo
    || isSixToFour
    || isDiscardOnly
    || isLocalNat64;
}

export function isPrivateHostname(hostname: string) {
  const normalized = normalizeIpLiteral(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  return isIP(normalized) !== 0 && isNonPublicIpAddress(normalized);
}

export function isPublicDnsHostname(hostname: string) {
  const normalized = normalizeIpLiteral(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  if (
    normalized.endsWith(".local")
    || normalized.endsWith(".lan")
    || normalized.endsWith(".home")
    || normalized.endsWith(".internal")
    || normalized.endsWith(".corp")
    || normalized.endsWith(".intranet")
  ) return false;
  if (!normalized.includes(".")) return false;
  return isIP(normalized) === 0;
}
