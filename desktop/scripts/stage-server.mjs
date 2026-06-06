import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const targetDir = path.join(repoRoot, "desktop", ".packaged", "server-package");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const sourceManifestRoots = ["packages", "server", "cli"];

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function snapshotSourcePackageManifests() {
  const snapshots = new Map();

  async function walk(absDir) {
    if (!(await exists(absDir))) return;

    const manifestPath = path.join(absDir, "package.json");
    if (await exists(manifestPath)) {
      snapshots.set(manifestPath, await fs.readFile(manifestPath, "utf8"));
      return;
    }

    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      await walk(path.join(absDir, entry.name));
    }
  }

  for (const relRoot of sourceManifestRoots) {
    await walk(path.join(repoRoot, relRoot));
  }

  return snapshots;
}

async function restoreSourcePackageManifests(snapshots) {
  await Promise.all(
    [...snapshots.entries()].map(([manifestPath, content]) => fs.writeFile(manifestPath, content, "utf8")),
  );
}

async function writeFileBreakingLinks(filePath, content) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

async function rewritePublishedManifest(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest.publishConfig) return;

  const nextManifest = { ...manifest };
  if (manifest.publishConfig.exports) {
    nextManifest.exports = JSON.parse(JSON.stringify(manifest.publishConfig.exports));
    addDefaultExportCondition(nextManifest.exports);
  }
  if (manifest.publishConfig.main) {
    nextManifest.main = manifest.publishConfig.main;
  }
  if (manifest.publishConfig.types) {
    nextManifest.types = manifest.publishConfig.types;
  }

  await writeFileBreakingLinks(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

function addDefaultExportCondition(exportsObj) {
  if (typeof exportsObj !== "object" || exportsObj === null || Array.isArray(exportsObj)) {
    return;
  }
  for (const key of Object.keys(exportsObj)) {
    const entry = exportsObj[key];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.import && !entry.default) {
        entry.default = entry.import;
      }
      addDefaultExportCondition(entry);
    }
  }
}

async function normalizeSelfReference(packageDir) {
  const selfReferencePaths = [
    path.join(packageDir, "node_modules", ".pnpm", "node_modules", "@rudderhq", "server"),
    path.join(packageDir, "node_modules", ".pnpm", "node_modules", "@rudder", "server"),
    path.join(packageDir, "node_modules", "@rudderhq", "server"),
    path.join(packageDir, "node_modules", "@rudder", "server"),
  ];

  await Promise.all(selfReferencePaths.map((selfReferencePath) => fs.rm(selfReferencePath, { force: true })));
}

function embeddedPostgresPlatformPackageName() {
  const arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  if (process.platform === "win32") {
    if (arch === "x64") return "@embedded-postgres/windows-x64";
    return null;
  }
  if (process.platform === "darwin") {
    if (arch === "arm64") return "@embedded-postgres/darwin-arm64";
    if (arch === "x64") return "@embedded-postgres/darwin-x64";
    return null;
  }
  if (process.platform === "linux") {
    if (arch === "arm64") return "@embedded-postgres/linux-arm64";
    if (arch === "arm") return "@embedded-postgres/linux-arm";
    if (arch === "ia32") return "@embedded-postgres/linux-ia32";
    if (arch === "ppc64") return "@embedded-postgres/linux-ppc64";
    if (arch === "x64") return "@embedded-postgres/linux-x64";
  }
  return null;
}

async function stageEmbeddedPostgresPlatformPackage(packageDir) {
  const packageName = embeddedPostgresPlatformPackageName();
  if (!packageName) return;

  const nodeModulesDir = path.join(packageDir, "node_modules");
  const destinationPath = path.join(nodeModulesDir, ...packageName.split("/"));
  if (await exists(destinationPath)) return;

  const rootVirtualStoreDir = path.join(repoRoot, "node_modules", ".pnpm");
  const storePrefix = `${packageName.replace("/", "+")}@`;
  const storeEntry = (await fs.readdir(rootVirtualStoreDir, { withFileTypes: true }))
    .find((entry) => entry.isDirectory() && entry.name.startsWith(storePrefix));

  if (!storeEntry) {
    throw new Error(`missing ${packageName} in root pnpm store; run pnpm install on this platform before packaging`);
  }

  const sourcePath = path.join(rootVirtualStoreDir, storeEntry.name, "node_modules", ...packageName.split("/"));
  if (!(await exists(sourcePath))) {
    throw new Error(`missing ${packageName} package payload at ${sourcePath}`);
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.cp(sourcePath, destinationPath, { recursive: true, dereference: true });
}

async function promoteVirtualStorePackages(packageDir) {
  const nodeModulesDir = path.join(packageDir, "node_modules");
  const virtualStoreDir = path.join(nodeModulesDir, ".pnpm");

  if (!(await exists(virtualStoreDir))) return;

  async function promotePackage(packageName, packagePath) {
    const destinationPath = packageName.startsWith("@")
      ? path.join(nodeModulesDir, ...packageName.split("/"))
      : path.join(nodeModulesDir, packageName);

    if (await exists(destinationPath)) return;

    const stat = await fs.lstat(packagePath);
    if (!stat.isDirectory()) return;

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    const linkTarget = process.platform === "win32"
      ? packagePath
      : path.relative(path.dirname(destinationPath), packagePath);

    try {
      await fs.symlink(linkTarget, destinationPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code !== "EEXIST") throw error;
    }
  }

  async function promotePackagesFromNodeModules(sourceNodeModulesDir) {
    if (!(await exists(sourceNodeModulesDir))) return;

    for (const packageEntry of await fs.readdir(sourceNodeModulesDir, { withFileTypes: true })) {
      if (!packageEntry.isDirectory() && !packageEntry.isSymbolicLink()) continue;

      if (packageEntry.name.startsWith("@")) {
        const scopeDir = path.join(sourceNodeModulesDir, packageEntry.name);
        for (const scopedEntry of await fs.readdir(scopeDir, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
          const packageName = `${packageEntry.name}/${scopedEntry.name}`;
          if (packageName === "@rudderhq/server" || packageName === "@rudder/server") continue;
          await promotePackage(packageName, path.join(scopeDir, scopedEntry.name));
        }
        continue;
      }

      await promotePackage(packageEntry.name, path.join(sourceNodeModulesDir, packageEntry.name));
    }
  }

  await promotePackagesFromNodeModules(path.join(virtualStoreDir, "node_modules"));

  for (const storeEntry of await fs.readdir(virtualStoreDir, { withFileTypes: true })) {
    if (!storeEntry.isDirectory()) continue;

    const storeNodeModulesDir = path.join(virtualStoreDir, storeEntry.name, "node_modules");
    await promotePackagesFromNodeModules(storeNodeModulesDir);
  }
}

async function rewriteInternalPackages(targetDir) {
  const rudderDir = path.join(targetDir, "node_modules", "@rudderhq");
  try {
    const entries = await fs.readdir(rudderDir);
    await Promise.all(
      entries.map((entry) => rewritePublishedManifest(path.join(rudderDir, entry))),
    );
  } catch {
    // @rudderhq scope may not exist
  }
}

async function main() {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  const sourceManifestSnapshots = await snapshotSourcePackageManifests();
  try {
    await run(pnpmBin, ["--filter", "@rudderhq/server", "--prod", "deploy", targetDir], repoRoot);
  } finally {
    await restoreSourcePackageManifests(sourceManifestSnapshots);
  }
  await rewritePublishedManifest(targetDir);
  await rewriteInternalPackages(targetDir);
  await promoteVirtualStorePackages(targetDir);
  await stageEmbeddedPostgresPlatformPackage(targetDir);
  await normalizeSelfReference(targetDir);

  const deployedEntry = path.join(targetDir, "dist", "index.js");
  await fs.access(deployedEntry);
}

void main().catch((error) => {
  console.error("[desktop:stage-server] failed to stage server package", error);
  process.exit(1);
});
