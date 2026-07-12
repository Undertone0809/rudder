import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_SNAPSHOT_BYTES = 1024n * 1024n * 1024n;
const BROWSER_IMPORT_OWNER_ID = /^[a-f0-9]{64}$/;
const BROWSER_PARTITION = /^persist:rudder-browser-v1-([a-f0-9]{64})$/;
const BROWSER_IMPORT_TEMP_DIRECTORY_PREFIX = "rudder-browser-import-v1-";
const BROWSER_IMPORT_TEMP_DIRECTORY_SUFFIX = /^[A-Za-z0-9]{6}$/;
const BROWSER_IMPORT_OWNER_MARKER_NAME = ".rudder-browser-import-owner-v1.json";

export const BROWSER_SOURCE_OPEN_ERROR_CODE = "BROWSER_SOURCE_OPEN" as const;

export class BrowserImportSourceOpenError extends Error {
  readonly code = BROWSER_SOURCE_OPEN_ERROR_CODE;

  constructor() {
    super("Close the source browser before importing its data.");
    this.name = "BrowserImportSourceOpenError";
  }
}

export function isBrowserImportSourceOpenError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === BROWSER_SOURCE_OPEN_ERROR_CODE;
}

export type BrowserCookieDatabaseSnapshot = {
  tempDirectory: string;
  databasePath: string;
  cleanup(): Promise<void>;
};

async function createPrivateTempDirectory(tempRoot: string, prefix: string): Promise<string> {
  const tempDirectory = await fs.mkdtemp(path.join(tempRoot, prefix));
  try {
    await fs.chmod(tempDirectory, 0o700);
    return tempDirectory;
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

function requireBrowserImportOwnerId(ownerId: string): string {
  if (!BROWSER_IMPORT_OWNER_ID.test(ownerId)) {
    throw new Error("A valid Rudder Browser import owner id is required.");
  }
  return ownerId;
}

export function deriveBrowserImportOwnerId(browserPartition: string): string {
  const match = BROWSER_PARTITION.exec(browserPartition);
  if (!match?.[1]) throw new Error("A valid Rudder Browser partition is required.");
  return match[1];
}

export async function createPrivateBrowserImportTempDirectory(options: {
  ownerId: string;
  tempRoot?: string;
  pid?: number;
}): Promise<string> {
  const ownerId = requireBrowserImportOwnerId(options.ownerId);
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("A valid Rudder Browser import owner process is required.");
  }
  const tempDirectory = await createPrivateTempDirectory(
    options.tempRoot ?? os.tmpdir(),
    `${BROWSER_IMPORT_TEMP_DIRECTORY_PREFIX}${ownerId}-`,
  );
  const markerPath = path.join(tempDirectory, BROWSER_IMPORT_OWNER_MARKER_NAME);
  let markerHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    markerHandle = await fs.open(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await markerHandle.writeFile(JSON.stringify({ version: 1, ownerId, pid }), "utf8");
    await markerHandle.sync();
    await markerHandle.close();
    markerHandle = null;
    await fs.chmod(markerPath, 0o600);
    return tempDirectory;
  } catch (error) {
    await markerHandle?.close().catch(() => undefined);
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

type BrowserImportOwnerMarker = {
  version: 1;
  ownerId: string;
  pid: number;
};

async function readBrowserImportOwnerMarker(directory: string): Promise<BrowserImportOwnerMarker | null> {
  let markerHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    markerHandle = await fs.open(
      path.join(directory, BROWSER_IMPORT_OWNER_MARKER_NAME),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stats = await markerHandle.stat();
    if (!stats.isFile() || stats.size > 4096) return null;
    const parsed = JSON.parse(await markerHandle.readFile("utf8")) as Partial<BrowserImportOwnerMarker>;
    if (parsed.version !== 1
      || typeof parsed.ownerId !== "string"
      || !BROWSER_IMPORT_OWNER_ID.test(parsed.ownerId)
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0) {
      return null;
    }
    return parsed as BrowserImportOwnerMarker;
  } catch {
    return null;
  } finally {
    await markerHandle?.close().catch(() => undefined);
  }
}

function isBrowserImportOwnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function cleanupStaleBrowserImportTempDirectories(options: {
  ownerId: string;
  tempRoot?: string;
  currentUid?: number;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}): Promise<void> {
  const ownerId = requireBrowserImportOwnerId(options.ownerId);
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const currentUid = options.currentUid ?? process.getuid?.();
  const ownedPrefix = `${BROWSER_IMPORT_TEMP_DIRECTORY_PREFIX}${ownerId}-`;
  const isProcessAlive = options.isProcessAlive ?? isBrowserImportOwnerProcessAlive;
  const entries = await fs.readdir(tempRoot, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const suffix = entry.name.startsWith(ownedPrefix) ? entry.name.slice(ownedPrefix.length) : "";
    if (!BROWSER_IMPORT_TEMP_DIRECTORY_SUFFIX.test(suffix) || !entry.isDirectory() || entry.isSymbolicLink()) {
      return;
    }
    const candidate = path.join(tempRoot, entry.name);
    const stats = await fs.lstat(candidate).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return;
    if (currentUid !== undefined && stats.uid !== currentUid) return;
    const marker = await readBrowserImportOwnerMarker(candidate);
    if (!marker || marker.ownerId !== ownerId) return;
    try {
      if (await isProcessAlive(marker.pid)) return;
    } catch {
      return;
    }
    await fs.rm(candidate, { recursive: true, force: true });
  }));
}

type StableFileMetadata = {
  sourcePath: string;
  suffix: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

async function readStableFileMetadata(sourcePath: string, suffix: string): Promise<StableFileMetadata | null> {
  const candidate = `${sourcePath}${suffix}`;
  try {
    const stats = await fs.lstat(candidate, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Browser Cookie database files must be regular files.");
    }
    return {
      sourcePath: candidate,
      suffix,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
    };
  } catch (error) {
    if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function metadataMatches(left: StableFileMetadata, right: StableFileMetadata): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readSourceFileSet(sourcePath: string): Promise<StableFileMetadata[]> {
  return (await Promise.all([
    readStableFileMetadata(sourcePath, ""),
    readStableFileMetadata(sourcePath, "-wal"),
    readStableFileMetadata(sourcePath, "-shm"),
  ])).filter((item): item is StableFileMetadata => item !== null);
}

async function copyWithoutFollowingSymlinks(
  source: StableFileMetadata,
  destination: string,
): Promise<void> {
  if (source.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The source browser Cookie database is too large to import safely.");
  }
  const sourceHandle = await fs.open(source.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const openedStats = await sourceHandle.stat({ bigint: true });
    const openedMetadata: StableFileMetadata = {
      sourcePath: source.sourcePath,
      suffix: source.suffix,
      dev: openedStats.dev,
      ino: openedStats.ino,
      size: openedStats.size,
      mtimeNs: openedStats.mtimeNs,
      ctimeNs: openedStats.ctimeNs,
    };
    if (!openedStats.isFile() || !metadataMatches(source, openedMetadata)) {
      throw new Error("The source browser data changed during import.");
    }
    destinationHandle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let position = 0;
    const expectedBytes = Number(source.size);
    while (position < expectedBytes) {
      const bytesRemaining = expectedBytes - position;
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, bytesRemaining), position);
      if (bytesRead === 0) throw new Error("The source browser data changed during import.");
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const finishedStats = await sourceHandle.stat({ bigint: true });
    const finishedMetadata: StableFileMetadata = {
      sourcePath: source.sourcePath,
      suffix: source.suffix,
      dev: finishedStats.dev,
      ino: finishedStats.ino,
      size: finishedStats.size,
      mtimeNs: finishedStats.mtimeNs,
      ctimeNs: finishedStats.ctimeNs,
    };
    if (!metadataMatches(source, finishedMetadata)) {
      throw new Error("The source browser data changed during import.");
    }
    await destinationHandle.sync();
  } finally {
    buffer.fill(0);
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

export async function isAnyBrowserDatabasePathOpen(paths: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn("/usr/sbin/lsof", ["-t", "--", ...paths], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("Unable to verify whether the source browser is closed.")));
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error("Unable to verify whether the source browser is closed."));
      } else if (code === 0) {
        resolve(true);
      } else if (code === 1) {
        resolve(false);
      } else {
        reject(new Error("Unable to verify whether the source browser is closed."));
      }
    });
  });
}

export async function createStableCookieDatabaseSnapshot(options: {
  sourcePath: string;
  tempDirectory?: string;
  isAnyPathOpen?: (paths: string[]) => Promise<boolean>;
  copyFile?: (source: string, destination: string, expectedSize: bigint) => Promise<void>;
  onTempDirectory?: (tempDirectory: string) => void;
  maxTotalBytes?: bigint;
}): Promise<BrowserCookieDatabaseSnapshot> {
  const sourceFiles = await readSourceFileSet(options.sourcePath);
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.size, 0n);
  if (totalBytes > (options.maxTotalBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES)) {
    throw new Error("The source browser Cookie database is too large to import safely.");
  }
  const sourcePaths = sourceFiles.map((item) => item.sourcePath);
  const isAnyPathOpen = options.isAnyPathOpen ?? isAnyBrowserDatabasePathOpen;
  if (await isAnyPathOpen(sourcePaths)) {
    throw new BrowserImportSourceOpenError();
  }

  const tempDirectory = options.tempDirectory
    ?? await createPrivateTempDirectory(os.tmpdir(), "rudder-browser-snapshot-");
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  };

  try {
    options.onTempDirectory?.(tempDirectory);
    await fs.chmod(tempDirectory, 0o700);
    const destinationBase = path.join(tempDirectory, path.basename(options.sourcePath));
    for (const sourceFile of sourceFiles) {
      const destination = `${destinationBase}${sourceFile.suffix}`;
      if (options.copyFile) {
        await options.copyFile(sourceFile.sourcePath, destination, sourceFile.size);
      } else {
        await copyWithoutFollowingSymlinks(sourceFile, destination);
      }
      await fs.chmod(destination, 0o600);
    }

    const afterFiles = await readSourceFileSet(options.sourcePath);
    if (afterFiles.length !== sourceFiles.length
      || afterFiles.some((after, index) => after.suffix !== sourceFiles[index]?.suffix
        || !metadataMatches(sourceFiles[index]!, after))) {
      throw new Error("The source browser data changed during import.");
    }
    if (await isAnyPathOpen(sourcePaths)) {
      throw new BrowserImportSourceOpenError();
    }

    return { tempDirectory, databasePath: destinationBase, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
