import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_BINARY_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  previewLocalFile,
} from "./local-file-preview.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-file-preview-"));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directoryPath) =>
    fs.rm(directoryPath, { recursive: true, force: true })
  ));
});

describe("previewLocalFile", () => {
  it.each([
    "notes.md",
    "file:notes.md",
  ])("rejects non-absolute target %s", async (targetPath) => {
    await expect(previewLocalFile(targetPath)).rejects.toThrow(
      "Local file preview requires an absolute path or absolute file URL.",
    );
  });

  it("returns a canonical Markdown preview for an absolute regular-file path", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "notes.md");
    const content = "# Preview\n\nA local Markdown file.\n";
    await fs.writeFile(targetPath, content);

    const preview = await previewLocalFile(targetPath);
    const canonicalPath = await fs.realpath(targetPath);
    const stats = await fs.stat(targetPath);

    expect(preview).toEqual({
      canonicalPath,
      fileName: "notes.md",
      parentPath: path.dirname(canonicalPath),
      contentType: "text/markdown; charset=utf-8",
      previewKind: "markdown",
      content,
      base64: null,
      sizeBytes: Buffer.byteLength(content),
      modifiedAt: stats.mtime.toISOString(),
      truncated: false,
    });
  });

  it("falls back from a missing source location suffix to the existing file", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "transcripts-and-results.md");
    await fs.writeFile(targetPath, "# Transcripts And Results\n");

    const preview = await previewLocalFile(`${targetPath}:40`);

    expect(preview.canonicalPath).toBe(await fs.realpath(targetPath));
    expect(preview.fileName).toBe("transcripts-and-results.md");
  });

  it("falls back from a file URL with a line and column suffix", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "transcripts-and-results.md");
    await fs.writeFile(targetPath, "# Transcripts And Results\n");

    const preview = await previewLocalFile(`${pathToFileURL(targetPath).href}:40:7`);

    expect(preview.canonicalPath).toBe(await fs.realpath(targetPath));
    expect(preview.fileName).toBe("transcripts-and-results.md");
  });

  it("prefers an existing literal colon-number filename over source location fallback", async () => {
    const directoryPath = await createTemporaryDirectory();
    const sourcePath = path.join(directoryPath, "report.md");
    const literalPath = `${sourcePath}:2026`;
    await fs.writeFile(sourcePath, "# Source location candidate\n");
    await fs.writeFile(literalPath, "# Literal filename\n");

    const preview = await previewLocalFile(literalPath);

    expect(preview.canonicalPath).toBe(await fs.realpath(literalPath));
    expect(preview.fileName).toBe("report.md:2026");
    expect(preview.content).toBe("# Literal filename\n");
  });

  it("decodes an absolute file URL before resolving the canonical path", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "release notes.md");
    await fs.writeFile(targetPath, "# Release notes\n");

    const preview = await previewLocalFile(pathToFileURL(targetPath).href);

    expect(preview.canonicalPath).toBe(await fs.realpath(targetPath));
    expect(preview.fileName).toBe("release notes.md");
    expect(preview.content).toBe("# Release notes\n");
  });

  it("rejects directories without enumerating them", async () => {
    const directoryPath = await createTemporaryDirectory();

    await expect(previewLocalFile(directoryPath)).rejects.toThrow(
      "Local file preview only supports regular files.",
    );
  });

  it.each([
    ["records.csv", "text/csv; charset=utf-8", "csv"],
    ["notes.txt", "text/plain; charset=utf-8", "text"],
    ["settings.json", "application/json; charset=utf-8", "text"],
    ["report.html", "text/html; charset=utf-8", "text"],
    ["component.mdx", "text/plain; charset=utf-8", "text"],
    ["worker.ts", "text/plain; charset=utf-8", "text"],
    [".env", "text/plain; charset=utf-8", "text"],
  ] as const)("classifies %s as an inert %s preview", async (fileName, contentType, previewKind) => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, fileName);
    const content = "safe UTF-8 content\n";
    await fs.writeFile(targetPath, content);

    const preview = await previewLocalFile(targetPath);

    expect(preview).toMatchObject({
      contentType,
      previewKind,
      content,
      base64: null,
      truncated: false,
    });
  });

  it("rejects file types outside the explicit preview allowlist", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "archive.zip");
    await fs.writeFile(targetPath, "not a supported preview family");

    await expect(previewLocalFile(targetPath)).rejects.toThrow(
      "This file type is not supported for local preview.",
    );
  });

  it("rejects text files containing binary NUL bytes", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "binary.txt");
    await fs.writeFile(targetPath, Buffer.from([0x73, 0x61, 0x66, 0x65, 0x00, 0x74, 0x65, 0x78, 0x74]));

    await expect(previewLocalFile(targetPath)).rejects.toThrow(
      "Text previews cannot contain binary NUL bytes.",
    );
  });

  it("rejects text files that are not valid UTF-8", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "invalid.txt");
    await fs.writeFile(targetPath, Buffer.from([0x66, 0x80, 0x6f]));

    await expect(previewLocalFile(targetPath)).rejects.toThrow(
      "Text previews must contain valid UTF-8.",
    );
  });

  it("truncates text previews at the byte limit", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "large.log");
    const bytes = Buffer.alloc(MAX_TEXT_PREVIEW_BYTES + 17, 0x61);
    await fs.writeFile(targetPath, bytes);

    const preview = await previewLocalFile(targetPath);

    expect(Buffer.byteLength(preview.content ?? "")).toBe(MAX_TEXT_PREVIEW_BYTES);
    expect(preview.content).toBe("a".repeat(MAX_TEXT_PREVIEW_BYTES));
    expect(preview.sizeBytes).toBe(bytes.length);
    expect(preview.truncated).toBe(true);
  });

  it("returns a signature-validated PDF preview as base64", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "report.pdf");
    const bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "ascii");
    await fs.writeFile(targetPath, bytes);

    const preview = await previewLocalFile(targetPath);

    expect(preview).toMatchObject({
      contentType: "application/pdf",
      previewKind: "pdf",
      content: null,
      base64: bytes.toString("base64"),
      sizeBytes: bytes.length,
      truncated: false,
    });
  });

  it.each([
    ["pixel.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])],
    ["photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ["animation.gif", "image/gif", Buffer.from("GIF89a0000", "ascii")],
    ["picture.webp", "image/webp", Buffer.from("RIFF0000WEBPVP8 ", "ascii")],
    ["bitmap.bmp", "image/bmp", Buffer.from([0x42, 0x4d, 0x00, 0x00])],
  ] as const)("returns a validated raster preview for %s", async (fileName, contentType, bytes) => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, fileName);
    await fs.writeFile(targetPath, bytes);

    const preview = await previewLocalFile(targetPath);

    expect(preview).toMatchObject({
      contentType,
      previewKind: "image",
      content: null,
      base64: bytes.toString("base64"),
      sizeBytes: bytes.length,
      truncated: false,
    });
  });

  it.each([
    ["spoofed.pdf", "The selected PDF does not have a valid PDF signature."],
    ["spoofed.png", "The selected image does not have a valid PNG signature."],
  ])("rejects content that does not match the %s extension", async (fileName, expectedError) => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, fileName);
    await fs.writeFile(targetPath, "not the declared file family");

    await expect(previewLocalFile(targetPath)).rejects.toThrow(expectedError);
  });

  it("rejects binary previews over the hard size limit before reading content", async () => {
    const directoryPath = await createTemporaryDirectory();
    const targetPath = path.join(directoryPath, "oversized.png");
    await fs.writeFile(targetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await fs.truncate(targetPath, MAX_BINARY_PREVIEW_BYTES + 1);

    await expect(previewLocalFile(targetPath)).rejects.toThrow(
      "Binary previews are limited to 10 MiB.",
    );
  });
});

describe("desktop local file preview bridge", () => {
  const desktopSourceDirectory = path.dirname(fileURLToPath(import.meta.url));

  it("registers a trusted-renderer-only IPC handler that calls the preview service", async () => {
    const mainSource = await fs.readFile(path.join(desktopSourceDirectory, "main.ts"), "utf8");
    const handlerStart = mainSource.indexOf('ipcMain.handle("desktop:preview-local-file"');
    const handlerEnd = mainSource.indexOf("ipcMain.handle(", handlerStart + 1);
    const handlerSource = mainSource.slice(handlerStart, handlerEnd);

    expect(mainSource).toContain('import { previewLocalFile } from "./local-file-preview.js";');
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerSource).toContain("event.sender !== mainWindow.webContents");
    expect(handlerSource).toContain('throw new Error("Local file preview is only available to the main Rudder window.")');
    expect(handlerSource).toContain("return await previewLocalFile(targetPath)");
    expect(handlerSource).not.toContain("shell.openPath");
  });

  it("exposes the typed preview method through preload and DesktopShellApi", async () => {
    const preloadSource = await fs.readFile(path.join(desktopSourceDirectory, "preload.ts"), "utf8");
    const desktopShellSource = await fs.readFile(
      path.resolve(desktopSourceDirectory, "../../ui/src/lib/desktop-shell.ts"),
      "utf8",
    );

    expect(preloadSource).toContain('ipcRenderer.invoke("desktop:preview-local-file", targetPath)');
    expect(preloadSource).toContain("as Promise<DesktopLocalFilePreview>");
    expect(desktopShellSource).toContain("export type DesktopLocalFilePreview = {");
    expect(desktopShellSource).toContain(
      "previewLocalFile(targetPath: string): Promise<DesktopLocalFilePreview>;",
    );
  });
});
