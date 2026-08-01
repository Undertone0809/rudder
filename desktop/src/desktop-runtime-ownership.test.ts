import { describe, expect, it } from "vitest";
import { shouldPreferDesktopRuntimeOwnership } from "./desktop-runtime-ownership.js";

describe("Desktop runtime ownership", () => {
  it("attaches to the dev runner in unpackaged development", () => {
    expect(shouldPreferDesktopRuntimeOwnership(false)).toBe(false);
  });

  it("keeps packaged Desktop as the preferred local runtime owner", () => {
    expect(shouldPreferDesktopRuntimeOwnership(true)).toBe(true);
  });
});
