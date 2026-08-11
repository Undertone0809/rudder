const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);

const PLATFORM_TARGETS = {
  darwin: {
    packagePlatform: "darwin",
    nativeSuffix: (arch) => `darwin-${arch}`,
    driverFiles: ["libcua_driver_sdk.dylib", "cua_driver_node_runtime.node"],
  },
  linux: {
    packagePlatform: "linux",
    nativeSuffix: (arch) => `linux-${arch}-gnu`,
    driverFiles: ["libcua_driver_sdk.so", "cua_driver_node_runtime.node"],
  },
  win32: {
    packagePlatform: "win32",
    nativeSuffix: (arch) => `win32-${arch}-msvc`,
    driverFiles: ["cua_driver_sdk.dll", "cua_driver_node_runtime.node"],
  },
};

export function resolveComputerUsePackageTarget(platform, arch) {
  const descriptor = PLATFORM_TARGETS[platform];
  if (!descriptor) return null;
  if (!SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`Unsupported ${platform} Computer Use architecture: ${arch}.`);
  }
  const nativeSuffix = descriptor.nativeSuffix(arch);
  return {
    platform,
    arch,
    nativeSuffix,
    driverPackage: `@trycua/cua-driver-${nativeSuffix}`,
    driverFiles: descriptor.driverFiles,
    ubjsPackage: `@ubjs/node-${nativeSuffix}`,
    ubjsFile: `uniffi-runtime-napi.${nativeSuffix}.node`,
  };
}
