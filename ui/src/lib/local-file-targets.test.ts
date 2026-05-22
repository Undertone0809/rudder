// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveLocalFileTarget } from "./local-file-targets";

describe("resolveLocalFileTarget", () => {
  it("recognizes local filesystem targets", () => {
    expect(resolveLocalFileTarget("/Users/zeeland/work/result.md")).toBe("/Users/zeeland/work/result.md");
    expect(resolveLocalFileTarget("file:///Users/zeeland/work/result%20copy.md")).toBe("/Users/zeeland/work/result copy.md");
    expect(resolveLocalFileTarget("C:\\Users\\zeeland\\work\\result.md")).toBe("C:\\Users\\zeeland\\work\\result.md");
    expect(resolveLocalFileTarget("\\\\server\\share\\result.md")).toBe("\\\\server\\share\\result.md");
  });

  it("rejects non-local and ambiguous targets", () => {
    expect(resolveLocalFileTarget("https://example.com/result.md")).toBeNull();
    expect(resolveLocalFileTarget("mailto:test@example.com")).toBeNull();
    expect(resolveLocalFileTarget("result.md")).toBeNull();
    expect(resolveLocalFileTarget("/issues/RUD-43")).toBeNull();
    expect(resolveLocalFileTarget("//example.com/result.md")).toBeNull();
  });
});
