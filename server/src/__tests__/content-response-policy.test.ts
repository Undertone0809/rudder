import { describe, expect, it } from "vitest";
import {
  ACTIVE_CONTENT_SANDBOX_CSP,
  buildContentResponsePolicy,
  isSafeInlineRasterContentType,
} from "../content-response-policy.js";

describe("content response policy", () => {
  it.each(["image/png", "image/jpeg", "image/webp", "image/avif", "image/bmp", "image/x-icon"])(
    "allows safe raster content inline: %s",
    (contentType) => {
      expect(isSafeInlineRasterContentType(contentType)).toBe(true);
      expect(buildContentResponsePolicy(contentType, "preview.png", "file")).toEqual({
        inline: true,
        contentDisposition: 'inline; filename="preview.png"',
        contentSecurityPolicy: null,
      });
    },
  );

  it.each(["image/svg+xml", "IMAGE/SVG+XML; charset=utf-8", "text/html", "application/pdf"])(
    "forces potentially active content to download in a sandbox: %s",
    (contentType) => {
      expect(isSafeInlineRasterContentType(contentType)).toBe(false);
      expect(buildContentResponsePolicy(contentType, "preview.svg", "file")).toEqual({
        inline: false,
        contentDisposition: 'attachment; filename="preview.svg"',
        contentSecurityPolicy: ACTIVE_CONTENT_SANDBOX_CSP,
      });
    },
  );

  it("removes control characters from response filenames", () => {
    expect(buildContentResponsePolicy("text/html", "payload\r\n\".html", "file").contentDisposition).toBe(
      'attachment; filename="payload.html"',
    );
  });
});
