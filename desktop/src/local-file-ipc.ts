import { randomUUID } from "node:crypto";
import {
  previewLocalFile,
  updateLocalFile,
  type DesktopLocalFilePreview,
  type DesktopLocalFileUpdateRequest,
} from "./local-file-preview.js";

type LocalFileIpcEvent = {
  sender: unknown;
};

type LocalFileIpcMain = {
  handle(
    channel: string,
    handler: (event: LocalFileIpcEvent, ...args: any[]) => unknown,
  ): void;
};

type LocalFileUpdateInput = DesktopLocalFileUpdateRequest & {
  writeCapability: string;
};

export function registerLocalFileIpcHandlers(ipcMain: LocalFileIpcMain, options: {
  getMainRenderer(): unknown;
  preview?: typeof previewLocalFile;
  update?: typeof updateLocalFile;
}): void {
  const preview = options.preview ?? previewLocalFile;
  const update = options.update ?? updateLocalFile;
  const localFileWriteAdmissions = new Map<string, string>();

  function requireMainRenderer(event: LocalFileIpcEvent, action: "editing" | "preview"): void {
    const mainRenderer = options.getMainRenderer();
    if (!mainRenderer || event.sender !== mainRenderer) {
      throw new Error(
        action === "preview"
          ? "Local file preview is only available to the main Rudder window."
          : "Local file editing is only available to the main Rudder window.",
      );
    }
  }

  ipcMain.handle("desktop:preview-local-file", async (event, targetPath: string) => {
    requireMainRenderer(event, "preview");
    const result = await preview(targetPath);
    const writeCapability = result.content !== null && !result.truncated
      ? randomUUID()
      : null;
    if (writeCapability) {
      localFileWriteAdmissions.set(writeCapability, result.canonicalPath);
      if (localFileWriteAdmissions.size > 256) {
        const oldestCapability = localFileWriteAdmissions.keys().next().value;
        if (oldestCapability) localFileWriteAdmissions.delete(oldestCapability);
      }
    }
    return { ...result, writeCapability };
  });

  ipcMain.handle("desktop:update-local-file", async (
    event,
    targetPath: string,
    input: LocalFileUpdateInput,
  ): Promise<DesktopLocalFilePreview> => {
    requireMainRenderer(event, "editing");
    const admittedPath = localFileWriteAdmissions.get(input.writeCapability);
    if (!admittedPath || admittedPath !== targetPath) {
      throw new Error("Local file editing requires a valid preview admission.");
    }
    const result = await update(targetPath, input);
    return { ...result, writeCapability: input.writeCapability };
  });
}
