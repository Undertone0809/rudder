const RUDDER_ROUTE_ROOTS = new Set([
  "agents",
  "automations",
  "dashboard",
  "goals",
  "inbox",
  "issues",
  "library",
  "messenger",
  "organization",
  "projects",
  "settings",
  "skills",
]);

const POSIX_FILESYSTEM_ROOTS = new Set([
  "Applications",
  "Users",
  "data",
  "home",
  "media",
  "mnt",
  "opt",
  "private",
  "root",
  "srv",
  "tmp",
  "var",
  "Volumes",
  "workspace",
  "workspaces",
]);

function decodeFileUrlPath(href: string): string | null {
  try {
    const authority = /^file:\/\/([^/]*)/iu.exec(href)?.[1] ?? "";
    if (authority) return null;
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    if (url.host) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return null;
  }
}

function isRudderRoutePath(value: string) {
  const segments = value.slice(1).split(/[/?#]/u);
  return segments.slice(0, 2).some((segment) => RUDDER_ROUTE_ROOTS.has(segment));
}

function isRecognizablePosixFilePath(value: string) {
  const root = value.slice(1).split("/", 1)[0];
  return POSIX_FILESYSTEM_ROOTS.has(root);
}

function decodeLocalPath(filePath: string) {
  try {
    return decodeURIComponent(filePath);
  } catch {
    return filePath;
  }
}

function stripSourceLocation(filePath: string) {
  const match = /^(.*?):\d+(?::\d+)?$/u.exec(filePath);
  return match?.[1] ?? filePath;
}

export function resolveLocalFileTarget(
  href: string | null | undefined,
  _label?: string,
): string | null {
  const value = href?.trim();
  if (!value) return null;

  const fileUrlPath = /^file:/i.test(value) ? decodeFileUrlPath(value) : null;
  if (fileUrlPath) return fileUrlPath;

  const decodedValue = decodeLocalPath(value);
  if (/^[A-Za-z]:[\\/]/.test(decodedValue)) return decodedValue;
  if (/^\\\\[^\\]+\\[^\\]+/.test(decodedValue)) return decodedValue;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.startsWith("//")) return null;
  if (
    decodedValue.startsWith("/")
    && !isRudderRoutePath(decodedValue)
    && isRecognizablePosixFilePath(decodedValue)
  ) {
    return decodedValue;
  }
  return null;
}

export function resolveLocalFileDisplayTarget(
  href: string | null | undefined,
  _label?: string,
): string | null {
  const targetPath = resolveLocalFileTarget(href);
  return targetPath ? stripSourceLocation(targetPath) : null;
}
