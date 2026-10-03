import { describe, expect, it } from "vitest";
import { createBrowserLocalFilePreview } from "./browserLocalFiles";

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
