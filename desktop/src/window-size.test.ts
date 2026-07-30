import { describe, expect, it } from "vitest";
import { resolveInitialDesktopWindowSize } from "./window-size.js";

describe("resolveInitialDesktopWindowSize", () => {
  it.each([
    {
      workArea: { width: 1920, height: 1040 },
      expected: { width: 1620, height: 936, minWidth: 1080, minHeight: 720 },
    },
    {
      workArea: { width: 1600, height: 1000 },
      expected: { width: 1440, height: 900, minWidth: 1080, minHeight: 720 },
    },
    {
      workArea: { width: 1000, height: 650 },
      expected: { width: 1000, height: 650, minWidth: 1000, minHeight: 650 },
    },
  ])("derives exact bounds for a $workArea.width x $workArea.height work area", ({
    workArea,
    expected,
  }) => {
    expect(resolveInitialDesktopWindowSize(workArea)).toEqual(expected);
  });

  it("does not regress to the former fixed 1440 x 960 default", () => {
    expect(resolveInitialDesktopWindowSize({ width: 1920, height: 1040 })).not.toMatchObject({
      width: 1440,
      height: 960,
    });
    expect(resolveInitialDesktopWindowSize({ width: 1600, height: 1000 })).not.toMatchObject({
      width: 1440,
      height: 960,
    });
  });
});
