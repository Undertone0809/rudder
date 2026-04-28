import { describe, expect, it } from "vitest";
import { projectColorAccent, projectColorBackgroundStyle } from "./project-colors";

describe("project-colors", () => {
  it("uses supported gradient values as backgrounds", () => {
    const color = "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)";
    expect(projectColorBackgroundStyle(color)).toEqual({ background: color });
  });

  it("extracts the first gradient stop for single-color accents", () => {
    expect(projectColorAccent("linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)")).toBe("#6366f1");
  });

  it("does not pass unsafe CSS through to style objects", () => {
    expect(projectColorBackgroundStyle("url(https://example.com/image.png)").background).toBe(
      "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
    );
  });
});
