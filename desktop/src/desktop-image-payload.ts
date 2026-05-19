import path from "node:path";

export type DesktopImageDataPayload = {
  filename?: string | null;
  contentType: string;
  base64: string;
};

export function parseDesktopImageDataPayload(payload: unknown): DesktopImageDataPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid image payload.");
  }

  const record = payload as Partial<DesktopImageDataPayload>;
  if (typeof record.contentType !== "string" || !record.contentType.toLowerCase().startsWith("image/")) {
    throw new Error("Invalid image content type.");
  }
  if (typeof record.base64 !== "string" || record.base64.length === 0) {
    throw new Error("Invalid image data.");
  }
  if (record.filename !== undefined && record.filename !== null && typeof record.filename !== "string") {
    throw new Error("Invalid image filename.");
  }

  return {
    filename: record.filename ?? null,
    contentType: record.contentType,
    base64: record.base64,
  };
}

function imageExtensionForContentType(contentType: string): string {
  switch (contentType.toLowerCase().split(";")[0]) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/png":
    default:
      return ".png";
  }
}

export function sanitizeDesktopImageFilename(filename: string | null | undefined, contentType: string): string {
  const trimmed = filename?.trim() || "chat-image";
  const basename = path.basename(trimmed).replace(/[^\w .()[\]-]+/g, "-").replace(/\s+/g, " ").trim() || "chat-image";
  const extension = path.extname(basename) || imageExtensionForContentType(contentType);
  const name = path.basename(basename, path.extname(basename)).slice(0, 80) || "chat-image";
  return `${name}${extension}`;
}

export function imageBufferFromPayload(payload: DesktopImageDataPayload): Buffer {
  const buffer = Buffer.from(payload.base64, "base64");
  if (buffer.length === 0) {
    throw new Error("Invalid image data.");
  }
  return buffer;
}

