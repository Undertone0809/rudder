import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const DEFAULT_MAX_SNAPSHOT_BYTES = 1024n * 1024n * 1024n;
const BROWSER_IMPORT_OWNER_ID = /^[a-f0-9]{64}$/;
const BROWSER_PARTITION = /^persist:rudder-browser-v1-([a-f0-9]{64})$/;
const BROWSER_IMPORT_TEMP_DIRECTORY_PREFIX = "rudder-browser-import-v1-";
const BROWSER_IMPORT_TEMP_DIRECTORY_SUFFIX = /^[A-Za-z0-9]{6}$/;
const BROWSER_IMPORT_OWNER_MARKER_NAME = ".rudder-browser-import-owner-v1.json";

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

type SourceFileMetadata = {
  size: bigint;
};

async function readSourceFileMetadata(sourcePath: string, suffix: string): Promise<SourceFileMetadata | null> {
  const candidate = `${sourcePath}${suffix}`;
  try {
    const stats = await fs.lstat(candidate, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Browser Cookie database files must be regular files.");
    }
    return { size: stats.size };
  } catch (error) {
    if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readSourceFileSet(sourcePath: string): Promise<SourceFileMetadata[]> {
  return (await Promise.all([
    readSourceFileMetadata(sourcePath, ""),
    readSourceFileMetadata(sourcePath, "-wal"),
    readSourceFileMetadata(sourcePath, "-shm"),
  ])).filter((item): item is SourceFileMetadata => item !== null);
}

async function backupLiveDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
  try {
    source.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    await backup(source, destinationPath, { rate: 64 });
  } finally {
    source.close();
  }
}

export async function createStableCookieDatabaseSnapshot(options: {
  sourcePath: string;
  tempDirectory?: string;
  backupDatabase?: (sourcePath: string, destinationPath: string) => Promise<void>;
  onTempDirectory?: (tempDirectory: string) => void;
  maxTotalBytes?: bigint;
}): Promise<BrowserCookieDatabaseSnapshot> {
  const sourceFiles = await readSourceFileSet(options.sourcePath);
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.size, 0n);
  if (totalBytes > (options.maxTotalBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES)) {
    throw new Error("The source browser Cookie database is too large to import safely.");
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
    await (options.backupDatabase ?? backupLiveDatabase)(options.sourcePath, destinationBase);
    const destinationStats = await fs.lstat(destinationBase, { bigint: true });
    if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
      throw new Error("Browser Cookie database snapshots must be regular files.");
    }
    if (destinationStats.size > (options.maxTotalBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES)) {
      throw new Error("The source browser Cookie database is too large to import safely.");
    }
    await fs.chmod(destinationBase, 0o600);

    return { tempDirectory, databasePath: destinationBase, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
