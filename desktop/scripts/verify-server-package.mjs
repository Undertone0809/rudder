import { access, lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  } catch (e) {
    error(`createRequire cannot resolve @rudderhq/server: ${e.message}`);
  }
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
    "@langfuse/client",
    "@opentelemetry/sdk-trace-node",
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
