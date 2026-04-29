import { describe, expect, it } from "vitest";
import { getContainedImagePreviewSize, getImagePreviewViewportBounds, isValidImageNaturalSize } from "./image-preview";

describe("image preview sizing", () => {
  it("keeps wide images within the viewport without changing aspect ratio", () => {
    const size = getContainedImagePreviewSize({ width: 1600, height: 900 }, 1600, 1100);

    expect(size).toEqual({ width: 1440, height: 810 });
    expect(size.width / size.height).toBeCloseTo(1600 / 900, 2);
  });

  it("fits tall images to the available height", () => {
    const size = getContainedImagePreviewSize({ width: 900, height: 1600 }, 1400, 1000);

    expect(size).toEqual({ width: 549, height: 976 });
    expect(size.width / size.height).toBeCloseTo(900 / 1600, 2);
  });

  it("does not upscale smaller images", () => {
    expect(getContainedImagePreviewSize({ width: 640, height: 360 }, 1600, 1100)).toEqual({
      width: 640,
      height: 360,
    });
  });

  it("exposes viewport bounds with fixed padding and width cap", () => {
    expect(getImagePreviewViewportBounds(1920, 1080)).toEqual({ maxWidth: 1440, maxHeight: 1056 });
  });

  it("validates natural sizes before using them", () => {
    expect(isValidImageNaturalSize({ width: 1200, height: 800 })).toBe(true);
    expect(isValidImageNaturalSize({ width: 0, height: 800 })).toBe(false);
    expect(isValidImageNaturalSize(null)).toBe(false);
  });
});
