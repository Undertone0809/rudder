const WORKSPACE_IMAGE_FILE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const WORKSPACE_CSV_FILE_EXTENSIONS = new Set([".csv"]);
const WORKSPACE_MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mdx"]);
const WORKSPACE_TEXT_DOCUMENT_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mdx", ".txt", ".text"]);
const WORKSPACE_VIDEO_FILE_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".ogv", ".avi", ".mkv"]);
const WORKSPACE_AUDIO_FILE_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"]);
const EMBEDDED_IMAGE_DATA_URL_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+_-]+(?:=[a-z0-9.+_-]+)?)*,/i;

export const EMBEDDED_IMAGE_DATA_URL_ERROR =
  "Embedded image data URLs are not allowed in Library files. Upload the image and reference the asset URL instead.";

export function containsEmbeddedImageDataUrl(content: string) {
  return EMBEDDED_IMAGE_DATA_URL_RE.test(content);
}

export function workspaceImageAssetNamespace(filePath: string | null) {
  const withoutExtension = (filePath ?? "untitled")
    .replace(/\.[^/.]+$/, "")
    .split("/")
    .map((segment) => {
      const cleaned = segment
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/_{2,}/g, "_")
        .replace(/^_+|_+$/g, "");
      return (cleaned || "file").slice(0, 40);
    })
    .join("/");
  return `library/${withoutExtension}`.slice(0, 120).replace(/\/+$/g, "") || "library";
}

export function getWorkspaceFileExtension(filePath: string | null) {
  if (!filePath) return null;
  const basename = filePath.split("/").at(-1) ?? filePath;
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex === -1 ? null : basename.slice(extensionIndex).toLowerCase();
}

export function isWorkspaceImageFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_IMAGE_FILE_EXTENSIONS.has(extension);
}

export function isWorkspaceMarkdownFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_MARKDOWN_FILE_EXTENSIONS.has(extension);
}

export function isWorkspaceCsvFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_CSV_FILE_EXTENSIONS.has(extension);
}

export function isWorkspaceCsvContentType(contentType: string | null | undefined) {
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "text/csv";
}

export function isWorkspaceTextDocumentFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_TEXT_DOCUMENT_FILE_EXTENSIONS.has(extension);
}

export function isWorkspaceVideoFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_VIDEO_FILE_EXTENSIONS.has(extension);
}

export function isWorkspaceAudioFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_AUDIO_FILE_EXTENSIONS.has(extension);
}

export function displayWorkspaceDocumentKind(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  if (!extension) return "Document";
  switch (extension) {
    case ".md":
    case ".markdown":
    case ".mdown":
      return "Markdown";
    case ".mdx":
      return "MDX";
    case ".json":
      return "JSON";
    case ".jsonl":
      return "JSONL";
    case ".csv":
      return "CSV";
    case ".html":
      return "HTML";
    case ".txt":
    case ".text":
      return "Text";
    default:
      return extension.slice(1).toUpperCase();
  }
}

export function countWorkspaceDocumentWords(content: string) {
  const matches = content.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu);
  return matches?.length ?? 0;
}

export function formatWorkspaceWordCount(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "word" : "words"}`;
}

export function splitYamlFrontmatter(content: string) {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/);
  if (!match) {
    return {
      frontmatter: null,
      frontmatterSeparator: "",
      body: content,
    };
  }

  return {
    frontmatter: match[1] ?? "",
    frontmatterSeparator: match[2] ?? "\n",
    body: content.slice(match[0].length),
  };
}

export function joinYamlFrontmatter(
  frontmatter: string | null,
  frontmatterSeparator: string,
  body: string,
) {
  return frontmatter === null ? body : `${frontmatter}${frontmatterSeparator || "\n"}${body}`;
}
