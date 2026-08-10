import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const stagedAppDir = path.join(desktopRoot, ".packaged", "app");
const sourceDistDir = path.join(desktopRoot, "dist");
const sourceReleasesDir = path.join(desktopRoot, "..", "releases");
const packageJsonPath = path.join(desktopRoot, "package.json");
const requireFromDesktop = createRequire(packageJsonPath);

async function readDesktopPackageJson() {
  return JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
}

async function findPackageRoot(entryPath, expectedName) {
  let current = path.dirname(await fs.realpath(entryPath));
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8"));
      if (manifest.name === expectedName) return current;
    } catch {
      // Continue toward the filesystem root.
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not locate installed package root for ${expectedName}.`);
}

async function copyPackageRoot(packageName, sourceRoot) {
  const destinationRoot = path.join(stagedAppDir, "node_modules", ...packageName.split("/"));
  await fs.mkdir(path.dirname(destinationRoot), { recursive: true });
  await fs.cp(sourceRoot, destinationRoot, { recursive: true, dereference: true });
  return { sourceRoot, destinationRoot };
}

async function copyInstalledPackage(packageName, resolveFrom = requireFromDesktop) {
  let sourceEntry;
  try {
    sourceEntry = resolveFrom.resolve(packageName);
  } catch {
    sourceEntry = resolveFrom.resolve(`${packageName}/package.json`);
  }
  const sourceRoot = await findPackageRoot(sourceEntry, packageName);
  return copyPackageRoot(packageName, sourceRoot);
}

async function stageComputerUseRuntime(desktopPackage) {
  if (process.platform !== "darwin") return {};
  const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Unsupported macOS Computer Use architecture: ${targetArch}.`);
  }

  const driverSourceRoot = await fs.realpath(path.join(desktopRoot, "node_modules", "@trycua", "cua-driver"));
  const driver = await copyPackageRoot("@trycua/cua-driver", driverSourceRoot);
  const requireFromDriver = createRequire(path.join(driver.sourceRoot, "package.json"));
  await copyInstalledPackage("@ubjs/core", requireFromDriver);
  await copyInstalledPackage("@ubjs/node", requireFromDriver);
  const nativePackage = `@trycua/cua-driver-darwin-${targetArch}`;
  const native = await copyInstalledPackage(nativePackage, requireFromDriver);

  const requiredNativeFiles = ["libcua_driver_sdk.dylib", "cua_driver_node_runtime.node"];
  for (const fileName of requiredNativeFiles) {
    await fs.access(path.join(native.destinationRoot, fileName));
  }

  const shared = await copyInstalledPackage("@rudderhq/shared");
  const sharedManifest = JSON.parse(await fs.readFile(path.join(shared.sourceRoot, "package.json"), "utf8"));
  const requireFromShared = createRequire(path.join(shared.sourceRoot, "package.json"));
  await copyInstalledPackage("zod", requireFromShared);

  return {
    "@rudderhq/shared": sharedManifest.version,
    "@trycua/cua-driver": desktopPackage.dependencies?.["@trycua/cua-driver"],
    zod: sharedManifest.dependencies?.zod,
  };
}

async function main() {
  const desktopPackage = await readDesktopPackageJson();

  await fs.rm(stagedAppDir, { recursive: true, force: true });
  await fs.mkdir(stagedAppDir, { recursive: true });
  await fs.cp(sourceDistDir, path.join(stagedAppDir, "dist"), { recursive: true });
  await fs.cp(sourceReleasesDir, path.join(stagedAppDir, "releases"), { recursive: true });
  const computerUseDependencies = await stageComputerUseRuntime(desktopPackage);

  const appManifest = {
    name: "@rudderhq/desktop",
    version: desktopPackage.version ?? "0.0.0",
    private: true,
    description: "Rudder Desktop local-first Electron shell",
    author: "Rudder",
    type: "module",
    main: "dist/main.js",
    ...(Object.keys(computerUseDependencies).length > 0
      ? { dependencies: computerUseDependencies }
      : {}),
  };

  await fs.writeFile(
    path.join(stagedAppDir, "package.json"),
    `${JSON.stringify(appManifest, null, 2)}\n`,
    "utf8",
  );
}

void main().catch((error) => {
  console.error("[desktop:stage-app] failed to stage packaged desktop app", error);
  process.exit(1);
});
