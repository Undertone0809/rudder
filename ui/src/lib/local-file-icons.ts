import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { buildLucideIconMask } from "./mention-chips";

export type LocalFileIconKind =
  | "archive"
  | "code"
  | "document"
  | "file"
  | "image"
  | "spreadsheet";

export function localFileIconKind(filePath: string): LocalFileIconKind {
  const extension = filePath.split(/[\\/]/u).at(-1)?.toLowerCase().match(/\.([^.]+)$/u)?.[1] ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(extension)) return "image";
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(extension)) return "archive";
  if (["csv", "tsv", "xls", "xlsx", "ods"].includes(extension)) return "spreadsheet";
  if ([
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "kts",
    "c", "cc", "cpp", "h", "hpp", "cs", "swift", "php", "sh", "bash", "zsh", "fish", "html",
    "css", "scss", "less", "json", "jsonc", "yaml", "yml", "toml", "xml", "sql", "vue", "svelte",
  ].includes(extension)) return "code";
  if (["md", "mdx", "txt", "pdf", "doc", "docx", "rtf"].includes(extension)) return "document";
  return "file";
}

const LOCAL_FILE_ICONS: Record<LocalFileIconKind, LucideIcon> = {
  archive: FileArchive,
  code: FileCode2,
  document: FileText,
  file: File,
  image: FileImage,
  spreadsheet: FileSpreadsheet,
};

export function localFileIconDescriptor(filePath: string) {
  const kind = localFileIconKind(filePath);
  const Icon = LOCAL_FILE_ICONS[kind];
  return {
    Icon,
    kind,
    mask: buildLucideIconMask(Icon, `local-file:${kind}`),
  };
}
