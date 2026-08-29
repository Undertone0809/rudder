import { describe, expect, it } from "vitest";
import { resolveMacWindowMode } from "./desktop-window-mode.js";

describe("resolveMacWindowMode", () => {
  it.each([undefined, null, "", "unexpected"])(
    "uses opaque composition for the default macOS window (%s)",
    (value) => {
      expect(resolveMacWindowMode(value)).toBe("opaque");
    },
  );

  it.each([
    ["transparent", "transparent"],
    [" TRANSPARENT_VIBRANT ", "transparent_vibrant"],
    ["transparent-vibrant", "transparent_vibrant"],
  ] as const)("preserves the explicit %s override", (value, expected) => {
    expect(resolveMacWindowMode(value)).toBe(expected);
  });
});
