export function normalizeProductAnalyticsCollectorUrl(value: string): string {
  const parsed = new URL(value);
  const isLocalHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalHttp) throw new Error("product_analytics_collector_requires_https");
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}
