import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export type DesktopLocalFilePreviewKind = "markdown" | "csv" | "text" | "image" | "pdf";

export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
export const MAX_BINARY_PREVIEW_BYTES = 10 * 1024 * 1024;

export type DesktopLocalFilePreview = {
  canonicalPath: string;
  fileName: string;
  parentPath: string;
  contentType: string;
  previewKind: DesktopLocalFilePreviewKind;
  content: string | null;
  base64: string | null;
  sizeBytes: number;
  modifiedAt: string;
  truncated: boolean;
  writeCapability?: string | null;
};

export type DesktopLocalFileUpdateRequest = {
  content: string;
  expectedContent: string;
};

type PreviewClassification = {
  contentType: string;
  previewKind: DesktopLocalFilePreviewKind;
  binarySignature?: "bmp" | "gif" | "jpeg" | "pdf" | "png" | "webp";
};

const PLAIN_TEXT_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cfg",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".cxx",
  ".diff",
  ".fish",
  ".gql",
  ".go",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".ini",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".log",
  ".mdx",
  ".mjs",
  ".mts",
  ".patch",
  ".properties",
  ".proto",
  ".ps1",
  ".py",
  ".pyi",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const PLAIN_TEXT_BASENAMES = new Set([
  ".editorconfig",
  ".env",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "rakefile",
  "readme",
]);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LOCAL_FILE_UPDATE_QUEUES = new Map<string, Promise<void>>();

const BINARY_SIGNATURE_ERROR: Record<NonNullable<PreviewClassification["binarySignature"]>, string> = {
  bmp: "The selected image does not have a valid BMP signature.",
  gif: "The selected image does not have a valid GIF signature.",
  jpeg: "The selected image does not have a valid JPEG signature.",
  pdf: "The selected PDF does not have a valid PDF signature.",
  png: "The selected image does not have a valid PNG signature.",
  webp: "The selected image does not have a valid WebP signature.",
};

function bufferStartsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function hasValidBinarySignature(
  bytes: Buffer,
  signature: NonNullable<PreviewClassification["binarySignature"]>,
): boolean {
  switch (signature) {
    case "bmp":
      return bufferStartsWith(bytes, [0x42, 0x4d]);
    case "gif":
      return bytes.subarray(0, 6).toString("ascii") === "GIF87a"
        || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
    case "jpeg":
      return bufferStartsWith(bytes, [0xff, 0xd8, 0xff]);
    case "pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    case "png":
      return bufferStartsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp":
      return bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
}

function classifyPreview(canonicalPath: string): PreviewClassification | null {
  const extension = path.extname(canonicalPath).toLowerCase();
  const basename = path.basename(canonicalPath).toLowerCase();

  if (extension === ".md" || extension === ".markdown" || extension === ".mdown" || extension === ".mkd") {
    return { contentType: "text/markdown; charset=utf-8", previewKind: "markdown" };
  }
  if (extension === ".csv") {
    return { contentType: "text/csv; charset=utf-8", previewKind: "csv" };
  }
  if (extension === ".json" || extension === ".jsonc" || extension === ".json5") {
    return { contentType: "application/json; charset=utf-8", previewKind: "text" };
  }
  if (extension === ".jsonl" || extension === ".ndjson") {
    return { contentType: "application/x-ndjson; charset=utf-8", previewKind: "text" };
  }
  if (extension === ".html" || extension === ".htm") {
    return { contentType: "text/html; charset=utf-8", previewKind: "text" };
  }
  if (extension === ".pdf") {
    return { contentType: "application/pdf", previewKind: "pdf", binarySignature: "pdf" };
  }
  if (extension === ".png") {
    return { contentType: "image/png", previewKind: "image", binarySignature: "png" };
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return { contentType: "image/jpeg", previewKind: "image", binarySignature: "jpeg" };
  }
  if (extension === ".gif") {
    return { contentType: "image/gif", previewKind: "image", binarySignature: "gif" };
  }
  if (extension === ".webp") {
    return { contentType: "image/webp", previewKind: "image", binarySignature: "webp" };
  }
  if (extension === ".bmp") {
    return { contentType: "image/bmp", previewKind: "image", binarySignature: "bmp" };
  }
  if (PLAIN_TEXT_EXTENSIONS.has(extension) || PLAIN_TEXT_BASENAMES.has(basename)) {
    return { contentType: "text/plain; charset=utf-8", previewKind: "text" };
  }
  return null;
}

function resolveAbsoluteTargetPath(targetPath: string): string {
  const isFileUrl = /^file:/i.test(targetPath);
  if (isFileUrl && !targetPath.slice("file:".length).startsWith("/")) {
    throw new Error("Local file preview requires an absolute path or absolute file URL.");
  }

  const resolvedTargetPath = isFileUrl ? fileURLToPath(targetPath) : targetPath;
  if (!path.isAbsolute(resolvedTargetPath)) {
    throw new Error("Local file preview requires an absolute path or absolute file URL.");
  }
  return resolvedTargetPath;
}

function sourceLocationBasePath(filePath: string): string | null {
  return /^(.*?):\d+(?::\d+)?$/u.exec(filePath)?.[1] ?? null;
}

function isMissingPathError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error
    && "code" in cause
    && cause.code === "ENOENT";
}

async function resolveCanonicalPreviewPath(resolvedTargetPath: string): Promise<string> {
  try {
    return await fs.realpath(resolvedTargetPath);
  } catch (cause) {
    const fallbackPath = sourceLocationBasePath(resolvedTargetPath);
    if (!isMissingPathError(cause) || !fallbackPath) throw cause;
    return await fs.realpath(fallbackPath);
  }
}

async function readTextContent(
  canonicalPath: string,
  sizeBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  const readLength = Math.min(sizeBytes, MAX_TEXT_PREVIEW_BYTES + 4);
  const handle = await fs.open(canonicalPath, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(readLength);
    const result = await handle.read(buffer, 0, readLength, 0);
    bytes = buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }

  if (bytes.includes(0)) {
    throw new Error("Text previews cannot contain binary NUL bytes.");
  }

  let previewEnd = Math.min(bytes.length, MAX_TEXT_PREVIEW_BYTES);
  while (previewEnd > 0 && previewEnd < bytes.length && (bytes[previewEnd]! & 0xc0) === 0x80) {
    previewEnd -= 1;
  }

  try {
    return {
      content: UTF8_DECODER.decode(bytes.subarray(0, previewEnd)),
      truncated: sizeBytes > MAX_TEXT_PREVIEW_BYTES,
    };
  } catch {
    throw new Error("Text previews must contain valid UTF-8.");
  }
}

export async function previewLocalFile(targetPath: string): Promise<DesktopLocalFilePreview> {
  const resolvedTargetPath = resolveAbsoluteTargetPath(targetPath);
  const canonicalPath = await resolveCanonicalPreviewPath(resolvedTargetPath);
  const stats = await fs.stat(canonicalPath);
  if (!stats.isFile()) {
    throw new Error("Local file preview only supports regular files.");
  }
  const classification = classifyPreview(sourceLocationBasePath(canonicalPath) ?? canonicalPath);
  if (!classification) {
    throw new Error("This file type is not supported for local preview.");
  }
  if (classification.binarySignature) {
    if (stats.size > MAX_BINARY_PREVIEW_BYTES) {
      throw new Error("Binary previews are limited to 10 MiB.");
    }
    const bytes = await fs.readFile(canonicalPath);
    if (!hasValidBinarySignature(bytes, classification.binarySignature)) {
      throw new Error(BINARY_SIGNATURE_ERROR[classification.binarySignature]);
    }
    return {
      canonicalPath,
      fileName: path.basename(canonicalPath),
      parentPath: path.dirname(canonicalPath),
      contentType: classification.contentType,
      previewKind: classification.previewKind,
      content: null,
      base64: bytes.toString("base64"),
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      truncated: false,
    };
  }
  const textPreview = await readTextContent(canonicalPath, stats.size);

  return {
    canonicalPath,
    fileName: path.basename(canonicalPath),
    parentPath: path.dirname(canonicalPath),
    contentType: classification.contentType,
    previewKind: classification.previewKind,
    content: textPreview.content,
    base64: null,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    truncated: textPreview.truncated,
  };
}

export async function updateLocalFile(
  targetPath: string,
  input: DesktopLocalFileUpdateRequest,
): Promise<DesktopLocalFilePreview> {
  const resolvedTargetPath = resolveAbsoluteTargetPath(targetPath);
  const canonicalPath = await fs.realpath(resolvedTargetPath);
  if (path.resolve(resolvedTargetPath) !== canonicalPath) {
    throw new Error("Local file editing requires the canonical file path returned by Rudder.");
  }
  const previous = LOCAL_FILE_UPDATE_QUEUES.get(canonicalPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => queued);
  LOCAL_FILE_UPDATE_QUEUES.set(canonicalPath, tail);
  await previous;

  try {
    const classification = classifyPreview(canonicalPath);
    if (!classification || classification.binarySignature) {
      throw new Error("This file type is not supported for local text editing.");
    }
    const contentBytes = Buffer.from(input.content, "utf8");
    if (contentBytes.byteLength > MAX_TEXT_PREVIEW_BYTES) {
      throw new Error("Editable local text files are limited to 512 KiB.");
    }
    if (input.content.includes("\0")) {
      throw new Error("Local text files cannot contain binary NUL bytes.");
    }

    const handle = await fs.open(canonicalPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      const pathStats = await fs.lstat(canonicalPath);
      if (
        !openedStats.isFile()
        || pathStats.isSymbolicLink()
        || openedStats.dev !== pathStats.dev
        || openedStats.ino !== pathStats.ino
      ) {
        throw new Error("Local file editing only supports the admitted canonical regular file.");
      }
      if (openedStats.size > MAX_TEXT_PREVIEW_BYTES) {
        throw new Error("Truncated local file previews cannot be edited.");
      }
      const currentBytes = await handle.readFile();
      if (currentBytes.includes(0)) {
        throw new Error("Text previews cannot contain binary NUL bytes.");
      }
      let currentContent: string;
      try {
        currentContent = UTF8_DECODER.decode(currentBytes);
      } catch {
        throw new Error("Text previews must contain valid UTF-8.");
      }
      if (currentContent !== input.expectedContent) {
        throw new Error("This file changed since it was opened.");
      }

      const latestPathStats = await fs.lstat(canonicalPath);
      if (
        latestPathStats.isSymbolicLink()
        || openedStats.dev !== latestPathStats.dev
        || openedStats.ino !== latestPathStats.ino
      ) {
        throw new Error("This file changed since it was opened.");
      }
      await handle.write(contentBytes, 0, contentBytes.byteLength, 0);
      await handle.truncate(contentBytes.byteLength);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await previewLocalFile(canonicalPath);
  } finally {
    releaseQueue();
    if (LOCAL_FILE_UPDATE_QUEUES.get(canonicalPath) === tail) {
      LOCAL_FILE_UPDATE_QUEUES.delete(canonicalPath);
    }
  }
}
