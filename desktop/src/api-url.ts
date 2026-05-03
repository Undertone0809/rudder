export function buildDesktopApiRequestUrl(apiBaseUrl: string, apiPath: string): string {
  const base = apiBaseUrl.trim().replace(/\/+$/, "");
  const path = apiPath.trim().startsWith("/") ? apiPath.trim() : `/${apiPath.trim()}`;
  const baseIncludesApi = base.endsWith("/api");

  if (baseIncludesApi) {
    if (path === "/api") return base;
    return `${base}${path.startsWith("/api/") ? path.slice("/api".length) : path}`;
  }

  if (path === "/api" || path.startsWith("/api/")) {
    return `${base}${path}`;
  }

  return `${base}/api${path}`;
}
