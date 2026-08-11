import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveComputerUsePackageTarget } from "./computer-use-package-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePackagedAppRoot() {
  const arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  const candidates = process.platform === "darwin"
    ? [
        path.join(desktopRoot, "release", `mac-${arch}`, "Rudder.app", "Contents", "Resources", "app"),
        path.join(desktopRoot, "release", "mac", "Rudder.app", "Contents", "Resources", "app"),
      ]
    : process.platform === "win32"
      ? [
          path.join(desktopRoot, "release", arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked", "resources", "app"),
          path.join(desktopRoot, "release", "win-unpacked", "resources", "app"),
        ]
      : [
          path.join(desktopRoot, "release", arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked", "resources", "app"),
          path.join(desktopRoot, "release", "linux-unpacked", "resources", "app"),
        ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Packaged Rudder app was not found: ${candidates.join(", ")}`);
}

async function main() {
  const arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  const target = resolveComputerUsePackageTarget(process.platform, arch);
  if (!target) {
    console.log(`Computer Use package verification skipped on ${process.platform}.`);
    return;
  }
  const appRoot = await resolvePackagedAppRoot();
  const nodeModules = path.join(appRoot, "node_modules");
  const driverEntry = path.join(nodeModules, "@trycua", "cua-driver", "dist", "index.js");
  const sharedRoot = path.join(nodeModules, "@rudderhq", "shared");
  const sharedComputerUseEntry = path.join(sharedRoot, "dist", "computer-use.js");
  const zodRoot = path.join(nodeModules, "zod");
  const nativeRoot = path.join(nodeModules, ...target.driverPackage.split("/"));
  const ubjsNativeRoot = path.join(nodeModules, ...target.ubjsPackage.split("/"));
  const requiredFiles = [
    driverEntry,
    sharedComputerUseEntry,
    path.join(zodRoot, "package.json"),
    path.join(nodeModules, "@ubjs", "core", "package.json"),
    path.join(nodeModules, "@ubjs", "node", "package.json"),
    path.join(ubjsNativeRoot, "package.json"),
    path.join(ubjsNativeRoot, target.ubjsFile),
    ...target.driverFiles.map((fileName) => path.join(nativeRoot, fileName)),
  ];
  for (const requiredFile of requiredFiles) await fs.access(requiredFile);
  if (arch === process.arch) {
    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-computer-package-"));
    try {
      const isolatedApp = path.join(isolatedRoot, "app");
      await fs.mkdir(path.join(isolatedApp, "dist"), { recursive: true });
      for (const fileName of ["computer-driver.js", "computer-runtime.js"]) {
        await fs.copyFile(path.join(appRoot, "dist", fileName), path.join(isolatedApp, "dist", fileName));
      }
      const packages = [
        [path.join(nodeModules, "@rudderhq", "shared"), path.join(isolatedApp, "node_modules", "@rudderhq", "shared")],
        [path.join(nodeModules, "zod"), path.join(isolatedApp, "node_modules", "zod")],
        [path.join(nodeModules, "@trycua", "cua-driver"), path.join(isolatedApp, "node_modules", "@trycua", "cua-driver")],
        [nativeRoot, path.join(isolatedApp, "node_modules", ...target.driverPackage.split("/"))],
        [path.join(nodeModules, "@ubjs", "core"), path.join(isolatedApp, "node_modules", "@ubjs", "core")],
        [path.join(nodeModules, "@ubjs", "node"), path.join(isolatedApp, "node_modules", "@ubjs", "node")],
        [ubjsNativeRoot, path.join(isolatedApp, "node_modules", ...target.ubjsPackage.split("/"))],
      ];
      for (const [source, destination] of packages) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(source, destination, { recursive: true });
      }
      await import(pathToFileURL(path.join(isolatedApp, "dist", "computer-runtime.js")).href);
      await import(pathToFileURL(path.join(isolatedApp, "node_modules", "@trycua", "cua-driver", "dist", "index.js")).href);
    } finally {
      await fs.rm(isolatedRoot, { recursive: true, force: true });
    }
  }
  console.log(`Verified packaged Computer Use runtime (${process.platform}/${arch}).`);
}

void main().catch((error) => {
  console.error("[desktop:verify-computer-use-package] failed", error);
  process.exit(1);
});
