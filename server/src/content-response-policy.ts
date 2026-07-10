export const ACTIVE_CONTENT_SANDBOX_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";

const SAFE_INLINE_RASTER_CONTENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

export function normalizeResponseContentType(value: string) {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isSafeInlineRasterContentType(value: string) {
  return SAFE_INLINE_RASTER_CONTENT_TYPES.has(normalizeResponseContentType(value));
}

function safeContentDispositionFilename(value: string, fallback: string) {
  return value.replace(/[\u0000-\u001f\u007f"]/gu, "").trim() || fallback;
}

export function buildContentResponsePolicy(contentType: string, filename: string, fallbackFilename: string) {
  const inline = isSafeInlineRasterContentType(contentType);
  const safeFilename = safeContentDispositionFilename(filename, fallbackFilename);
  return {
    inline,
    contentDisposition: `${inline ? "inline" : "attachment"}; filename=\"${safeFilename}\"`,
    contentSecurityPolicy: inline ? null : ACTIVE_CONTENT_SANDBOX_CSP,
  };
}
