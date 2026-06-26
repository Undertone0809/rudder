#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

function executableName(name) {
  return platform === "win32" ? `${name}.exe` : name;
}

function archiveUrl() {
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
  return true;
}

function verifyVersion(candidateBinDir) {
  const postgresBinary = path.join(candidateBinDir, executableName("postgres"));
  const result = spawnSync(postgresBinary, ["--version"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0 || !/\bPostgreSQL\)?\s+18\.4\b/i.test(output)) {
    throw new Error(`unexpected PostgreSQL runtime version at ${postgresBinary}: ${output.trim() || "unknown version"}`);
  }
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

async function downloadArchive(url, targetPath) {
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
  if (await isCompleteBinDir(binDir)) {
    verifyVersion(binDir);
    console.log(binDir);
    return;
  }

  const url = archiveUrl();
  const workDir = path.join(runtimeRoot, ".download");
  const archivePath = path.join(workDir, `postgresql-${POSTGRES_VERSION}.zip`);
  const extractDir = path.join(workDir, "extract");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  console.error(`[postgres-runtime] downloading PostgreSQL ${POSTGRES_VERSION} runtime for ${platform}-${arch} from ${url}`);
  console.error(`[postgres-runtime] first download can be several hundred MB; cache target: ${binDir}`);
  await downloadArchive(url, archivePath);
  extractArchive(archivePath, extractDir);

  const extractedBinDir = await findBinDir(extractDir);
  if (!extractedBinDir) {
    throw new Error(`PostgreSQL ${POSTGRES_VERSION} archive did not contain initdb, pg_ctl, and postgres binaries`);
  }
  verifyVersion(extractedBinDir);

  await rm(binDir, { recursive: true, force: true });
  await mkdir(path.dirname(binDir), { recursive: true });
  const copyResult = spawnSync(process.execPath, [
    "-e",
    "require('node:fs').cpSync(process.argv[1], process.argv[2], { recursive: true, dereference: true })",
    extractedBinDir,
    binDir,
  ], { encoding: "utf8" });
  if (copyResult.status !== 0) {
    throw new Error(`failed to cache PostgreSQL runtime payload: ${copyResult.stderr || copyResult.stdout}`);
  }
  await rm(workDir, { recursive: true, force: true });

  console.log(binDir);
}

void main().catch((error) => {
  console.error("[postgres-runtime] failed to prepare PostgreSQL runtime", error);
  process.exit(1);
});
