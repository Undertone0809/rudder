import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  convertIcnsToPngDataUrl?: (targetPath: string) => Promise<string | undefined>;
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

async function convertIcnsToPngDataUrl(targetPath: string): Promise<string | undefined> {
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rudder-launch-icon-"));
    const outputPath = path.join(tmpDir, "icon.png");
    await execFileText("/usr/bin/sips", [
      "-z",
      String(WORKSPACE_LAUNCH_ICON_SIZE),
      String(WORKSPACE_LAUNCH_ICON_SIZE),
      "-s",
      "format",
      "png",
      targetPath,
      "--out",
      outputPath,
    ]);
    const imageBuffer = await fs.promises.readFile(outputPath);
    return `data:image/png;base64,${imageBuffer.toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function readImagePathDataUrl(
  targetPath: string,
  deps: Pick<WorkspaceLaunchIconDependencies, "platform" | "createImageFromPath" | "convertIcnsToPngDataUrl">,
): Promise<string | undefined> {
  if ((deps.platform ?? process.platform) === "darwin" && path.extname(targetPath).toLowerCase() === ".icns") {
    try {
      const convertedIcon = deps.convertIcnsToPngDataUrl
        ? await deps.convertIcnsToPngDataUrl(targetPath)
        : await convertIcnsToPngDataUrl(targetPath);
      if (convertedIcon) return convertedIcon;
    } catch {
      return undefined;
    }
  }

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

    return await readImagePathDataUrl(bundleIconPath, deps);
  }

  const nativeIconDataUrl = await readNativeFileIconDataUrl(target.iconPath, deps);
  if (nativeIconDataUrl) return nativeIconDataUrl;

  const bundleIconPath = deps.resolveBundleIconPath
    ? await deps.resolveBundleIconPath(target.iconPath)
    : await resolveDarwinAppBundleIconPath(target.iconPath, { platform });
  if (!bundleIconPath) return undefined;

  return await readImagePathDataUrl(bundleIconPath, deps);
}
