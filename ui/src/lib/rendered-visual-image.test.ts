// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getRenderedVisualCaptureSize,
  renderedVisualPngName,
} from "./rendered-visual-image";

describe("rendered visual image capture", () => {
  it("uses at most 2x pixel density", () => {
    expect(getRenderedVisualCaptureSize(800, 450, 3)).toEqual({
      width: 1600,
      height: 900,
      scale: 2,
    });
  });

  it("caps either output edge at 4096 pixels", () => {
    expect(getRenderedVisualCaptureSize(3000, 5000, 2)).toEqual({
      width: 2458,
      height: 4096,
      scale: 4096 / 5000,
    });
  });

  it("normalizes captured visualization filenames to PNG", () => {
    expect(renderedVisualPngName("agent-report.html", "visualization")).toBe("agent-report.png");
    expect(renderedVisualPngName("", "visualization")).toBe("visualization.png");
  });
});
