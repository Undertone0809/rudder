import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_SNAPSHOT_BYTES = 1024n * 1024n * 1024n;

export type BrowserCookieDatabaseSnapshot = {
  tempDirectory: string;
  databasePath: string;
  cleanup(): Promise<void>;
};

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
    throw new Error("Close the source browser before importing its data.");
  }

  const tempDirectory = options.tempDirectory
    ?? await fs.mkdtemp(path.join(os.tmpdir(), "rudder-browser-import-"));
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
      throw new Error("Close the source browser before importing its data.");
    }

    return { tempDirectory, databasePath: destinationBase, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
