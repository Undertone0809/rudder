import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyNativeReleaseVersion } from "../../scripts/native-release-version.mjs";
import { resolveNativeTarget } from "./native-target.mjs";
import {
  EMBEDDED_POSTGRES_PLATFORM_PACKAGES,
  OPTIMIZATION_MANIFEST,
  embeddedPostgresPlatformPackage,
  isForbiddenProductionPackage,
  packageHasTypeMetadata,
} from "./optimize-server-package.mjs";
import { verifyBrowserBundle } from "./verify-browser-bundle.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");

const EXIT_OK = 0;
const EXIT_FAIL = 1;

/** @type {string[]} */
const errors = [];

function error(message) {
  errors.push(message);
  console.error(`  ✗ ${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(targetPath) {
  if (!(await exists(targetPath))) return null;
  return JSON.parse(await readFile(targetPath, "utf8"));
}

/**
 * @param {string} serverPackageDir
 * @returns {Promise<{ name: string; path: string; isSymlink: boolean; symlinkTarget: string | null; broken: boolean }[]>}
 */
async function listTopLevelPackages(serverPackageDir) {
  const nm = path.join(serverPackageDir, "node_modules");
  const result = [];
  for (const entry of await readdir(nm)) {
    if (entry.startsWith(".")) continue;
    const p = path.join(nm, entry);
    const st = await lstat(p);
    if (st.isSymbolicLink()) {
      const target = await readFile(p, { encoding: null })
        .then(() => "")
        .catch(() => null);
      // readlink gives us the symlink target string
      let symlinkTarget = "";
      let broken = false;
      try {
        symlinkTarget = await readFile(p, { encoding: "utf8" });
        // readFile on a symlink resolves the target; if it fails, the symlink is broken
      } catch {
        try {
          symlinkTarget = (await import("node:fs/promises")).readlink(p);
        } catch {
          broken = true;
        }
      }
      // Actually let's use readlink properly
      try {
        const { readlink } = await import("node:fs/promises");
        symlinkTarget = await readlink(p);
        const resolvedTarget = path.resolve(path.dirname(p), symlinkTarget);
        broken = !(await exists(resolvedTarget));
      } catch {
        broken = true;
        symlinkTarget = "";
      }
      if (entry.startsWith("@")) {
        for (const sub of await readdir(p)) {
          const subPath = path.join(p, sub);
          const subSt = await lstat(subPath);
          result.push({ name: `${entry}/${sub}`, path: subPath, isSymlink: subSt.isSymbolicLink(), symlinkTarget: null, broken: false });
        }
      } else {
        result.push({ name: entry, path: p, isSymlink: true, symlinkTarget, broken });
      }
    } else if (st.isDirectory()) {
      if (entry.startsWith("@")) {
        for (const sub of await readdir(p)) {
          const subPath = path.join(p, sub);
          const subSt = await lstat(subPath);
          let symlinkTarget = null;
          let broken = false;
          if (subSt.isSymbolicLink()) {
            try {
              const { readlink } = await import("node:fs/promises");
              symlinkTarget = await readlink(subPath);
              const resolvedTarget = path.resolve(path.dirname(subPath), symlinkTarget);
              broken = !(await exists(resolvedTarget));
            } catch {
              broken = true;
            }
          }
          result.push({ name: `${entry}/${sub}`, path: subPath, isSymlink: subSt.isSymbolicLink(), symlinkTarget, broken });
        }
      } else {
        result.push({ name: entry, path: p, isSymlink: false, symlinkTarget: null, broken: false });
      }
    }
  }
  return result;
}

/**
 * @param {string} pkgPath
 */
async function verifyPackageExports(pkgPath) {
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  if (!pkg.name?.startsWith("@rudderhq/")) return;

  const exportsAny = pkg.exports;
  if (!exportsAny) return;

  let needsDefault = false;

  function check(obj) {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
    for (const key of Object.keys(obj)) {
      const entry = obj[key];
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        if (entry.import && !entry.default) {
          needsDefault = true;
        }
        check(entry);
      }
    }
  }

  check(exportsAny);

  if (needsDefault) {
    error(`${pkg.name} exports missing "default" fallback (createRequire needs it)`);
  }
}

/**
 * @param {string} serverPackageDir
 */
async function verifyModuleResolution(serverPackageDir) {
  try {
    const pkgJsonPath = path.join(serverPackageDir, "package.json");
    const req = createRequire(pkgJsonPath);
    const entry = req.resolve("@rudderhq/server");
    ok(`createRequire resolves @rudderhq/server → ${path.relative(serverPackageDir, entry)}`);
    await import(pathToFileURL(entry).href);
    ok("dynamic import loads @rudderhq/server");
  } catch (e) {
    error(`packaged @rudderhq/server cannot be imported: ${e.message}`);
  }
}

async function listVirtualStorePackageNames(serverPackageDir) {
  const pnpmDir = path.join(serverPackageDir, "node_modules", ".pnpm");
  if (!(await exists(pnpmDir))) return new Set();
  const packageNames = new Set();
  for (const storeEntry of await readdir(pnpmDir, { withFileTypes: true })) {
    if (!storeEntry.isDirectory() || storeEntry.name === "node_modules") continue;
    const storeNodeModules = path.join(pnpmDir, storeEntry.name, "node_modules");
    if (!(await exists(storeNodeModules))) continue;
    for (const entry of await readdir(storeNodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = path.join(storeNodeModules, entry.name);
        for (const scopedEntry of await readdir(scopeDir, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
          const manifestPath = path.join(scopeDir, scopedEntry.name, "package.json");
          if (!(await exists(manifestPath))) continue;
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          if (manifest.name) packageNames.add(manifest.name);
        }
        continue;
      }
      const manifestPath = path.join(storeNodeModules, entry.name, "package.json");
      if (!(await exists(manifestPath))) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name) packageNames.add(manifest.name);
    }
  }
  return packageNames;
}

async function listInstalledPackageNames(serverPackageDir) {
  const packageNames = await listVirtualStorePackageNames(serverPackageDir);
  const visitedNodeModules = new Set();

  async function inspectPackage(packageRoot) {
    const manifestPath = path.join(packageRoot, "package.json");
    if (!(await exists(manifestPath))) return;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name) packageNames.add(manifest.name);
    const packageStats = await lstat(packageRoot);
    if (!packageStats.isSymbolicLink()) {
      await walkNodeModules(path.join(packageRoot, "node_modules"));
    }
  }

  async function walkNodeModules(nodeModulesDir) {
    if (!(await exists(nodeModulesDir))) return;
    const realNodeModulesDir = await realpath(nodeModulesDir);
    if (visitedNodeModules.has(realNodeModulesDir)) return;
    visitedNodeModules.add(realNodeModulesDir);

    for (const entry of await readdir(nodeModulesDir, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name === ".pnpm") continue;
      const entryPath = path.join(nodeModulesDir, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const scopedEntry of await readdir(entryPath, { withFileTypes: true })) {
          if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
            await inspectPackage(path.join(entryPath, scopedEntry.name));
          }
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        await inspectPackage(entryPath);
      }
    }
  }

  await walkNodeModules(path.join(serverPackageDir, "node_modules"));
  return packageNames;
}

async function findNonRuntimeFiles(serverPackageDir, limit = 20) {
  const matches = [];

  async function walk(currentPath) {
    if (matches.length >= limit) return;
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      if (matches.length >= limit) return;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (
        entry.isFile()
        && (
          entry.name.endsWith(".d.ts")
          || entry.name.endsWith(".d.ts.map")
          || entry.name.endsWith(".d.cts")
          || entry.name.endsWith(".d.cts.map")
          || entry.name.endsWith(".d.mts")
          || entry.name.endsWith(".d.mts.map")
          || entry.name.endsWith(".map")
        )
      ) {
        matches.push(path.relative(serverPackageDir, entryPath));
      }
    }
  }

  await walk(serverPackageDir);
  return matches;
}

async function findTypeMetadata(serverPackageDir, limit = 20) {
  const matches = [];
  async function walk(currentPath) {
    if (matches.length >= limit) return;
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      if (matches.length >= limit) return;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(entryPath, "utf8"));
        if (packageHasTypeMetadata(manifest)) {
          matches.push(path.relative(serverPackageDir, entryPath));
        }
      }
    }
  }
  await walk(serverPackageDir);
  return matches;
}

async function verifyOptimizedProductionPackage(serverPackageDir) {
  const optimizationPath = path.join(serverPackageDir, OPTIMIZATION_MANIFEST);
  if (!(await exists(optimizationPath))) {
    error(`production optimization manifest missing: ${optimizationPath}`);
    return;
  }
  const optimization = JSON.parse(await readFile(optimizationPath, "utf8"));
  if (optimization.version !== 1) {
    error(`unsupported production optimization manifest version: ${optimization.version}`);
  }

  const installedPackageNames = await listInstalledPackageNames(serverPackageDir);
  const forbiddenPackages = [...installedPackageNames].filter(isForbiddenProductionPackage).sort();
  if (forbiddenPackages.length > 0) {
    for (const packageName of forbiddenPackages) {
      error(`build/test package present in production runtime: ${packageName}`);
    }
  } else {
    ok("optional peer build/test packages removed");
  }

  const targetEmbeddedPlatformPackage = embeddedPostgresPlatformPackage(
    optimization.platform,
    optimization.arch,
  );
  const embeddedPlatformPackages = [...installedPackageNames]
    .filter((packageName) => EMBEDDED_POSTGRES_PLATFORM_PACKAGES.has(packageName))
    .sort();
  if (optimization.bundledPostgres === true && embeddedPlatformPackages.length > 0) {
    for (const packageName of embeddedPlatformPackages) {
      error(`duplicate embedded PostgreSQL platform package present: ${packageName}`);
    }
  } else if (optimization.bundledPostgres === true && targetEmbeddedPlatformPackage) {
    ok(`duplicate embedded PostgreSQL platform packages removed (target ${targetEmbeddedPlatformPackage})`);
  }

  const nonRuntimeFiles = await findNonRuntimeFiles(serverPackageDir);
  if (nonRuntimeFiles.length > 0) {
    for (const filePath of nonRuntimeFiles) {
      error(`non-runtime type/source-map file present: ${filePath}`);
    }
  } else {
    ok("type declarations and source maps removed");
  }

  const typeMetadata = await findTypeMetadata(serverPackageDir);
  if (typeMetadata.length > 0) {
    for (const filePath of typeMetadata) {
      error(`non-runtime type metadata present: ${filePath}`);
    }
  } else {
    ok("package type metadata removed");
  }

  try {
    const requireFromPackage = createRequire(path.join(serverPackageDir, "package.json"));
    const tokenizer = requireFromPackage("gpt-tokenizer/encoding/o200k_base");
    const sample = "Rudder 世界";
    const tokens = tokenizer.encode(sample, { disallowedSpecial: new Set() });
    if (tokenizer.decode(tokens) !== sample) {
      throw new Error("o200k_base encode/decode round trip did not preserve text");
    }
    ok("compact gpt-tokenizer o200k_base bundle checked");
  } catch (e) {
    error(`compact gpt-tokenizer bundle failed: ${e.message}`);
  }
}

/**
 * A portable Desktop asset must be version-closed: the Electron shell, the
 * server, the bundled CLI, and every first-party server dependency must come
 * from the same release. A partial runtime cache can otherwise make the app
 * install successfully and fail only after login when the local database
 * starts.
 *
 * @param {string} serverPackageDir
 */
async function verifyVersionCompatibility(serverPackageDir) {
  const resourcesDir = path.dirname(serverPackageDir);
  const serverManifest = await readJsonIfPresent(path.join(serverPackageDir, "package.json"));
  if (!serverManifest?.version) {
    error(`server-package manifest is missing a release version: ${path.join(serverPackageDir, "package.json")}`);
    return;
  }

  const expectedVersion = serverManifest.version;
  const versionedFiles = [
    ["Desktop shell", path.join(resourcesDir, "app", "package.json")],
    ["bundled CLI", path.join(serverPackageDir, "rudder-cli-package.json")],
  ];
  for (const [label, manifestPath] of versionedFiles) {
    const manifest = await readJsonIfPresent(manifestPath);
    if (!manifest) {
      error(`${label} manifest is missing: ${manifestPath}`);
    } else if (manifest.version !== expectedVersion) {
      error(`${label} version ${manifest.version ?? "<missing>"} does not match server ${expectedVersion}`);
    }
  }

  const serverDependencies = {
    ...(serverManifest.dependencies ?? {}),
    ...(serverManifest.optionalDependencies ?? {}),
  };
  const firstPartyDependencies = Object.keys(serverDependencies).filter((name) => name.startsWith("@rudderhq/"));
  for (const dependencyName of firstPartyDependencies) {
    const dependencyManifest = await readJsonIfPresent(
      path.join(serverPackageDir, "node_modules", ...dependencyName.split("/"), "package.json"),
    );
    if (!dependencyManifest) {
      error(`first-party dependency ${dependencyName} is missing from server-package`);
    } else if (dependencyManifest.version !== expectedVersion) {
      error(`first-party dependency ${dependencyName} version ${dependencyManifest.version ?? "<missing>"} does not match server ${expectedVersion}`);
    }
  }

  ok(`release version compatibility checked (${expectedVersion}; ${firstPartyDependencies.length} first-party dependencies)`);

  const repoRoot = path.resolve(desktopRoot, "..");
  const target = resolveNativeTarget(process.platform, process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch);
  const binaryPaths = target
    ? [
        path.join(resourcesDir, "native", target, process.platform === "win32" ? "rudder-native.exe" : "rudder-native"),
        path.join(resourcesDir, "native", target, process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host"),
        path.join(resourcesDir, "native", target, process.platform === "win32" ? "rudder-update-helper.exe" : "rudder-update-helper"),
        path.join(resourcesDir, "native", target, process.platform === "win32" ? "rudder-speech.exe" : "rudder-speech"),
      ]
    : [];
  try {
    const nativeReceipt = verifyNativeReleaseVersion({ repoRoot, expectedVersion, binaryPaths });
    ok(`Rust release version compatibility checked (${nativeReceipt.productVersion}; ${nativeReceipt.versionSources.nativePackages.length} native packages)`);
  } catch (e) {
    error(`Rust release version compatibility failed: ${e.message}`);
  }
}

function packagedRuntimeSegment() {
  const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  return `${process.platform}-${targetArch}`;
}

async function verifyPostgresRuntimePayload(serverPackageDir) {
  const resourcesDir = path.dirname(serverPackageDir);
  const runtimeDir = path.join(resourcesDir, "postgres-18.4", packagedRuntimeSegment());
  const binDir = path.join(runtimeDir, "bin");
  const executable = (name) => process.platform === "win32" ? `${name}.exe` : name;
  const requiredPaths = [
    path.join(binDir, executable("initdb")),
    path.join(binDir, executable("pg_ctl")),
    path.join(binDir, executable("postgres")),
  ];

  const missing = [];
  for (const requiredPath of requiredPaths) {
    if (!(await exists(requiredPath))) missing.push(requiredPath);
  }
  const timezoneCandidates = [
    path.join(runtimeDir, "share", "postgresql", "timezone"),
    path.join(runtimeDir, "share", "timezone"),
  ];
  if (!(await Promise.all(timezoneCandidates.map((candidate) => exists(candidate)))).some(Boolean)) {
    missing.push(timezoneCandidates.join(" or "));
  }
  for (const fileName of ["postgres.bki", "postgresql.conf.sample"]) {
    const candidates = [
      path.join(runtimeDir, "share", fileName),
      path.join(runtimeDir, "share", "postgresql", fileName),
    ];
    if (!(await Promise.all(candidates.map((candidate) => exists(candidate)))).some(Boolean)) {
      missing.push(candidates.join(" or "));
    }
  }

  if (missing.length > 0) {
    for (const missingPath of missing) {
      error(`PostgreSQL 18.4 runtime payload missing: ${missingPath}`);
    }
    return;
  }

  ok(`PostgreSQL 18.4 runtime payload checked (${path.relative(resourcesDir, runtimeDir)})`);
}

/**
 * @param {string} serverPackageDir
 */
async function verifyServerPackage(serverPackageDir) {
  console.log(`\n[verify-server-package] ${serverPackageDir}\n`);

  if (!(await exists(serverPackageDir))) {
    error(`server-package directory does not exist: ${serverPackageDir}`);
    return;
  }

  const nm = path.join(serverPackageDir, "node_modules");
  if (!(await exists(nm))) {
    error(`node_modules missing in ${serverPackageDir}`);
    return;
  }

  // 1. Check for broken symlinks and list top-level packages
  const packages = await listTopLevelPackages(serverPackageDir);
  const brokenSymlinks = packages.filter((p) => p.broken);
  const symlinks = packages.filter((p) => p.isSymlink);

  if (brokenSymlinks.length > 0) {
    for (const p of brokenSymlinks.slice(0, 20)) {
      error(`broken symlink: ${p.name} → ${p.symlinkTarget}`);
    }
    if (brokenSymlinks.length > 20) {
      error(`... and ${brokenSymlinks.length - 20} more broken symlinks`);
    }
  } else if (symlinks.length > 0) {
    ok(`all ${symlinks.length} symlinks valid`);
  }

  // 2. Critical dependencies must be present
  const critical = [
    "drizzle-orm",
    "express",
    "better-auth",
    "embedded-postgres",
    "postgres",
    "dotenv",
    "zod",
    "pino",
    "sharp",
    "ws",
    "jsdom",
    "chokidar",
    "detect-port",
    "dompurify",
    "multer",
    "open",
    "ajv",
    "ajv-formats",
    "hermes-paperclip-adapter",
    "@aws-sdk/client-s3",
    "gpt-tokenizer",
  ];
  const present = new Set(packages.map((p) => p.name));
  const missingCritical = critical.filter((name) => !present.has(name));
  if (missingCritical.length > 0) {
    for (const name of missingCritical) {
      error(`critical dependency missing: ${name}`);
    }
  } else {
    ok(`all ${critical.length} critical dependencies present`);
  }

  // 3. @rudderhq/* package exports
  const rudderDir = path.join(nm, "@rudderhq");
  if (await exists(rudderDir)) {
    const entries = await readdir(rudderDir);
    for (const entry of entries) {
      const pkgPath = path.join(rudderDir, entry, "package.json");
      if (await exists(pkgPath)) {
        await verifyPackageExports(pkgPath);
      }
    }
    ok(`@rudderhq/* exports checked (${entries.length} packages)`);
  }

  // 4. server-package self exports
  const serverPkgPath = path.join(serverPackageDir, "package.json");
  if (await exists(serverPkgPath)) {
    await verifyPackageExports(serverPkgPath);
  }

  // 5. Module resolution
  await verifyModuleResolution(serverPackageDir);

  // 5b. The shell, CLI, server, and first-party packages must agree.
  await verifyVersionCompatibility(serverPackageDir);

  // 6. PostgreSQL runtime payload required by packaged Desktop local startup.
  await verifyPostgresRuntimePayload(serverPackageDir);

  // 7. The production package contains runtime assets only.
  await verifyOptimizedProductionPackage(serverPackageDir);

  // 8. The packaged CLI and external runtime cache must expose one Browser contract.
  try {
    const result = await verifyBrowserBundle({ serverPackageDir });
    ok(`Browser bundle handshake checked (${result.browserTools.length} tools, ${result.provenance})`);
  } catch (e) {
    error(`Browser bundle handshake failed: ${e.message}`);
  }
}

async function findPackagedServerPackage() {
  // Try release artifacts first (after electron-builder)
  const releaseDir = path.join(desktopRoot, "release");
  const candidates = [
    path.join(releaseDir, "win-unpacked", "resources", "server-package"),
    path.join(releaseDir, "win-arm64-unpacked", "resources", "server-package"),
    path.join(releaseDir, "mac", "Rudder.app", "Contents", "Resources", "server-package"),
    path.join(releaseDir, "mac-arm64", "Rudder.app", "Contents", "Resources", "server-package"),
    path.join(releaseDir, "linux-unpacked", "resources", "server-package"),
    path.join(releaseDir, "linux-arm64-unpacked", "resources", "server-package"),
    // Fallback to staged package (before electron-builder)
    path.join(desktopRoot, ".packaged", "server-package"),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return null;
}

async function main() {
  const explicitDir = process.argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
  const serverPackageDir = explicitDir
    ? path.resolve(explicitDir)
    : await findPackagedServerPackage();

  if (!serverPackageDir) {
    console.error("[verify-server-package] no server-package found. Run `pnpm desktop:dist` first, or pass --dir=...");
    process.exit(EXIT_FAIL);
  }

  await verifyServerPackage(serverPackageDir);

  if (errors.length > 0) {
    console.error(`\n[verify-server-package] FAILED: ${errors.length} error(s)\n`);
    process.exit(EXIT_FAIL);
  }

  console.log("\n[verify-server-package] all checks passed\n");
  process.exit(EXIT_OK);
}

void main();
