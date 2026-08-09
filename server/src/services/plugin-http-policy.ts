import ipaddr from "ipaddr.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Treat every non-public address range as blocked for outbound plugin HTTP.
 * The resolver passes literal addresses here, so range classification covers
 * private, loopback, link-local, CGNAT, documentation, multicast, and other
 * reserved or unassigned ranges without maintaining a fragile CIDR list.
 */
export function isPluginHttpAddressBlocked(value: string): boolean {
  const normalized = value.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!ipaddr.isValid(normalized)) return true;

  const address = ipaddr.process(normalized);
  if (address.kind() === "ipv4") {
    const [first, second] = address.toByteArray();
    return address.range() !== "unicast" || (first === 198 && (second === 18 || second === 19));
  }

  const bytes = address.toByteArray();
  const isDeprecatedSiteLocal = bytes[0] === 0xfe
    && ((bytes[1] ?? 0) & 0xc0) === 0xc0;
  return address.range() !== "unicast" || isDeprecatedSiteLocal;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}

export function normalizePluginHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RUDDER_PLUGIN_HTTP_ALLOWLIST entries must be valid origins");
  }
  if (
    !ALLOWED_PROTOCOLS.has(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("RUDDER_PLUGIN_HTTP_ALLOWLIST entries must contain only an HTTP(S) origin");
  }
  return url.origin;
}

export function parsePluginHttpAllowlistEnv(
  env: Record<string, string | undefined>,
): string[] {
  return Array.from(new Set(parseCsv(env.RUDDER_PLUGIN_HTTP_ALLOWLIST).map(normalizePluginHttpOrigin)));
}

export function isPluginHttpOriginAllowed(
  url: URL,
  allowedOrigins: readonly string[],
): boolean {
  return allowedOrigins.includes(url.origin);
}
