export function resolveDesktopRendererBaseUrl(options: {
  runtimeBaseUrl: string | null;
  loadUrlOverride?: string;
}): string | null {
  const override = options.loadUrlOverride?.trim();
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Preserve the runtime origin when a test or operator passes an invalid override.
    }
  }
  return options.runtimeBaseUrl?.replace(/\/$/u, "") ?? null;
}
