import fs from "node:fs/promises";
import path from "node:path";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function rewriteInternalPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!(await exists(manifestPath))) return;

  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest.name?.startsWith?.("@rudderhq/")) return;
  if (!manifest.publishConfig) return;

  const nextManifest = {
    ...manifest,
  };

  if (manifest.publishConfig.exports) {
    nextManifest.exports = manifest.publishConfig.exports;
  }
  if (manifest.publishConfig.main) {
    nextManifest.main = manifest.publishConfig.main;
  }
  if (manifest.publishConfig.types) {
    nextManifest.types = manifest.publishConfig.types;
  }

  await fs.writeFile(`${manifestPath}`, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
}

async function listTopLevelPackages(nodeModulesDir) {
  if (!(await exists(nodeModulesDir))) return [];

  const entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  const packageDirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;

    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
        packageDirs.push(path.join(entryPath, scopedEntry.name));
      }
      continue;
    }

    packageDirs.push(entryPath);
  }

  return packageDirs;
}

async function findWorkspacePackageDir(appDir, packageName) {
  const packageParts = packageName.split("/");
  const directSearchRoots = [
    path.join(appDir, "node_modules"),
    path.resolve(appDir, "..", "node_modules"),
  ];

  for (const root of directSearchRoots) {
    const candidate = path.join(root, ...packageParts);
    if (await exists(candidate)) return candidate;
  }

  const pnpmStoreRoots = directSearchRoots.map((root) => path.join(root, ".pnpm"));
  for (const storeRoot of pnpmStoreRoots) {
    if (!(await exists(storeRoot))) continue;
    const entries = await fs.readdir(storeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(storeRoot, entry.name, "node_modules", ...packageParts);
      if (await exists(candidate)) return candidate;
    }
  }

  return null;
}

async function copyOptionalDependencies(appDir, nodeModulesDir) {
  const packageDirs = await listTopLevelPackages(nodeModulesDir);

  for (const packageDir of packageDirs) {
    const manifestPath = path.join(packageDir, "package.json");
    if (!(await exists(manifestPath))) continue;

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {});

    for (const dependencyName of optionalDependencies) {
      const destinationDir = path.join(nodeModulesDir, ...dependencyName.split("/"));
      if (await exists(destinationDir)) continue;

      const sourceDir = await findWorkspacePackageDir(appDir, dependencyName);
      if (!sourceDir) continue;

      await fs.mkdir(path.dirname(destinationDir), { recursive: true });
      await fs.cp(sourceDir, destinationDir, { recursive: true, dereference: true });
    }
  }
}

async function copyPackagedServerBundle(appDir, resourcesDir) {
  const stagedServerPackageDir = path.join(appDir, ".packaged", "server-package");
  if (!(await exists(stagedServerPackageDir))) return;

  const destinationDir = path.join(resourcesDir, "server-package");
  await fs.rm(destinationDir, { recursive: true, force: true });
  await copyTreePreservingSymlinks(stagedServerPackageDir, destinationDir);
}

async function copyTreePreservingSymlinks(sourcePath, destinationPath) {
  const stats = await fs.lstat(sourcePath);

  if (stats.isSymbolicLink()) {
    const target = await fs.readlink(sourcePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.symlink(target, destinationPath);
    return;
  }

  if (stats.isDirectory()) {
    await fs.mkdir(destinationPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      await copyTreePreservingSymlinks(
        path.join(sourcePath, entry.name),
        path.join(destinationPath, entry.name),
      );
    }
    return;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  await fs.chmod(destinationPath, stats.mode);
}

export default async function afterPack(context) {
  const projectDir = context.packager?.projectDir ?? process.cwd();
  const appDir = context.appDir ?? projectDir;
  const resourcesDir = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, "Rudder.app", "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const appNodeModulesDir = path.join(resourcesDir, "app", "node_modules");
  const rudderPackagesDir = path.join(appNodeModulesDir, "@rudder");
  const packagedServerRudderPackagesDirs = [
    path.join(resourcesDir, "server-package", "node_modules", "@rudderhq"),
    path.join(resourcesDir, "server-package", "node_modules", "@rudder"),
  ];

  await copyOptionalDependencies(appDir, appNodeModulesDir);
  await copyPackagedServerBundle(projectDir, resourcesDir);

  for (const packagedServerRudderPackagesDir of packagedServerRudderPackagesDirs) {
    if (!(await exists(packagedServerRudderPackagesDir))) continue;
    const entries = await fs.readdir(packagedServerRudderPackagesDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => rewriteInternalPackageManifest(path.join(packagedServerRudderPackagesDir, entry.name))),
    );
  }

  if (!(await exists(rudderPackagesDir))) return;

  const entries = await fs.readdir(rudderPackagesDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => rewriteInternalPackageManifest(path.join(rudderPackagesDir, entry.name))),
  );
}
