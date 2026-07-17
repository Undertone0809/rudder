import { describe, expect, it } from "vitest";
import {
  directoryAndParentDirectories,
  normalizeRequestedPath,
  parentDirectories,
} from "./workspace-path-policy";

describe("workspace path policy", () => {
  it("keeps file and directory ancestry stable", () => {
    expect([...parentDirectories("a/b/file.md")]).toEqual(["a", "a/b"]);
    expect([...directoryAndParentDirectories("a/b")]).toEqual(["a", "a/b"]);
  });

  it("normalizes requested paths without inventing a root selection", () => {
    expect(normalizeRequestedPath(" docs/readme.md ")).toBe("docs/readme.md");
    expect(normalizeRequestedPath("   ")).toBeNull();
    expect(normalizeRequestedPath(null)).toBeNull();
  });
});
