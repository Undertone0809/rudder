import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES = 100 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ts: "text/typescript",
  tsx: "text/typescript",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  yaml: "text/yaml",
  yml: "text/yaml",
};

const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cfg", "conf", "cpp", "css", "env", "go", "h", "hpp", "html", "ini",
  "java", "js", "jsx", "log", "mjs", "py", "rs", "sh", "sql", "toml", "ts", "tsx",
  "xml",
]);

function expectedFileName(targetPath: string) {
  const pathWithoutQuery = targetPath.split(/[?#]/u, 1)[0] ?? targetPath;
  const pathName = pathWithoutQuery.replaceAll("\\", "/").split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(pathName);
  } catch {
    return pathName;
  }
}

function previewKindFor(file: File, extension: string): OrganizationWorkspaceFileDetail["previewKind"] {
  const contentType = file.type && file.type !== "application/octet-stream"
    ? file.type.toLowerCase()
    : MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf" || extension === "pdf") return "pdf";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (
    contentType.startsWith("text/")
    || contentType === "application/json"
    || contentType.endsWith("+json")
    || contentType.endsWith("+xml")
    || TEXT_EXTENSIONS.has(extension)
  ) return "text";
  return "binary";
}

export async function createBrowserLocalFilePreview(
  file: File,
  targetPath: string,
): Promise<OrganizationWorkspaceFileDetail> {
  const expectedName = expectedFileName(targetPath);
  if (!expectedName || file.name !== expectedName) {
    throw new Error(`Select the local file named ${expectedName || "in the transcript"}.`);
  }

  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const previewKind = previewKindFor(file, extension);
  const sizeLimit = previewKind === "text" ? MAX_TEXT_PREVIEW_BYTES : MAX_MEDIA_PREVIEW_BYTES;
  if (file.size > sizeLimit) {
    throw new Error(previewKind === "text"
      ? "This text file exceeds the 2 MiB browser preview limit."
      : "This file exceeds the 100 MiB browser preview limit.");
  }

  const contentType = file.type && file.type !== "application/octet-stream"
    ? file.type
    : MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  const content = previewKind === "text" ? await file.text() : null;
  const contentPath = previewKind === "image"
    || previewKind === "pdf"
    || previewKind === "video"
    || previewKind === "audio"
    ? URL.createObjectURL(file)
    : null;

  return {
    source: "org_root",
    rootPath: "browser-local",
    repoUrl: null,
    filePath: file.name,
    libraryEntryId: null,
    mentionHref: null,
    markdownLink: null,
    rootExists: true,
    content,
    contentType,
    previewKind,
    contentPath,
    message: previewKind === "binary" ? "No inline preview is available for this file type." : null,
    truncated: false,
  };
}
