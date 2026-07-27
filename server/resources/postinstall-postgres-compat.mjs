import {
  cpSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POSTGRES_RUNTIME_DIR = "postgres-18.4";

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function pathIsInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function addCandidate(candidates, binDir, rudderHome) {
  if (!binDir?.trim()) return;
  const resolved = path.resolve(binDir.trim());
  if (!pathIsInside(resolved, rudderHome)) return;
  candidates.add(resolved);
}

function resolveManagedPostgresBinDirs({ env, homeDir, platform, arch }) {
  const rudderHome = path.resolve(env.RUDDER_HOME?.trim() || path.join(homeDir, ".rudder"));
  const candidates = new Set();
  addCandidate(candidates, env.RUDDER_POSTGRES_BIN_DIR, rudderHome);
  addCandidate(candidates, env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR, rudderHome);
  addCandidate(
    candidates,
    path.join(
      rudderHome,
      "runtime-payloads",
      POSTGRES_RUNTIME_DIR,
      `${platform}-${arch}`,
      "bin",
    ),
    rudderHome,
  );

  const runtimesRoot = path.join(rudderHome, "runtimes");
  let runtimeEntries = [];
  try {
    runtimeEntries = readdirSync(runtimesRoot, { withFileTypes: true });
  } catch {
    runtimeEntries = [];
  }
  for (const entry of runtimeEntries.filter(
    (candidate) => candidate.isDirectory() || candidate.isSymbolicLink(),
  )) {
    addCandidate(
      candidates,
      path.join(
        runtimesRoot,
        entry.name,
        POSTGRES_RUNTIME_DIR,
        `${platform}-${arch}`,
        "bin",
      ),
      rudderHome,
    );
  }
  return [...candidates];
}

function ensureTimezoneAlias(binDir, platform, rudderHome) {
  const runtimeRoot = path.resolve(binDir, "..");
  const nestedTimezoneDir = path.join(runtimeRoot, "share", "postgresql", "timezone");
  const legacyTimezoneDir = path.join(runtimeRoot, "share", "timezone");
  if (!isDirectory(nestedTimezoneDir)) return { status: "not_applicable", binDir };
  try {
    const canonicalHome = realpathSync(rudderHome);
    if (
      !pathIsInside(realpathSync(binDir), canonicalHome)
      || !pathIsInside(realpathSync(nestedTimezoneDir), canonicalHome)
    ) {
      return { status: "outside_managed_home", binDir };
    }
  } catch {
    return { status: "blocked", binDir };
  }
  if (pathExists(legacyTimezoneDir)) {
    return {
      status: isDirectory(legacyTimezoneDir) ? "already_compatible" : "blocked",
      binDir,
    };
  }

  try {
    symlinkSync(
      platform === "win32"
        ? nestedTimezoneDir
        : path.relative(path.dirname(legacyTimezoneDir), nestedTimezoneDir),
      legacyTimezoneDir,
      platform === "win32" ? "junction" : "dir",
    );
    return { status: "linked", binDir };
  } catch {
    const stagedTimezoneDir = `${legacyTimezoneDir}.rudder-stage-${process.pid}-${Date.now()}`;
    try {
      cpSync(nestedTimezoneDir, stagedTimezoneDir, { recursive: true });
      renameSync(stagedTimezoneDir, legacyTimezoneDir);
      return { status: "copied", binDir };
    } catch (error) {
      rmSync(stagedTimezoneDir, { recursive: true, force: true });
      if (isDirectory(legacyTimezoneDir)) {
        return { status: "already_compatible", binDir };
      }
      throw error;
    }
  }
}

export function ensureLegacyPostgresTimezoneCompatibility(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const rudderHome = path.resolve(env.RUDDER_HOME?.trim() || path.join(homeDir, ".rudder"));
  const results = [];
  for (const binDir of resolveManagedPostgresBinDirs({
    env,
    homeDir,
    platform,
    arch,
  })) {
    try {
      results.push(ensureTimezoneAlias(binDir, platform, rudderHome));
    } catch (error) {
      results.push({
        status: "failed",
        binDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

export function isInstalledServerPackage(moduleDir = path.dirname(fileURLToPath(import.meta.url))) {
  const packageRoot = path.resolve(moduleDir, "..");
  return path.basename(packageRoot) === "server"
    && path.basename(path.dirname(packageRoot)) === "@rudderhq"
    && path.basename(path.dirname(path.dirname(packageRoot))) === "node_modules";
}

if (isDirectExecution() && isInstalledServerPackage()) {
  const repaired = ensureLegacyPostgresTimezoneCompatibility().filter(
    (result) => result.status === "linked" || result.status === "copied",
  );
  if (repaired.length > 0) {
    console.log("[rudder] prepared PostgreSQL runtime compatibility for older Desktop updaters");
  }
}
