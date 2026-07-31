import { describe, expect, it, vi } from "vitest";
import { registerLocalFileIpcHandlers } from "./local-file-ipc.js";

type Handler = (event: { sender: unknown }, ...args: any[]) => unknown;

function createHarness() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  };
  const mainRenderer = {};
  const previewResult = {
    canonicalPath: "/workspace/notes.md",
    fileName: "notes.md",
    parentPath: "/workspace",
    contentType: "text/markdown; charset=utf-8",
    previewKind: "markdown" as const,
    content: "# Notes\n",
    base64: null,
    sizeBytes: 8,
    modifiedAt: "2026-07-30T00:00:00.000Z",
    truncated: false,
  };
  const preview = vi.fn(async () => previewResult);
  const update = vi.fn(async (_targetPath: string, input: {
    content: string;
    expectedContent: string;
  }) => ({
    ...previewResult,
    content: input.content,
  }));

  registerLocalFileIpcHandlers(ipcMain, {
    getMainRenderer: () => mainRenderer,
    preview,
    update,
  });

  return {
    handlers,
    mainRenderer,
    preview,
    previewResult,
    update,
  };
}

describe("registerLocalFileIpcHandlers", () => {
  it("rejects previews from any renderer except the current main window", async () => {
    const { handlers, preview } = createHarness();
    const handler = handlers.get("desktop:preview-local-file");

    await expect(handler?.({ sender: {} }, "/workspace/notes.md")).rejects.toThrow(
      "Local file preview is only available to the main Rudder window.",
    );
    expect(preview).not.toHaveBeenCalled();
  });

  it("admits an editable preview and uses its capability for a matching update", async () => {
    const { handlers, mainRenderer, previewResult, update } = createHarness();
    const previewHandler = handlers.get("desktop:preview-local-file");
    const updateHandler = handlers.get("desktop:update-local-file");
    const preview = await previewHandler?.({ sender: mainRenderer }, "/workspace/notes.md") as
      typeof previewResult & { writeCapability: string };

    expect(preview).toMatchObject(previewResult);
    expect(preview.writeCapability).toEqual(expect.any(String));

    const result = await updateHandler?.(
      { sender: mainRenderer },
      preview.canonicalPath,
      {
        content: "# Updated\n",
        expectedContent: preview.content,
        writeCapability: preview.writeCapability,
      },
    );

    expect(update).toHaveBeenCalledWith(preview.canonicalPath, {
      content: "# Updated\n",
      expectedContent: preview.content,
      writeCapability: preview.writeCapability,
    });
    expect(result).toMatchObject({
      content: "# Updated\n",
      writeCapability: preview.writeCapability,
    });
  });

  it("rejects updates from another renderer or with an invalid path or capability", async () => {
    const { handlers, mainRenderer, update } = createHarness();
    const previewHandler = handlers.get("desktop:preview-local-file");
    const updateHandler = handlers.get("desktop:update-local-file");
    const preview = await previewHandler?.({ sender: mainRenderer }, "/workspace/notes.md") as {
      canonicalPath: string;
      content: string;
      writeCapability: string;
    };
    const input = {
      content: "# Updated\n",
      expectedContent: preview.content,
      writeCapability: preview.writeCapability,
    };

    await expect(updateHandler?.({ sender: {} }, preview.canonicalPath, input)).rejects.toThrow(
      "Local file editing is only available to the main Rudder window.",
    );
    await expect(updateHandler?.(
      { sender: mainRenderer },
      "/workspace/other.md",
      input,
    )).rejects.toThrow("Local file editing requires a valid preview admission.");
    await expect(updateHandler?.(
      { sender: mainRenderer },
      preview.canonicalPath,
      { ...input, writeCapability: "invalid" },
    )).rejects.toThrow("Local file editing requires a valid preview admission.");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not issue write capability for truncated or binary previews", async () => {
    const { handlers, mainRenderer, preview } = createHarness();
    preview
      .mockResolvedValueOnce({
        canonicalPath: "/workspace/large.log",
        fileName: "large.log",
        parentPath: "/workspace",
        contentType: "text/plain; charset=utf-8",
        previewKind: "text",
        content: "partial",
        base64: null,
        sizeBytes: 600_000,
        modifiedAt: "2026-07-30T00:00:00.000Z",
        truncated: true,
      })
      .mockResolvedValueOnce({
        canonicalPath: "/workspace/logo.png",
        fileName: "logo.png",
        parentPath: "/workspace",
        contentType: "image/png",
        previewKind: "image",
        content: null,
        base64: "iVBORw0KGgo=",
        sizeBytes: 8,
        modifiedAt: "2026-07-30T00:00:00.000Z",
        truncated: false,
      });
    const handler = handlers.get("desktop:preview-local-file");

    await expect(handler?.({ sender: mainRenderer }, "/workspace/large.log")).resolves.toMatchObject({
      writeCapability: null,
    });
    await expect(handler?.({ sender: mainRenderer }, "/workspace/logo.png")).resolves.toMatchObject({
      writeCapability: null,
    });
  });
});
