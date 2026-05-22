const INTERNAL_NAVIGATION_PROTOCOLS = new Set(["about:", "data:"]);
const EXTERNAL_OPEN_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

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

export function canOpenBlockedNavigationExternally(targetUrl: string): boolean {
  try {
    return EXTERNAL_OPEN_PROTOCOLS.has(new URL(targetUrl.trim()).protocol);
  } catch {
    return false;
  }
}
