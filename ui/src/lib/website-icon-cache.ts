const FAILED_ICON_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_ICON_CACHE_ENTRIES = 256;
const failedWebsiteIconUrls = new Map<string, number>();

function normalizedIconUrl(value: string) {
  return value.trim();
}

export function isWebsiteIconUrlKnownFailed(value: string | null | undefined) {
  const key = normalizedIconUrl(value ?? "");
  if (!key) return false;
  const failedAt = failedWebsiteIconUrls.get(key);
  if (failedAt === undefined) return false;
  if (failedAt + FAILED_ICON_CACHE_TTL_MS <= Date.now()) {
    failedWebsiteIconUrls.delete(key);
    return false;
  }
  failedWebsiteIconUrls.delete(key);
  failedWebsiteIconUrls.set(key, failedAt);
  return true;
}

export function markWebsiteIconUrlFailed(value: string | null | undefined) {
  const key = normalizedIconUrl(value ?? "");
  if (!key) return;
  failedWebsiteIconUrls.delete(key);
  failedWebsiteIconUrls.set(key, Date.now());
  while (failedWebsiteIconUrls.size > MAX_FAILED_ICON_CACHE_ENTRIES) {
    const oldest = failedWebsiteIconUrls.keys().next().value;
    if (typeof oldest !== "string") break;
    failedWebsiteIconUrls.delete(oldest);
  }
}

export function __clearWebsiteIconFailureCacheForTests() {
  failedWebsiteIconUrls.clear();
}
