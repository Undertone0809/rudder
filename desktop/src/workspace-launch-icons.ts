import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DesktopWorkspaceLaunchTarget } from "./ide-opener.js";

type WorkspaceLaunchNativeImage = {
  isEmpty(): boolean;
  resize(size: { width: number; height: number }): WorkspaceLaunchNativeImage;
  toDataURL(): string;
};

type WorkspaceLaunchIconFileOptions = {
  size: "small" | "normal" | "large";
};

type WorkspaceLaunchIconDependencies = {
  platform?: NodeJS.Platform;
  getFileIcon(targetPath: string, options: WorkspaceLaunchIconFileOptions): Promise<WorkspaceLaunchNativeImage>;
  createImageFromPath(targetPath: string): WorkspaceLaunchNativeImage;
  resolveBundleIconPath?: (appPath: string) => Promise<string | null>;
};

type DarwinBundleIconOptions = {
  platform?: NodeJS.Platform;
  pathExists?: (targetPath: string) => boolean;
  readPlistRawValue?: (plistPath: string, key: string) => Promise<string | null>;
};

const WORKSPACE_LAUNCH_ICON_SIZE = 32;

function execFileText(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function readPlistRawValue(plistPath: string, key: string): Promise<string | null> {
  try {
    const value = await execFileText("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function iconDataUrl(image: WorkspaceLaunchNativeImage): string | undefined {
  if (image.isEmpty()) return undefined;
  return image.resize({ width: WORKSPACE_LAUNCH_ICON_SIZE, height: WORKSPACE_LAUNCH_ICON_SIZE }).toDataURL();
}

function readImagePathDataUrl(
  targetPath: string,
  deps: Pick<WorkspaceLaunchIconDependencies, "createImageFromPath">,
): string | undefined {
  try {
    const image = deps.createImageFromPath(targetPath);
    return iconDataUrl(image);
  } catch {
    return undefined;
  }
}

async function readNativeFileIconDataUrl(
  targetPath: string,
  deps: Pick<WorkspaceLaunchIconDependencies, "getFileIcon">,
): Promise<string | undefined> {
  try {
    const fileIcon = await deps.getFileIcon(targetPath, { size: "large" });
    return iconDataUrl(fileIcon);
  } catch {
    return undefined;
  }
}

export async function resolveDarwinAppBundleIconPath(
  appPath: string,
  options: DarwinBundleIconOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || !appPath.endsWith(".app")) return null;

  const pathExists = options.pathExists ?? fs.existsSync;
  const readInfoPlistValue = options.readPlistRawValue ?? readPlistRawValue;
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const iconName = await readInfoPlistValue(infoPlistPath, "CFBundleIconFile")
    ?? await readInfoPlistValue(infoPlistPath, "CFBundleIconName");
  if (!iconName) return null;

  const candidates = path.extname(iconName)
    ? [iconName]
    : [iconName, `${iconName}.icns`, `${iconName}.png`];
  for (const candidate of candidates) {
    const iconPath = path.join(resourcesPath, candidate);
    if (pathExists(iconPath)) return iconPath;
  }
  return null;
}

export async function readWorkspaceLaunchTargetIconDataUrl(
  target: DesktopWorkspaceLaunchTarget,
  deps: WorkspaceLaunchIconDependencies,
): Promise<string | undefined> {
  if (!target.iconPath) return undefined;
  const platform = deps.platform ?? process.platform;

  if (platform === "darwin" && target.iconPath.endsWith(".app")) {
    const bundleIconPath = deps.resolveBundleIconPath
      ? await deps.resolveBundleIconPath(target.iconPath)
      : await resolveDarwinAppBundleIconPath(target.iconPath, { platform });
    if (!bundleIconPath) return undefined;

    return readImagePathDataUrl(bundleIconPath, deps);
  }

  const nativeIconDataUrl = await readNativeFileIconDataUrl(target.iconPath, deps);
  if (nativeIconDataUrl) return nativeIconDataUrl;

  const bundleIconPath = deps.resolveBundleIconPath
    ? await deps.resolveBundleIconPath(target.iconPath)
    : await resolveDarwinAppBundleIconPath(target.iconPath, { platform });
  if (!bundleIconPath) return undefined;

  return readImagePathDataUrl(bundleIconPath, deps);
}
