const INTERNAL_NAVIGATION_PROTOCOLS = new Set(["about:", "data:"]);
const EXTERNAL_OPEN_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const WEBVIEW_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const PRIVILEGED_DOCUMENT_PATH_PREFIXES = ["/api", "/_plugins"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function normalizeSecurityPathname(pathname: string): string {
  let normalized = pathname;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded;
    } catch {
      break;
    }
  }
  return normalized.replaceAll("\\", "/").replace(/\/{2,}/gu, "/").toLowerCase();
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin === "null") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function collectDesktopNavigationOrigins(...candidates: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      candidates
        .map((candidate) => (candidate ? normalizeOrigin(candidate) : null))
        .filter((origin): origin is string => Boolean(origin)),
    ),
  );
}

export function isAllowedDesktopNavigation(
  targetUrl: string,
  allowedOrigins: string[],
  options: { allowInternalProtocols?: boolean } = {},
): boolean {
  const trimmed = targetUrl.trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(trimmed);
    if (INTERNAL_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
      return options.allowInternalProtocols ?? true;
    }
    if (parsed.origin === "null") return false;
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function normalizeExternalOpenTarget(targetUrl: unknown): string | null {
  if (typeof targetUrl !== "string") return null;
  const trimmed = targetUrl.trim();
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    if (!EXTERNAL_OPEN_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (!parsed.hostname || parsed.username || parsed.password) return null;
    } else {
      if (!parsed.pathname.trim() || parsed.host) return null;
      if (/%0[ad]/iu.test(parsed.href)) return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function canOpenBlockedNavigationExternally(targetUrl: string): boolean {
  return normalizeExternalOpenTarget(targetUrl) !== null;
}

export function isAllowedDesktopWebviewNavigation(targetUrl: string): boolean {
  const trimmed = targetUrl.trim();
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
    return WEBVIEW_NAVIGATION_PROTOCOLS.has(parsed.protocol)
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

export function isAllowedDesktopPrivilegedDocument(targetUrl: string, allowedOrigins: string[]): boolean {
  const trimmed = targetUrl.trim();
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
    if (!WEBVIEW_NAVIGATION_PROTOCOLS.has(parsed.protocol) || !allowedOrigins.includes(parsed.origin)) return false;
    const pathname = normalizeSecurityPathname(parsed.pathname);
    return !PRIVILEGED_DOCUMENT_PATH_PREFIXES.some((prefix) => (
      pathname === prefix || pathname.startsWith(`${prefix}/`)
    ));
  } catch {
    return false;
  }
}
