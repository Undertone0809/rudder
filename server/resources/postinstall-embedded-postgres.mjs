import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep these bytes aligned with patches/embedded-postgres@18.1.0-beta.16.patch.
// npm does not apply the workspace's pnpm.patchedDependencies configuration.
const VERSION = "18.1.0-beta.16";
const ORIGINAL_SHA256 = "17277c7bbbc1791632575ed4ff299399211d2a87497f0e507d4c22be22ab8e8f";
const PATCHED_SHA256 = "2ea226713effef5d494fab8a7509d68784fbd86ce333fe463971f45320745941";
const ORIGINAL = [
  "                    const message = chunk.toString('utf-8');",
  "                    this.options.onLog(message);",
  "                });",
  "                process.on('exit', (code) => {",
  "                    if (code === 0) {",
  "                        resolve();",
  "                    }",
  "                    else {",
  "                        reject(`Postgres init script exited with code ${code}. Please check the logs for extra info. The data directory might already exist.`);",
  "                    }",
  "                });",
  "            });",
  "",
].join("\n");
const PATCHED = [
  "                    const message = chunk.toString('utf-8');",
  "                    this.options.onLog(message);",
  "                });",
  "                process.stderr?.on('data', (chunk) => {",
  "                    this.options.onError(chunk.toString('utf-8'));",
  "                });",
  "                // close follows stream drainage, including stderr after exit.",
  "                process.once('error', reject);",
  "                process.on('close', (code, signal) => {",
  "                    if (code === 0) {",
  "                        resolve();",
  "                    }",
  "                    else {",
  "                        reject(`Postgres init script exited with code ${code}${signal ? ` (signal ${signal})` : ''}. Please check the logs for extra info. The data directory might already exist.`);",
  "                    }",
  "                });",
  "            });",
  "",
].join("\n");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function ownedPath(candidate, allowedRoot) {
  const canonical = realpathSync(candidate);
  if (!isInside(canonical, allowedRoot)) {
    throw new Error(`Refusing embedded-postgres repair outside install root: ${candidate}`);
  }
  return canonical;
}

function readManifest(packageRoot, expectedName) {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== expectedName) {
    throw new Error(`Expected ${expectedName} package at ${packageRoot}`);
  }
  return manifest;
}

function resolveDependencyRoot(consumerRoot, name, allowedRoot) {
  // Inspect Node's lookup directories because @rudderhq/db intentionally does
  // not export package.json and its published entry has an import-only export.
  const require = createRequire(path.join(consumerRoot, "package.json"));
  for (const nodeModules of require.resolve.paths(name) ?? []) {
    const candidate = path.join(nodeModules, name);
    if (!existsSync(path.join(candidate, "package.json"))) continue;
    const canonical = ownedPath(candidate, allowedRoot);
    readManifest(canonical, name);
    return canonical;
  }
  throw new Error(`Missing ${name} dependency for ${consumerRoot}`);
}

function planRepairs(serverPackageDir, allowedRoot) {
  if (lstatSync(allowedRoot).isSymbolicLink()) {
    throw new Error(`Refusing embedded-postgres repair through a symlinked install root: ${allowedRoot}`);
  }
  const root = realpathSync(allowedRoot);
  const serverRoot = ownedPath(serverPackageDir, root);
  readManifest(serverRoot, "@rudderhq/server");
  const dbRoot = resolveDependencyRoot(serverRoot, "@rudderhq/db", root);
  const entries = new Map();
  for (const consumerRoot of [serverRoot, dbRoot]) {
    const packageRoot = resolveDependencyRoot(consumerRoot, "embedded-postgres", root);
    const manifest = readManifest(packageRoot, "embedded-postgres");
    if (manifest.version !== VERSION) {
      throw new Error(`Unsupported embedded-postgres version ${manifest.version} at ${packageRoot}`);
    }
    const entryPath = path.join(packageRoot, "dist", "index.js");
    const canonicalEntry = ownedPath(entryPath, root);
    // A dependency directory may link into this installation's virtual store;
    // never write through a symlink in dist/index.js or its containing directory.
    if (canonicalEntry !== entryPath || !lstatSync(entryPath).isFile()) {
      throw new Error(`Refusing embedded-postgres repair through a file or directory symlink: ${entryPath}`);
    }
    const require = createRequire(path.join(consumerRoot, "package.json"));
    if (require.resolve("embedded-postgres") !== entryPath) {
      throw new Error(`Unexpected embedded-postgres entry for ${consumerRoot}`);
    }
    if (entries.has(entryPath)) continue;
    const content = readFileSync(entryPath);
    const digest = sha256(content);
    if (digest !== ORIGINAL_SHA256 && digest !== PATCHED_SHA256) {
      throw new Error(`Unknown embedded-postgres content at ${entryPath} (sha256 ${digest})`);
    }
    const patched = digest === PATCHED_SHA256
      ? content
      : Buffer.from(content.toString("utf8").replace(ORIGINAL, PATCHED));
    if (sha256(patched) !== PATCHED_SHA256) {
      throw new Error(`embedded-postgres patch no longer matches the pinned source: ${entryPath}`);
    }
    entries.set(entryPath, { entryPath, content, patched, status: digest === PATCHED_SHA256 ? "already_patched" : "patched" });
  }
  return [...entries.values()];
}

/** Repair both consumers before either starts PostgreSQL. Validate the whole
 * graph first, and rename fresh files so pnpm's shared hardlinks stay untouched.
 * allowedRoot is the installed node_modules tree or the Desktop staging root.
 */
export function repairEmbeddedPostgres({ serverPackageDir, allowedRoot, checkOnly = false }) {
  const repairs = planRepairs(serverPackageDir, allowedRoot);
  if (checkOnly) {
    for (const repair of repairs) {
      if (repair.status !== "already_patched") {
        throw new Error(`Unpatched embedded-postgres at ${repair.entryPath}`);
      }
    }
  } else {
    for (const repair of repairs) {
      if (repair.status === "already_patched") continue;
      const { entryPath, content, patched } = repair;
      if (!readFileSync(entryPath).equals(content)) {
        throw new Error(`embedded-postgres changed during repair: ${entryPath}`);
      }
      const temporaryPath = `${entryPath}.rudder-${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, patched, { flag: "wx", mode: lstatSync(entryPath).mode & 0o777 });
        renameSync(temporaryPath, entryPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }
  }
  return repairs.map(({ entryPath, status }) => ({ entryPath, status }));
}

export function installedNodeModulesRoot(serverPackageDir) {
  const absolute = path.resolve(serverPackageDir);
  const parts = absolute.split(path.sep);
  const index = parts.indexOf("node_modules");
  return index < 0 ? null : parts.slice(0, index + 1).join(path.sep);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  const serverPackageDir = path.resolve(path.dirname(process.argv[1]), "..");
  const allowedRoot = installedNodeModulesRoot(serverPackageDir);
  // Workspace installs use the root pnpm patch. Desktop staging calls the
  // exported function explicitly, with the deployed artifact as its boundary.
  if (allowedRoot) {
    try {
      const results = repairEmbeddedPostgres({ serverPackageDir, allowedRoot });
      console.log(`[rudder] verified embedded-postgres initdb diagnostics (${results.length} copies)`);
    } catch (error) {
      console.error(`[rudder] embedded-postgres repair failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
