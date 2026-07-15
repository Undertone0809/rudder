import { describe, expect, it } from "vitest";
import {
  getContainedImagePreviewSize,
  getImagePreviewControlSafeWidth,
  getImagePreviewElementDetails,
  getImagePreviewMediaSize,
  getImagePreviewName,
  getImagePreviewViewportBounds,
  isValidImageNaturalSize,
} from "./image-preview";

describe("image preview sizing", () => {
  it("normalizes reusable preview details from an image element", () => {
    const details = getImagePreviewElementDetails({
      alt: "Screenshot",
      currentSrc: "/api/assets/current/content",
      naturalHeight: 360,
      naturalWidth: 640,
      src: "/api/assets/original/content",
    } as HTMLImageElement);

    expect(details).toEqual({
      alt: "Screenshot",
      naturalSize: { width: 640, height: 360 },
      src: "/api/assets/current/content",
    });
  });

  it("derives a reusable image name from alt text or the source basename", () => {
    expect(getImagePreviewName(" Screenshot ", "/api/assets/image/content")).toBe("Screenshot");
    expect(getImagePreviewName("", "/artifacts/review%20shot.png", "https://rudder.local/chat"))
      .toBe("review shot.png");
    expect(getImagePreviewName(null, "http://[invalid", "https://rudder.local/chat"))
      .toBe("Image preview");
  });

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

  it("reserves enough media space for preview controls without upscaling the image", () => {
    const imageSize = getContainedImagePreviewSize({ width: 1, height: 1 }, 1440, 900);

    expect(imageSize).toEqual({ width: 1, height: 1 });
    expect(getImagePreviewMediaSize(imageSize, 1440, 900)).toEqual({ width: 132, height: 48 });
  });

  it("reserves control-safe media space before an image loads or after it fails", () => {
    expect(getImagePreviewMediaSize({ width: 0, height: 0 }, 1440, 900)).toEqual({
      width: 132,
      height: 48,
    });
  });

  it("reserves separate space for all Desktop actions and the close control", () => {
    expect(getImagePreviewControlSafeWidth(2)).toBe(132);
    expect(getImagePreviewControlSafeWidth(3)).toBe(168);
    expect(getImagePreviewMediaSize({ width: 1, height: 1 }, 1440, 900, 3))
      .toEqual({ width: 168, height: 48 });
  });

  it("keeps the control-safe media size inside narrow viewports", () => {
    expect(getImagePreviewMediaSize({ width: 1, height: 1 }, 100, 60)).toEqual({
      width: 76,
      height: 36,
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
