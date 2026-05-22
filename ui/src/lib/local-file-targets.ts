const LOCAL_POSIX_FILE_ROOTS = [
  "/Users/",
  "/home/",
  "/Volumes/",
  "/tmp/",
  "/var/",
  "/opt/",
  "/mnt/",
  "/private/",
];

function decodeFileUrlPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return null;
  }
}

export function resolveLocalFileTarget(href: string | null | undefined): string | null {
  const value = href?.trim();
  if (!value) return null;

  const fileUrlPath = /^file:/i.test(value) ? decodeFileUrlPath(value) : null;
  if (fileUrlPath) return fileUrlPath;

  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  if (/^\\\\[^\\]+\\[^\\]+/.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.startsWith("//")) return null;
  if (LOCAL_POSIX_FILE_ROOTS.some((root) => value.startsWith(root))) return value;
  return null;
}
