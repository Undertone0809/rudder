import { describe, expect, it } from "vitest";
import { isPreviewableImage } from "./image-actions";

describe("image action routing", () => {
  it("uses content type when the server provides one", () => {
    expect(isPreviewableImage("image/png", "attachment")).toBe(true);
    expect(isPreviewableImage("text/html", "misleading.png")).toBe(false);
  });

  it("falls back to a known image extension when content type is absent", () => {
    expect(isPreviewableImage(null, "Screenshot.WEBP")).toBe(true);
    expect(isPreviewableImage(undefined, "report.pdf")).toBe(false);
  });
});
