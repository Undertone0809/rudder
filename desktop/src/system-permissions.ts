import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DesktopSystemPermissionStatus =
  | "authorized"
  | "needs_access"
  | "per_app"
  | "unknown"
  | "unsupported";

export type DesktopSystemPermissions = {
  fullDiskAccess: DesktopSystemPermissionStatus;
  accessibility: DesktopSystemPermissionStatus;
  automation: DesktopSystemPermissionStatus;
};

type AccessFn = (targetPath: string, mode?: number) => void;

const FULL_DISK_ACCESS_PROBE_PATHS = [
  "Library/Messages/chat.db",
  "Library/Mail",
  "Library/Safari/History.db",
  "Library/Calendars",
  "Library/Application Support/AddressBook",
];

function isDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function resolveFullDiskAccessStatus({
  platform = process.platform,
  homeDir = os.homedir(),
  access = fs.accessSync,
}: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  access?: AccessFn;
} = {}): DesktopSystemPermissionStatus {
  if (platform !== "darwin") return "unsupported";

  for (const relativePath of FULL_DISK_ACCESS_PROBE_PATHS) {
    try {
      access(path.join(homeDir, relativePath), fs.constants.R_OK);
      return "authorized";
    } catch (error) {
      if (isDenied(error)) return "needs_access";
      if (isMissing(error)) continue;
    }
  }

  return "unknown";
}

export function resolveAccessibilityStatus({
  platform = process.platform,
  isTrusted,
}: {
  platform?: NodeJS.Platform;
  isTrusted?: () => boolean;
} = {}): DesktopSystemPermissionStatus {
  if (platform !== "darwin") return "unsupported";
  if (!isTrusted) return "unknown";

  try {
    return isTrusted() ? "authorized" : "needs_access";
  } catch {
    return "unknown";
  }
}

export function resolveAutomationStatus({
  platform = process.platform,
}: {
  platform?: NodeJS.Platform;
} = {}): DesktopSystemPermissionStatus {
  if (platform !== "darwin") return "unsupported";
  return "per_app";
}

export function resolveDesktopSystemPermissions({
  platform = process.platform,
  homeDir = os.homedir(),
  access = fs.accessSync,
  isAccessibilityTrusted,
}: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  access?: AccessFn;
  isAccessibilityTrusted?: () => boolean;
} = {}): DesktopSystemPermissions {
  return {
    fullDiskAccess: resolveFullDiskAccessStatus({ platform, homeDir, access }),
    accessibility: resolveAccessibilityStatus({ platform, isTrusted: isAccessibilityTrusted }),
    automation: resolveAutomationStatus({ platform }),
  };
}
