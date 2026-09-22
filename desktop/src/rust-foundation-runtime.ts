import { resolveRudderNativeTarget } from "@rudderhq/shared";
import path from "node:path";

export type DesktopRustFoundationRuntimeOverrides = {
  rustFoundationMode?: "required";
  rustFoundationBinaryPath?: string;
};

export function resolveDesktopPackagedRustFoundationBinaryPath(options: {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): string | null {
  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath) return null;

  const platform = options.platform ?? process.platform;
  const target = resolveRudderNativeTarget(platform, options.arch ?? process.arch);
  if (!target) return null;

  const binaryName = platform === "win32"
    ? "rudder-server-foundation.exe"
    : "rudder-server-foundation";
  return path.join(resourcesPath, "native", target, binaryName);
}

export function resolveDesktopRustFoundationRuntimeOverrides(options: {
  isPackaged: boolean;
  memberDirectoryMode?: string;
  configuredBinaryPath?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): DesktopRustFoundationRuntimeOverrides {
  if (!options.isPackaged) return {};

  const configuredMode = options.memberDirectoryMode?.trim();
  const configuredBinaryPath = options.configuredBinaryPath?.trim();
  const packagedBinaryPath = configuredBinaryPath
    ? null
    : resolveDesktopPackagedRustFoundationBinaryPath(options);

  return {
    ...(configuredMode ? {} : { rustFoundationMode: "required" }),
    ...(packagedBinaryPath ? { rustFoundationBinaryPath: packagedBinaryPath } : {}),
  };
}
