#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POSTGRES_VERSION = "18.4";
const runtimeDirName = `postgres-${POSTGRES_VERSION}`;
const platform = process.platform;
const arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
const cacheRoot = process.env.RUDDER_POSTGRES_RUNTIME_CACHE_DIR
  ? path.resolve(process.env.RUDDER_POSTGRES_RUNTIME_CACHE_DIR)
  : path.join(os.homedir(), ".rudder", "runtime-payloads");
const runtimeRoot = path.join(cacheRoot, runtimeDirName, `${platform}-${arch}`);
const binDir = path.join(runtimeRoot, "bin");
const downloadTimeoutMs = Number.parseInt(process.env.RUDDER_POSTGRES_RUNTIME_DOWNLOAD_TIMEOUT_MS ?? "600000", 10);
const installLockPath = `${runtimeRoot}.install.lock`;
const lifecycleLockPath = path.join(cacheRoot, ".postgres-runtime.lifecycle.lock");

function executableName(name) {
  return platform === "win32" ? `${name}.exe` : name;
}

function archiveUrl() {
  if (process.env.RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL) {
    return process.env.RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL;
  }
  if (platform === "win32") {
    if (arch !== "x64") throw new Error(`PostgreSQL ${POSTGRES_VERSION} Windows payload is only configured for x64; got ${arch}`);
    return `https://get.enterprisedb.com/postgresql/postgresql-${POSTGRES_VERSION}-1-windows-x64-binaries.zip`;
  }
  if (platform === "darwin") {
    return `https://get.enterprisedb.com/postgresql/postgresql-${POSTGRES_VERSION}-1-osx-binaries.zip`;
  }
  throw new Error(`Automatic PostgreSQL ${POSTGRES_VERSION} runtime provisioning is not configured for ${platform}-${arch}`);
}

async function isCompleteBinDir(candidateBinDir) {
  for (const name of ["initdb", "pg_ctl", "postgres"]) {
    try {
      await stat(path.join(candidateBinDir, executableName(name)));
    } catch {
      return false;
    }
  }
  for (const candidatePath of [
    path.join(candidateBinDir, "..", "share", "postgresql", "postgres.bki"),
    path.join(candidateBinDir, "..", "share", "postgres.bki"),
  ]) {
    try {
      await stat(candidatePath);
      await stat(path.join(path.dirname(candidatePath), "postgresql.conf.sample"));
      return true;
    } catch {
      // Try the next supported PostgreSQL archive layout.
    }
  }
  return false;
}

function verifyVersion(candidateBinDir) {
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    const binaryPath = path.join(candidateBinDir, executableName(binary));
    const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status !== 0 || !/\bPostgreSQL\)?\s+18\.4\b/i.test(output)) {
      throw new Error(`unexpected PostgreSQL runtime version at ${binaryPath}: ${output.trim() || "unknown version"}`);
    }
  }
}

function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireFilesystemLock(lockPath) {
  const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerPath = path.join(lockPath, "owner.json");
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, lockId, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        if (typeof owner.pid !== "number" || !pidIsRunning(owner.pid)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        const lockStats = await stat(lockPath).catch(() => null);
        if (lockStats && Date.now() - lockStats.mtimeMs > 5_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      }
      if (Date.now() - startedAt > 30_000) {
        throw new Error(`timed out waiting for PostgreSQL runtime lock ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return async () => {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      if (owner.lockId === lockId) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // The lock was replaced or already released.
    }
  };
}

async function findBinDir(rootDir) {
  const queue = [rootDir];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && entry.name === executableName("postgres"))) {
      if (await isCompleteBinDir(current)) return current;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

async function isUsableRuntimeRoot(candidateRoot) {
  const candidateBinDir = path.join(candidateRoot, "bin");
  if (!await isCompleteBinDir(candidateBinDir)) return false;
  try {
    verifyVersion(candidateBinDir);
    return true;
  } catch {
    return false;
  }
}

async function reconcileInterruptedGenerations() {
  const parentDir = path.dirname(runtimeRoot);
  const baseName = path.basename(runtimeRoot);
  const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => []);
  const previousRoots = entries
    .filter((entry) => entry.name.startsWith(`${baseName}.previous-`))
    .map((entry) => path.join(parentDir, entry.name))
    .sort()
    .reverse();
  const staleWorkDirs = entries
    .filter((entry) => entry.name.startsWith(`.${baseName}.download-`))
    .map((entry) => path.join(parentDir, entry.name));

  if (!await isUsableRuntimeRoot(runtimeRoot)) {
    for (const previousRoot of previousRoots) {
      if (!await isUsableRuntimeRoot(previousRoot)) continue;
      await rm(runtimeRoot, { recursive: true, force: true });
      await rename(previousRoot, runtimeRoot);
      break;
    }
  }

  await Promise.all([
    ...previousRoots.map((candidate) => rm(candidate, { recursive: true, force: true })),
    ...staleWorkDirs.map((candidate) => rm(candidate, { recursive: true, force: true })),
  ]);
}

async function materializeSymlinks(currentDir) {
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      const resolvedPath = await realpath(entryPath);
      const resolvedStats = await stat(resolvedPath);
      await rm(entryPath, { recursive: true, force: true });
      if (resolvedStats.isDirectory()) {
        await cp(resolvedPath, entryPath, { recursive: true, dereference: true });
        await materializeSymlinks(entryPath);
      } else {
        await copyFile(resolvedPath, entryPath);
      }
      continue;
    }

    if (entry.isDirectory()) {
      await materializeSymlinks(entryPath);
    }
  }
}

async function downloadArchive(url, targetPath) {
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), targetPath);
    return;
  }

  const abortController = new AbortController();
  const timeout = Number.isFinite(downloadTimeoutMs) && downloadTimeoutMs > 0
    ? setTimeout(() => abortController.abort(), downloadTimeoutMs)
    : null;
  let response;
  try {
    response = await fetch(url, { signal: abortController.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`timed out downloading ${url} after ${downloadTimeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

function extractArchive(archivePath, extractDir) {
  const result = platform === "win32"
    ? spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:PG_ARCHIVE_PATH -DestinationPath $env:PG_EXTRACT_DIR -Force",
      ], {
        encoding: "utf8",
        env: { ...process.env, PG_ARCHIVE_PATH: archivePath, PG_EXTRACT_DIR: extractDir },
      })
    : spawnSync("tar", ["-xf", archivePath, "-C", extractDir], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`failed to extract PostgreSQL archive: ${result.stderr || result.stdout}`);
  }
}

async function main() {
  const releaseLifecycleLock = await acquireFilesystemLock(lifecycleLockPath);
  try {
    const releaseInstallLock = await acquireFilesystemLock(installLockPath);
    try {
      await reconcileInterruptedGenerations();
      if (await isCompleteBinDir(binDir)) {
        verifyVersion(binDir);
        console.log(binDir);
        return;
      }
      const url = archiveUrl();
      const workDir = path.join(path.dirname(runtimeRoot), `.${path.basename(runtimeRoot)}.download-${process.pid}`);
      const archivePath = path.join(workDir, `postgresql-${POSTGRES_VERSION}.zip`);
      const extractDir = path.join(workDir, "extract");
      const stagedRuntimeRoot = path.join(workDir, "prepared");
      const previousRuntimeRoot = `${runtimeRoot}.previous-${process.pid}-${Date.now()}`;
      await rm(workDir, { recursive: true, force: true });
      await rm(previousRuntimeRoot, { recursive: true, force: true });
      await mkdir(extractDir, { recursive: true });

      try {
        console.error(`[postgres-runtime] downloading PostgreSQL ${POSTGRES_VERSION} runtime for ${platform}-${arch} from ${url}`);
        console.error(`[postgres-runtime] first download can be several hundred MB; cache target: ${binDir}`);
        await downloadArchive(url, archivePath);
        extractArchive(archivePath, extractDir);

        const extractedBinDir = await findBinDir(extractDir);
        if (!extractedBinDir) {
          throw new Error(`PostgreSQL ${POSTGRES_VERSION} archive did not contain initdb, pg_ctl, and postgres binaries`);
        }
        verifyVersion(extractedBinDir);

        const extractedRuntimeRoot = path.dirname(extractedBinDir);
        await mkdir(stagedRuntimeRoot, { recursive: true });
        const copyResult = spawnSync(process.execPath, [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "for (const name of ['bin', 'lib', 'share']) {",
            "  const source = path.join(process.argv[1], name);",
            "  if (fs.existsSync(source)) fs.cpSync(source, path.join(process.argv[2], name), { recursive: true, dereference: true });",
            "}",
          ].join(" "),
          extractedRuntimeRoot,
          stagedRuntimeRoot,
        ], { encoding: "utf8" });
        if (copyResult.status !== 0) {
          throw new Error(`failed to cache PostgreSQL runtime payload: ${copyResult.stderr || copyResult.stdout}`);
        }
        await materializeSymlinks(path.join(stagedRuntimeRoot, "bin"));
        await materializeSymlinks(path.join(stagedRuntimeRoot, "lib"));
        await materializeSymlinks(path.join(stagedRuntimeRoot, "share"));
        if (!await isCompleteBinDir(path.join(stagedRuntimeRoot, "bin"))) {
          throw new Error("prepared PostgreSQL runtime is incomplete");
        }
        verifyVersion(path.join(stagedRuntimeRoot, "bin"));

        let previousMoved = false;
        try {
          await rename(runtimeRoot, previousRuntimeRoot);
          previousMoved = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        try {
          await rename(stagedRuntimeRoot, runtimeRoot);
        } catch (error) {
          if (previousMoved) await rename(previousRuntimeRoot, runtimeRoot);
          throw error;
        }
        await rm(previousRuntimeRoot, { recursive: true, force: true });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
      console.log(binDir);
    } finally {
      await releaseInstallLock();
    }
  } finally {
    await releaseLifecycleLock();
  }
}

void main().catch((error) => {
  console.error("[postgres-runtime] failed to prepare PostgreSQL runtime", error);
  process.exit(1);
});
