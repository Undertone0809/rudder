import { describe, expect, it } from "vitest";
import {
  browserLocalTargetRelativePath,
  createBrowserLocalFilePreview,
  readBrowserLocalFileFromDirectorySelection,
} from "./browserLocalFiles";

describe("createBrowserLocalFilePreview", () => {
  it("reads a matching text file in the browser", async () => {
    const file = new File(["# Local notes"], "notes.md", { type: "text/markdown" });

    await expect(createBrowserLocalFilePreview(file, "/Users/example/notes.md"))
      .resolves.toMatchObject({
        filePath: "notes.md",
        content: "# Local notes",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
      });
  });

  it("requires the selected file name to match the transcript target", async () => {
    const file = new File(["not the requested file"], "other.md", { type: "text/markdown" });

    await expect(createBrowserLocalFilePreview(file, "/Users/example/notes.md"))
      .rejects.toThrow("Select the local file named notes.md.");
  });

  it("keeps unknown binary data out of inline text rendering", async () => {
    const file = new File([new Uint8Array([0, 1, 2])], "data.bin");

    await expect(createBrowserLocalFilePreview(file, "/tmp/data.bin"))
      .resolves.toMatchObject({
        content: null,
        contentPath: null,
        previewKind: "binary",
        message: "No inline preview is available for this file type.",
      });
  });
});

describe("browser local directory target resolution", () => {
  it("resolves only the path suffix below the uniquely named granted folder", () => {
    expect(browserLocalTargetRelativePath(
      "/Users/example/rudder-oss/ui/src/evidence.md",
      "rudder-oss",
    )).toBe("ui/src/evidence.md");
  });

  it("rejects ambiguous roots and path traversal segments", () => {
    expect(() => browserLocalTargetRelativePath("/workspace/src/src/file.ts", "src"))
      .toThrow("appears only once");
    expect(() => browserLocalTargetRelativePath("/workspace/../private/file.ts", "workspace"))
      .toThrow("cannot be resolved safely");
  });

  it("matches the exact workspace-relative target in the directory-picker fallback", () => {
    const expected = new File(["requested"], "evidence.md", { type: "text/markdown" });
    const unrelated = new File(["same basename, other folder"], "evidence.md", { type: "text/markdown" });
    Object.defineProperty(expected, "webkitRelativePath", {
      configurable: true,
      value: "rudder-oss/ui/src/evidence.md",
    });
    Object.defineProperty(unrelated, "webkitRelativePath", {
      configurable: true,
      value: "rudder-oss/other/evidence.md",
    });

    expect(readBrowserLocalFileFromDirectorySelection(
      [unrelated, expected],
      "/Users/example/rudder-oss/ui/src/evidence.md",
    )).toMatchObject({
      file: expected,
      rootName: "rudder-oss",
      relativePath: "ui/src/evidence.md",
    });
  });
});
