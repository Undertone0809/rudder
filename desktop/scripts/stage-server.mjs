import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const targetDir = path.join(repoRoot, "desktop", ".packaged", "server-package");
const postgresRuntimeDir = path.join(repoRoot, "desktop", ".packaged", "postgres-18.4");
const preparePostgresRuntimeScript = path.join(scriptDir, "prepare-postgres-runtime.mjs");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const sourceManifestRoots = ["packages", "server", "cli"];

function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: options.env ? { ...process.env, ...options.env } : process.env,
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

function postgresRuntimePlatformSegment() {
  const arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
  return `${process.platform}-${arch}`;
}

async function execFileAsync(command, args) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function preparePostgresRuntimeBinDir() {
  const result = await execFileAsync(process.execPath, [preparePostgresRuntimeScript]);
  const stdout = result.stdout.trim();
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preparedBinDir = lines.at(-1);
  if (!preparedBinDir) {
    throw new Error("PostgreSQL 18.4 runtime preparation did not return a bin directory");
  }
  return preparedBinDir;
}

function debianSharedirCandidate(sourceBinDir) {
  const normalized = path.resolve(sourceBinDir);
  const parts = normalized.split(path.sep);
  const libIndex = parts.lastIndexOf("lib");
  if (libIndex < 0) return null;
  if (parts[libIndex + 1] !== "postgresql") return null;
  const version = parts[libIndex + 2];
  if (!version || parts[libIndex + 3] !== "bin") return null;
  const prefix = parts.slice(0, libIndex).join(path.sep) || path.sep;
  return path.join(prefix, "share", "postgresql", version);
}

async function resolvePostgresTemplateDir(sourceBinDir) {
  for (const candidatePath of [
    path.join(sourceBinDir, "..", "share", "postgresql", "postgres.bki"),
    path.join(sourceBinDir, "..", "share", "postgres.bki"),
  ]) {
    try {
      await fs.access(candidatePath);
      return path.dirname(candidatePath);
    } catch {
      // Try the next supported PostgreSQL archive layout.
    }
  }

  const debianSharedir = debianSharedirCandidate(sourceBinDir);
  if (debianSharedir) {
    try {
      await fs.access(path.join(debianSharedir, "postgres.bki"));
      return debianSharedir;
    } catch {
      // Fall through to pg_config.
    }
  }

  const pgConfigPath = path.join(sourceBinDir, process.platform === "win32" ? "pg_config.exe" : "pg_config");
  try {
    await fs.access(pgConfigPath);
    const result = await execFileAsync(pgConfigPath, ["--sharedir"]);
    const sharedir = result.stdout.trim();
    if (sharedir) {
      const candidatePath = path.join(sharedir, "postgres.bki");
      await fs.access(candidatePath);
      return sharedir;
    }
  } catch {
    // Fall through to the standard missing-template error.
  }

  return null;
}

async function assertPostgresBinDirComplete(sourceBinDir) {
  const requiredBinaries = ["initdb", "pg_ctl", "postgres"];
  const missing = [];
  for (const binary of requiredBinaries) {
    const binaryName = process.platform === "win32" ? `${binary}.exe` : binary;
    const binaryPath = path.join(sourceBinDir, binaryName);
    try {
      await fs.access(binaryPath);
    } catch {
      missing.push(binaryPath);
    }
  }
  const templateDir = await resolvePostgresTemplateDir(sourceBinDir);
  const expectedTemplatePath = path.join(sourceBinDir, "..", "share", "postgresql", "postgres.bki");
  if (!templateDir) {
    missing.push(expectedTemplatePath);
  } else {
    const configTemplatePath = path.join(templateDir, "postgresql.conf.sample");
    try {
      await fs.access(configTemplatePath);
    } catch {
      missing.push(configTemplatePath);
    }
  }
  if (missing.length > 0) {
    const hasMissingTemplate = missing.includes(expectedTemplatePath);
    const requirement = hasMissingTemplate
      ? "initdb, pg_ctl, postgres binaries, and PostgreSQL 18.4 initdb template files"
      : "initdb, pg_ctl, and postgres binaries";
    throw new Error(`RUDDER_POSTGRES_BIN_DIR must include PostgreSQL 18.4 ${requirement}; missing ${missing.join(", ")}`);
  }
  return { templateDir };
}

async function stagePostgresRuntimePayload() {
  await fs.rm(postgresRuntimeDir, { recursive: true, force: true });

  if (process.env.RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME !== "1") {
    return;
  }

  let sourceBinDir = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (!sourceBinDir) {
    if (process.env.RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE === "1") {
      throw new Error(
        "RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME=1 requires RUDDER_POSTGRES_BIN_DIR pointing at PostgreSQL 18.4 production binaries, or automatic preparation enabled.",
      );
    }
    sourceBinDir = await preparePostgresRuntimeBinDir();
  }

  const { templateDir } = await assertPostgresBinDirComplete(sourceBinDir);
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    const binaryPath = path.join(
      sourceBinDir,
      process.platform === "win32" ? `${binary}.exe` : binary,
    );
    const versionResult = await execFileAsync(binaryPath, ["--version"]);
    const versionOutput = [versionResult.stdout, versionResult.stderr].filter(Boolean).join("\n");
    if (!/\bPostgreSQL\)?\s+18\.4\b/i.test(versionOutput)) {
      throw new Error(
        `RUDDER_POSTGRES_BIN_DIR must contain PostgreSQL 18.4 ${binary}; got ${versionOutput.trim() || "unknown version"}`,
      );
    }
  }

  const targetRuntimeDir = path.join(postgresRuntimeDir, postgresRuntimePlatformSegment());
  await fs.mkdir(path.dirname(targetRuntimeDir), { recursive: true });
  await fs.cp(path.resolve(sourceBinDir, ".."), targetRuntimeDir, { recursive: true, dereference: true });
  const targetShareDir = path.join(targetRuntimeDir, "share");
  const targetTemplateDir = path.join(targetShareDir, "postgresql");
  await fs.rm(targetShareDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetTemplateDir), { recursive: true });
  await fs.cp(templateDir, targetTemplateDir, { recursive: true, dereference: true });
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
    await run(pnpmBin, ["--filter", "@rudderhq/server", "--prod", "deploy", targetDir], repoRoot, {
      env: {
        PNPM_CONFIG_FORCE_LEGACY_DEPLOY: "true",
      },
    });
  } finally {
    await restoreSourcePackageManifests(sourceManifestSnapshots);
  }
  await rewritePublishedManifest(targetDir);
  await rewriteInternalPackages(targetDir);
  await normalizeSelfReference(targetDir);
  await stagePostgresRuntimePayload();

  const deployedEntry = path.join(targetDir, "dist", "index.js");
  await fs.access(deployedEntry);
}

void main().catch((error) => {
  console.error("[desktop:stage-server] failed to stage server package", error);
  process.exit(1);
});
