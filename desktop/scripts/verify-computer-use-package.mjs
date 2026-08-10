import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  const candidates = [
    path.join(desktopRoot, "release", `mac-${arch}`, "Rudder.app", "Contents", "Resources", "app"),
    path.join(desktopRoot, "release", "mac", "Rudder.app", "Contents", "Resources", "app"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Packaged Rudder app was not found: ${candidates.join(", ")}`);
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("Computer Use package verification skipped outside macOS.");
    return;
  }
  const arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  const appRoot = await resolvePackagedAppRoot();
  const nodeModules = path.join(appRoot, "node_modules");
  const driverEntry = path.join(nodeModules, "@trycua", "cua-driver", "dist", "index.js");
  const sharedRoot = path.join(nodeModules, "@rudderhq", "shared");
  const sharedComputerUseEntry = path.join(sharedRoot, "dist", "computer-use.js");
  const zodRoot = path.join(nodeModules, "zod");
  const nativeRoot = path.join(nodeModules, "@trycua", `cua-driver-darwin-${arch}`);
  const ubjsNativeRoot = path.join(nodeModules, "@ubjs", `node-darwin-${arch}`);
  const requiredFiles = [
    driverEntry,
    sharedComputerUseEntry,
    path.join(zodRoot, "package.json"),
    path.join(nodeModules, "@ubjs", "core", "package.json"),
    path.join(nodeModules, "@ubjs", "node", "package.json"),
    path.join(ubjsNativeRoot, "package.json"),
    path.join(nativeRoot, "libcua_driver_sdk.dylib"),
    path.join(nativeRoot, "cua_driver_node_runtime.node"),
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
        [nativeRoot, path.join(isolatedApp, "node_modules", "@trycua", `cua-driver-darwin-${arch}`)],
        [path.join(nodeModules, "@ubjs", "core"), path.join(isolatedApp, "node_modules", "@ubjs", "core")],
        [path.join(nodeModules, "@ubjs", "node"), path.join(isolatedApp, "node_modules", "@ubjs", "node")],
        [ubjsNativeRoot, path.join(isolatedApp, "node_modules", "@ubjs", `node-darwin-${arch}`)],
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
  console.log(`Verified packaged Computer Use runtime (${arch}).`);
}

void main().catch((error) => {
  console.error("[desktop:verify-computer-use-package] failed", error);
  process.exit(1);
});
