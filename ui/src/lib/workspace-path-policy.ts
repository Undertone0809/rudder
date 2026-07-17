export function parentDirectories(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return new Set(parents);
}

export function directoryAndParentDirectories(directoryPath: string) {
  const segments = directoryPath.split("/").filter(Boolean);
  const directories: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index + 1).join("/"));
  }
  return new Set(directories);
}

export function normalizeRequestedPath(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
