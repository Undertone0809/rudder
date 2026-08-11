import fs from "node:fs/promises";
import path from "node:path";

const OPTIMIZATION_MANIFEST = ".rudder-production-package.json";
const NON_RUNTIME_DIR_NAMES = new Set([
  "__tests__",
  "coverage",
  "docs",
  "examples",
  "test",
  "tests",
]);
const FORBIDDEN_PRODUCTION_PACKAGES = new Set([
  "@electric-sql/pglite",
  "chai",
  "drizzle-kit",
  "esbuild",
  "lightningcss",
  "rollup",
  "tsx",
  "vite",
  "vite-node",
  "vitest",
]);
const EMBEDDED_POSTGRES_PLATFORM_PACKAGES = new Set([
  "@embedded-postgres/darwin-arm64",
  "@embedded-postgres/darwin-x64",
  "@embedded-postgres/linux-arm",
  "@embedded-postgres/linux-arm64",
  "@embedded-postgres/linux-ia32",
  "@embedded-postgres/linux-ppc64",
  "@embedded-postgres/linux-x64",
  "@embedded-postgres/windows-x64",
]);

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeFileBreakingLinks(filePath, content) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function stripTypeExportConditions(value) {
  if (Array.isArray(value)) {
    return value.map(stripTypeExportConditions);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "types" && !key.startsWith("types@"))
      .map(([key, child]) => [key, stripTypeExportConditions(child)]),
  );
}

function packageHasTypeMetadata(manifest) {
  if (manifest.types !== undefined || manifest.typings !== undefined || manifest.typesVersions !== undefined) {
    return true;
  }
  let found = false;
  function inspect(value) {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "types" || key.startsWith("types@")) {
        found = true;
        return;
      }
      inspect(child);
    }
  }
  inspect(manifest.exports);
  return found;
}

async function stripPackageTypeMetadata(manifestPath) {
  const manifest = await readJson(manifestPath);
  if (!packageHasTypeMetadata(manifest)) return false;
  delete manifest.types;
  delete manifest.typings;
  delete manifest.typesVersions;
  if (manifest.exports !== undefined) {
    manifest.exports = stripTypeExportConditions(manifest.exports);
  }
  if (Array.isArray(manifest.files)) {
    manifest.files = manifest.files.filter((filePath) => !isNonRuntimeFile(filePath));
  }
  await writeFileBreakingLinks(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

function embeddedPostgresPlatformPackage(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "@embedded-postgres/darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@embedded-postgres/darwin-x64";
  if (platform === "linux" && arch === "arm64") return "@embedded-postgres/linux-arm64";
  if (platform === "linux" && arch === "arm") return "@embedded-postgres/linux-arm";
  if (platform === "linux" && arch === "ia32") return "@embedded-postgres/linux-ia32";
  if (platform === "linux" && arch === "ppc64") return "@embedded-postgres/linux-ppc64";
  if (platform === "linux" && arch === "x64") return "@embedded-postgres/linux-x64";
  if (platform === "win32" && arch === "x64") return "@embedded-postgres/windows-x64";
  return null;
}

function isForbiddenProductionPackage(packageName) {
  return FORBIDDEN_PRODUCTION_PACKAGES.has(packageName)
    || packageName.startsWith("@esbuild/")
    || packageName.startsWith("@rollup/")
    || packageName.startsWith("@vitest/")
    || packageName.startsWith("lightningcss-");
}

function packageNodeModulesDir(packageRoot, packageName) {
  return packageName.startsWith("@")
    ? path.dirname(path.dirname(packageRoot))
    : path.dirname(packageRoot);
}

function packagePath(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

async function resolveInstalledPackage(serverPackageDir, packageRoot, packageName, dependencyName) {
  const candidates = new Set([
    packagePath(path.join(packageRoot, "node_modules"), dependencyName),
    packagePath(packageNodeModulesDir(packageRoot, packageName), dependencyName),
    packagePath(path.join(serverPackageDir, "node_modules"), dependencyName),
  ]);
  let ancestor = path.dirname(packageRoot);
  while (ancestor === serverPackageDir || ancestor.startsWith(`${serverPackageDir}${path.sep}`)) {
    if (path.basename(ancestor) === "node_modules") {
      candidates.add(packagePath(ancestor, dependencyName));
    }
    if (ancestor === serverPackageDir) break;
    ancestor = path.dirname(ancestor);
  }
  for (const candidate of candidates) {
    try {
      return await fs.realpath(candidate);
    } catch {
      // Try the next supported node_modules layout.
    }
  }
  return null;
}

function virtualStoreEntry(pnpmDir, packageRoot) {
  const relative = path.relative(pnpmDir, packageRoot);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return null;
  }
  const [entry] = relative.split(path.sep);
  return entry === "node_modules" ? null : entry;
}

async function collectReachablePackages(serverPackageDir, options) {
  const nodeModulesDir = path.join(serverPackageDir, "node_modules");
  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  const realServerPackageDir = await fs.realpath(serverPackageDir);
  const realPnpmDir = await exists(pnpmDir) ? await fs.realpath(pnpmDir) : null;
  const serverManifest = await readJson(path.join(serverPackageDir, "package.json"));
  const omittedPackages = new Set(options.omittedPackages ?? []);
  const visitedRoots = new Set();
  const reachableStoreEntries = new Set();
  const reachablePackages = [];

  async function visit(packageRoot, expectedName) {
    const realRoot = await fs.realpath(packageRoot);
    if (visitedRoots.has(realRoot)) return;
    visitedRoots.add(realRoot);

    const manifestPath = path.join(realRoot, "package.json");
    const manifest = await readJson(manifestPath);
    const packageName = manifest.name ?? expectedName;
    if (!packageName) {
      throw new Error(`Production dependency is missing package name: ${realRoot}`);
    }
    reachablePackages.push({ name: packageName, root: realRoot });

    const storeEntry = realPnpmDir ? virtualStoreEntry(realPnpmDir, realRoot) : null;
    if (storeEntry) reachableStoreEntries.add(storeEntry);

    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const [peerName] of Object.entries(manifest.peerDependencies ?? {})) {
      const optionalPeer = manifest.peerDependenciesMeta?.[peerName]?.optional === true;
      if (
        optionalPeer
        && (isForbiddenProductionPackage(peerName) || omittedPackages.has(peerName))
      ) {
        continue;
      }
      dependencies[peerName] ??= "*";
    }

    for (const dependencyName of Object.keys(dependencies)) {
      if (omittedPackages.has(dependencyName) || isForbiddenProductionPackage(dependencyName)) {
        continue;
      }
      const dependencyRoot = await resolveInstalledPackage(
        realServerPackageDir,
        realRoot,
        packageName,
        dependencyName,
      );
      if (!dependencyRoot) {
        if (manifest.optionalDependencies?.[dependencyName] !== undefined) continue;
        if (manifest.peerDependencies?.[dependencyName] !== undefined) continue;
        throw new Error(`${packageName} production dependency is missing: ${dependencyName}`);
      }
      await visit(dependencyRoot, dependencyName);
    }
  }

  const directDependencies = {
    ...(serverManifest.dependencies ?? {}),
    ...(serverManifest.optionalDependencies ?? {}),
  };
  for (const dependencyName of Object.keys(directDependencies)) {
    if (omittedPackages.has(dependencyName) || isForbiddenProductionPackage(dependencyName)) {
      continue;
    }
    const dependencyRoot = packagePath(nodeModulesDir, dependencyName);
    if (!(await exists(dependencyRoot))) {
      if (serverManifest.optionalDependencies?.[dependencyName] !== undefined) continue;
      throw new Error(`Server production dependency is missing: ${dependencyName}`);
    }
    await visit(dependencyRoot, dependencyName);
  }

  return {
    reachablePackages,
    reachableStoreEntries,
    pnpmDir,
  };
}

async function pruneInstalledPackages(serverPackageDir, shouldRemove) {
  const removedPackages = [];
  const visitedNodeModules = new Set();

  async function removePackage(packageRoot, packageName) {
    const packageStats = await fs.lstat(packageRoot);
    const removed = packageStats.isSymbolicLink()
      ? { bytes: 0, files: 0 }
      : await treeStats(packageRoot);
    await fs.rm(packageRoot, { recursive: true, force: true });
    removedPackages.push({
      name: packageName,
      bytes: removed.bytes,
      files: removed.files,
      path: path.relative(serverPackageDir, packageRoot),
    });
  }

  async function inspectPackage(packageRoot) {
    const manifestPath = path.join(packageRoot, "package.json");
    if (!(await exists(manifestPath))) return;
    const manifest = await readJson(manifestPath);
    if (manifest.name && shouldRemove(manifest.name)) {
      await removePackage(packageRoot, manifest.name);
      return;
    }
    const packageStats = await fs.lstat(packageRoot);
    if (!packageStats.isSymbolicLink()) {
      await walkNodeModules(path.join(packageRoot, "node_modules"));
    }
  }

  async function walkNodeModules(nodeModulesDir) {
    if (!(await exists(nodeModulesDir))) return;
    const realNodeModulesDir = await fs.realpath(nodeModulesDir);
    if (visitedNodeModules.has(realNodeModulesDir)) return;
    visitedNodeModules.add(realNodeModulesDir);

    for (const entry of await fs.readdir(nodeModulesDir, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name === ".pnpm") continue;
      const entryPath = path.join(nodeModulesDir, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const scopedEntry of await fs.readdir(entryPath, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
          await inspectPackage(path.join(entryPath, scopedEntry.name));
        }
        const remaining = await fs.readdir(entryPath);
        if (remaining.length === 0) await fs.rm(entryPath, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await inspectPackage(entryPath);
      }
    }
  }

  await walkNodeModules(path.join(serverPackageDir, "node_modules"));
  return removedPackages.sort((a, b) => a.path.localeCompare(b.path));
}

async function removeBrokenSymlinks(rootPath) {
  if (!(await exists(rootPath))) return 0;
  let removed = 0;
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        await fs.realpath(entryPath);
      } catch {
        await fs.rm(entryPath, { force: true });
        removed += 1;
      }
      continue;
    }
    if (entry.isDirectory()) {
      removed += await removeBrokenSymlinks(entryPath);
    }
  }
  return removed;
}

async function pruneUnreachableVirtualStore(serverPackageDir, options) {
  const {
    reachablePackages,
    reachableStoreEntries,
    pnpmDir,
  } = await collectReachablePackages(serverPackageDir, options);
  if (!(await exists(pnpmDir))) {
    return {
      reachablePackages,
      reachableStoreEntries,
      removedStoreEntries: [],
      removedBrokenSymlinks: 0,
    };
  }

  const removedStoreEntries = [];
  for (const entry of await fs.readdir(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    if (reachableStoreEntries.has(entry.name)) continue;
    await fs.rm(path.join(pnpmDir, entry.name), { recursive: true, force: true });
    removedStoreEntries.push(entry.name);
  }

  const removedBrokenSymlinks = await removeBrokenSymlinks(path.join(serverPackageDir, "node_modules"));
  return {
    reachablePackages,
    reachableStoreEntries,
    removedStoreEntries,
    removedBrokenSymlinks,
  };
}

async function treeStats(rootPath) {
  if (!(await exists(rootPath))) return { bytes: 0, files: 0 };
  const stats = { bytes: 0, files: 0 };

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStats = await fs.stat(entryPath);
      stats.bytes += fileStats.size;
      stats.files += 1;
    }
  }

  await walk(rootPath);
  return stats;
}

async function compactTitleTokenizer(serverPackageDir) {
  const topLevelPackage = path.join(serverPackageDir, "node_modules", "gpt-tokenizer");
  if (!(await exists(topLevelPackage))) {
    return { status: "missing", originalBytes: 0, optimizedBytes: 0 };
  }

  const packageRoot = await fs.realpath(topLevelPackage);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const bundledEntry = path.join(packageRoot, "o200k-base.cjs");
  if (await exists(bundledEntry)) {
    const optimized = await treeStats(packageRoot);
    return {
      status: "already-optimized",
      originalBytes: optimized.bytes,
      optimizedBytes: optimized.bytes,
    };
  }
  const entryCandidates = [
    path.join(packageRoot, "cjs", "encoding", "o200k_base.js"),
    path.join(packageRoot, "esm", "encoding", "o200k_base.js"),
  ];
  const entryPoint = (await Promise.all(
    entryCandidates.map(async (candidate) => (await exists(candidate)) ? candidate : null),
  )).find(Boolean);
  if (!entryPoint) {
    throw new Error(`gpt-tokenizer o200k_base entrypoint is missing under ${packageRoot}`);
  }

  const original = await treeStats(packageRoot);
  const temporaryRoot = `${packageRoot}.compact-${process.pid}-${Date.now()}`;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
  await fs.mkdir(temporaryRoot, { recursive: true });
  const temporaryBundledEntry = path.join(temporaryRoot, "o200k-base.cjs");

  try {
    const { build } = await import("esbuild");
    await build({
      bundle: true,
      entryPoints: [entryPoint],
      format: "cjs",
      legalComments: "none",
      minify: true,
      outfile: temporaryBundledEntry,
      platform: "node",
      sourcemap: false,
      target: "node20",
    });
    await fs.writeFile(
      path.join(temporaryRoot, "package.json"),
      `${JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        type: "commonjs",
        exports: {
          "./encoding/o200k_base": {
            import: "./o200k-base.cjs",
            require: "./o200k-base.cjs",
            default: "./o200k-base.cjs",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    for (const licenseName of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      const source = path.join(packageRoot, licenseName);
      if (await exists(source)) {
        await fs.copyFile(source, path.join(temporaryRoot, licenseName));
      }
    }

    await fs.rm(packageRoot, { recursive: true, force: true });
    await fs.rename(temporaryRoot, packageRoot);
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  const optimized = await treeStats(packageRoot);
  return {
    status: "optimized",
    originalBytes: original.bytes,
    optimizedBytes: optimized.bytes,
  };
}

function isNonRuntimeFile(fileName) {
  return fileName.endsWith(".d.ts")
    || fileName.endsWith(".d.ts.map")
    || fileName.endsWith(".d.cts")
    || fileName.endsWith(".d.cts.map")
    || fileName.endsWith(".d.mts")
    || fileName.endsWith(".d.mts.map")
    || fileName.endsWith(".map");
}

async function pruneNonRuntimeFiles(serverPackageDir) {
  const stats = {
    removedBytes: 0,
    removedDirectories: 0,
    removedFiles: 0,
  };
  const nodeModulesDir = path.join(serverPackageDir, "node_modules");

  async function removeFile(filePath) {
    const fileStats = await fs.stat(filePath);
    stats.removedBytes += fileStats.size;
    stats.removedFiles += 1;
    await fs.rm(filePath, { force: true });
  }

  async function walk(currentPath, insideNodeModules) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (insideNodeModules && NON_RUNTIME_DIR_NAMES.has(entry.name)) {
          const removed = await treeStats(entryPath);
          stats.removedBytes += removed.bytes;
          stats.removedFiles += removed.files;
          stats.removedDirectories += 1;
          await fs.rm(entryPath, { recursive: true, force: true });
          continue;
        }
        await walk(entryPath, insideNodeModules || entryPath === nodeModulesDir);
        continue;
      }
      if (entry.isFile()) {
        if (isNonRuntimeFile(entry.name)) {
          await removeFile(entryPath);
        }
      }
    }
  }

  await walk(serverPackageDir, false);
  return stats;
}

async function prunePackageTypeMetadata(serverPackageDir, reachablePackages) {
  const manifestPaths = new Set([
    path.join(serverPackageDir, "package.json"),
    ...reachablePackages.map((pkg) => path.join(pkg.root, "package.json")),
  ]);

  async function collectNestedManifests(currentPath) {
    for (const entry of await fs.readdir(currentPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await collectNestedManifests(entryPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        manifestPaths.add(entryPath);
      }
    }
  }
  await collectNestedManifests(path.join(serverPackageDir, "node_modules"));

  let rewrittenManifests = 0;
  for (const manifestPath of manifestPaths) {
    if (!(await exists(manifestPath))) continue;
    rewrittenManifests += Number(await stripPackageTypeMetadata(manifestPath));
  }
  return { rewrittenManifests };
}

async function pruneBuiltWorkspaceSources(reachablePackages) {
  let removedBytes = 0;
  let removedDirectories = 0;
  let removedFiles = 0;
  for (const pkg of reachablePackages) {
    if (!pkg.name.startsWith("@rudderhq/") && !pkg.name.startsWith("@paperclipai/")) continue;
    const sourceDir = path.join(pkg.root, "src");
    const distDir = path.join(pkg.root, "dist");
    if (!(await exists(sourceDir)) || !(await exists(distDir))) continue;
    const removed = await treeStats(sourceDir);
    await fs.rm(sourceDir, { recursive: true, force: true });
    removedBytes += removed.bytes;
    removedFiles += removed.files;
    removedDirectories += 1;
  }
  return { removedBytes, removedDirectories, removedFiles };
}

export async function optimizeServerPackage({
  arch = process.arch,
  bundledPostgres = false,
  platform = process.platform,
  serverPackageDir,
}) {
  const omittedPackages = new Set();
  if (bundledPostgres) {
    for (const packageName of EMBEDDED_POSTGRES_PLATFORM_PACKAGES) {
      omittedPackages.add(packageName);
    }
  }

  const tokenizer = await compactTitleTokenizer(serverPackageDir);
  const virtualStore = await pruneUnreachableVirtualStore(serverPackageDir, {
    omittedPackages,
  });
  const removedInstalledPackages = await pruneInstalledPackages(
    serverPackageDir,
    (packageName) => omittedPackages.has(packageName) || isForbiddenProductionPackage(packageName),
  );
  const packageTypeMetadata = await prunePackageTypeMetadata(
    serverPackageDir,
    virtualStore.reachablePackages,
  );
  const workspaceSources = await pruneBuiltWorkspaceSources(virtualStore.reachablePackages);
  const nonRuntimeFiles = await pruneNonRuntimeFiles(serverPackageDir);
  const postPruneBrokenSymlinks = await removeBrokenSymlinks(
    path.join(serverPackageDir, "node_modules"),
  );

  const manifest = {
    version: 1,
    platform,
    arch,
    bundledPostgres,
    omittedPackages: [...omittedPackages].sort(),
    forbiddenProductionPackages: [...FORBIDDEN_PRODUCTION_PACKAGES].sort(),
    retainedVirtualStoreEntries: [...virtualStore.reachableStoreEntries].sort(),
    removedVirtualStoreEntries: virtualStore.removedStoreEntries.sort(),
    removedInstalledPackages,
    removedBrokenSymlinks: virtualStore.removedBrokenSymlinks + postPruneBrokenSymlinks,
    postPruneBrokenSymlinks,
    tokenizer,
    packageTypeMetadata,
    workspaceSources,
    nonRuntimeFiles,
  };
  await fs.writeFile(
    path.join(serverPackageDir, OPTIMIZATION_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export {
  EMBEDDED_POSTGRES_PLATFORM_PACKAGES,
  FORBIDDEN_PRODUCTION_PACKAGES,
  OPTIMIZATION_MANIFEST,
  embeddedPostgresPlatformPackage,
  isForbiddenProductionPackage,
  packageHasTypeMetadata,
  stripPackageTypeMetadata
};
