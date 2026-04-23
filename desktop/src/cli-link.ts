import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DESKTOP_CLI_FLAG = "--desktop-cli";

const MANAGED_MARKER = "rudder-desktop-cli-managed";
const EXCLUDED_WRAPPER_DIR_MARKERS = [".acontext"];

export type DesktopCliInstallStatus =
  | "installed"
  | "already_installed"
  | "skipped_existing_file"
  | "unavailable";

export type DesktopCliInstallResult = {
  status: DesktopCliInstallStatus;
  targetPath?: string;
  detail: string;
  needsPathUpdate: boolean;
};

function normalizePathEntry(value: string): string {
  return path.normalize(value.trim());
}

function isExcludedDirectory(dirPath: string): boolean {
  const normalized = path.normalize(dirPath).toLowerCase();
  return EXCLUDED_WRAPPER_DIR_MARKERS.some((marker) => {
    return normalized === marker || normalized.includes(`${path.sep}${marker}${path.sep}`) || normalized.endsWith(`${path.sep}${marker}`);
  });
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isWritableDirectory(dirPath: string): Promise<boolean> {
  try {
    await fs.access(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function canCreateDirectory(dirPath: string, homeDir: string): Promise<boolean> {
  const parent = path.dirname(dirPath);
  if (!parent.startsWith(homeDir)) return false;
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function resolvePathEntries(pathValue: string | undefined): string[] {
  const seen = new Set<string>();
  const entries = (pathValue ?? "")
    .split(path.delimiter)
    .map(normalizePathEntry)
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      const key = process.platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return entries;
}

function preferredFallbackDirs(homeDir: string): string[] {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return [
      ...(localAppData ? [path.join(localAppData, "Microsoft", "WindowsApps")] : []),
      path.join(homeDir, "bin"),
    ];
  }

  if (process.platform === "darwin") {
    return [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(homeDir, ".local", "bin"),
      path.join(homeDir, "bin"),
    ];
  }

  return [
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, "bin"),
    "/usr/local/bin",
  ];
}

function scoreDirectory(dirPath: string, pathEntries: Set<string>, homeDir: string): number {
  let score = 0;
  if (pathEntries.has(dirPath)) score += 100;
  if (dirPath.startsWith(homeDir)) score += 50;
  if (process.platform === "darwin" && dirPath === "/opt/homebrew/bin") score += 40;
  if (dirPath === "/usr/local/bin") score += 30;
  if (dirPath.endsWith(`${path.sep}.local${path.sep}bin`) || dirPath.endsWith(`${path.sep}bin`)) score += 20;
  return score;
}

export async function resolveDesktopCliExecutablePath(
  execPathValue: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === "linux" && isNonEmptyString(process.env.APPIMAGE)) {
    return path.resolve(process.env.APPIMAGE);
  }
  return path.resolve(execPathValue);
}

function buildUnixWrapper(executablePath: string): string {
  const escaped = executablePath.replaceAll(`'`, `'\"'\"'`);
  return `#!/bin/sh
# ${MANAGED_MARKER}
exec '${escaped}' ${DESKTOP_CLI_FLAG} "$@"
`;
}

function buildWindowsWrapper(executablePath: string): string {
  const escaped = executablePath.replaceAll(`"`, `""`);
  return `@echo off\r
rem ${MANAGED_MARKER}\r
"${escaped}" ${DESKTOP_CLI_FLAG} %*\r
`;
}

export function buildDesktopCliWrapper(executablePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? buildWindowsWrapper(executablePath)
    : buildUnixWrapper(executablePath);
}

export function shouldInstallDesktopCliLink(isPackaged: boolean): boolean {
  return isPackaged;
}

function wrapperFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "rudder.cmd" : "rudder";
}

export function resolveDesktopCliArgv(argv: string[] = process.argv): string[] | null {
  const flagIndex = argv.indexOf(DESKTOP_CLI_FLAG);
  if (flagIndex === -1) return null;
  return [process.execPath, "rudder", ...argv.slice(flagIndex + 1)];
}

async function chooseInstallDirectory(
  pathValue: string | undefined,
  homeDir: string,
): Promise<{ dirPath: string; needsPathUpdate: boolean } | null> {
  const pathEntries = resolvePathEntries(pathValue);
  const pathEntrySet = new Set(pathEntries);
  const candidates = [...pathEntries, ...preferredFallbackDirs(homeDir)]
    .map(normalizePathEntry)
    .filter((dirPath) => !isExcludedDirectory(dirPath))
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .sort((left, right) => scoreDirectory(right, pathEntrySet, homeDir) - scoreDirectory(left, pathEntrySet, homeDir));

  for (const dirPath of candidates) {
    const exists = await pathExists(dirPath);
    const writable = exists
      ? await isWritableDirectory(dirPath)
      : await canCreateDirectory(dirPath, homeDir);
    if (!writable) continue;
    return {
      dirPath,
      needsPathUpdate: !pathEntrySet.has(dirPath),
    };
  }

  return null;
}

export async function ensureDesktopCliLink(options: {
  executablePath?: string;
  pathValue?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
} = {}): Promise<DesktopCliInstallResult> {
  const platform = options.platform ?? process.platform;
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const executablePath = path.resolve(options.executablePath ?? await resolveDesktopCliExecutablePath(process.execPath, platform));
  const installDir = await chooseInstallDirectory(options.pathValue ?? process.env.PATH, homeDir);

  if (!installDir) {
    return {
      status: "unavailable",
      detail: "No writable CLI install directory was available.",
      needsPathUpdate: true,
    };
  }

  const targetPath = path.join(installDir.dirPath, wrapperFileName(platform));
  const content = buildDesktopCliWrapper(executablePath, platform);
  const existing = await pathExists(targetPath);

  if (existing) {
    const currentContent = await fs.readFile(targetPath, "utf8");
    if (currentContent === content) {
      return {
        status: "already_installed",
        targetPath,
        detail: "Desktop CLI wrapper is already installed.",
        needsPathUpdate: installDir.needsPathUpdate,
      };
    }
    if (!currentContent.includes(MANAGED_MARKER)) {
      return {
        status: "skipped_existing_file",
        targetPath,
        detail: "Existing rudder command is not managed by Rudder Desktop.",
        needsPathUpdate: installDir.needsPathUpdate,
      };
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  if (platform !== "win32") {
    await fs.chmod(targetPath, 0o755);
  }

  return {
    status: existing ? "installed" : "installed",
    targetPath,
    detail: "Installed Desktop CLI wrapper.",
    needsPathUpdate: installDir.needsPathUpdate,
  };
}
