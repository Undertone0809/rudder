export function classifyGoogleSmokeNavigation(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.google.com") return null;
    if (url.pathname === "/search" && url.searchParams.get("q") === "google") return "search";
    if (url.pathname.startsWith("/sorry/")) {
      const continuedUrl = url.searchParams.get("continue");
      if (!continuedUrl) return null;
      const continued = new URL(continuedUrl);
      return continued.protocol === "https:"
        && continued.hostname === "www.google.com"
        && continued.pathname === "/search"
        && continued.searchParams.get("q") === "google"
        ? "captcha"
        : null;
    }
    return null;
  } catch {
    return null;
  }
}
