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

type BrowserDirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: "read" }) => Promise<FileSystemDirectoryHandle>;
};

export type BrowserLocalDirectoryRead = {
  file: File;
  rootName: string;
  relativePath: string;
};

function targetPathSegments(targetPath: string): string[] {
  let path = targetPath.trim();
  if (/^file:/iu.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      throw new Error("The recorded local file path is not valid.");
    }
  }

  const withoutQuery = path.split(/[?#]/u, 1)[0] ?? path;
  const segments = withoutQuery.replaceAll("\\", "/").split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("The recorded local file path cannot be resolved safely.");
  }
  return segments;
}

export function browserLocalTargetRelativePath(targetPath: string, grantedRootName: string): string {
  const segments = targetPathSegments(targetPath);
  const matchingRootIndexes = segments.flatMap((segment, index) => segment === grantedRootName ? [index] : []);
  if (matchingRootIndexes.length !== 1) {
    throw new Error(
      matchingRootIndexes.length === 0
        ? "Choose a folder whose name appears in the recorded file path."
        : "Choose a folder with a name that appears only once in the recorded file path.",
    );
  }

  const relativeSegments = segments.slice(matchingRootIndexes[0]! + 1);
  if (!relativeSegments.length) {
    throw new Error("The selected folder is the file target, not its containing folder.");
  }
  return relativeSegments.join("/");
}

export function getBrowserLocalDirectoryPicker() {
  if (typeof window === "undefined") return undefined;
  const pickerWindow = window as BrowserDirectoryPickerWindow;
  return pickerWindow.showDirectoryPicker?.bind(pickerWindow);
}

export function browserLocalDirectoryPickerError(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "Folder access was cancelled. No files were read.";
  }
  if (cause instanceof DOMException && cause.name === "NotAllowedError") {
    return "Folder access was denied. No files were read.";
  }
  return cause instanceof Error ? cause.message : "Could not access the selected folder.";
}

export async function readBrowserLocalFileFromDirectory(
  directory: FileSystemDirectoryHandle,
  targetPath: string,
): Promise<BrowserLocalDirectoryRead> {
  const relativePath = browserLocalTargetRelativePath(targetPath, directory.name);
  const segments = relativePath.split("/");
  let currentDirectory = directory;
  try {
    for (const segment of segments.slice(0, -1)) {
      currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: false });
    }
    const fileHandle = await currentDirectory.getFileHandle(segments.at(-1)!, { create: false });
    return {
      file: await fileHandle.getFile(),
      rootName: directory.name,
      relativePath,
    };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotFoundError") {
      throw new Error(`The selected folder does not contain the recorded file at ${relativePath}.`);
    }
    throw cause;
  }
}

export function readBrowserLocalFileFromDirectorySelection(
  files: Iterable<File>,
  targetPath: string,
): BrowserLocalDirectoryRead {
  const selectedFiles = Array.from(files);
  const relativePaths = selectedFiles.map((file) => (
    typeof file.webkitRelativePath === "string"
      ? file.webkitRelativePath.replaceAll("\\", "/")
      : ""
  ));
  const selectedRoots = new Set(
    relativePaths.map((relativePath) => relativePath.split("/")[0]).filter(Boolean),
  );
  if (selectedRoots.size !== 1) {
    throw new Error("Choose one folder containing the recorded file.");
  }
  const rootName = selectedRoots.values().next().value as string;
  const relativePath = browserLocalTargetRelativePath(targetPath, rootName);
  const matches = selectedFiles.filter((file, index) => {
    const segments = relativePaths[index]!.split("/");
    return segments[0] === rootName && segments.slice(1).join("/") === relativePath;
  });
  if (matches.length !== 1) {
    throw new Error(`The selected folder does not contain the recorded file at ${relativePath}.`);
  }
  return { file: matches[0]!, rootName, relativePath };
}

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
