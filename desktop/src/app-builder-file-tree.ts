import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface SafeTreeLimits {
  maxDepth: number;
  maxEntries: number;
  maxBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_SAFE_TREE_LIMITS: SafeTreeLimits = {
  maxDepth: 32,
  maxEntries: 4_096,
  maxBytes: 512 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
};

interface CopyBudget {
  entries: number;
  bytes: number;
}

function assertWithinLimits(
  relativePath: string,
  fileBytes: number,
  depth: number,
  budget: CopyBudget,
  limits: SafeTreeLimits,
): void {
  if (depth > limits.maxDepth) {
    throw new Error(`directory tree exceeds maximum depth at ${relativePath}`);
  }
  budget.entries += 1;
  budget.bytes += fileBytes;
  if (budget.entries > limits.maxEntries) {
    throw new Error("directory tree contains too many entries");
  }
  if (fileBytes > limits.maxFileBytes) {
    throw new Error(`file is too large: ${relativePath}`);
  }
  if (budget.bytes > limits.maxBytes) {
    throw new Error("directory tree is too large");
  }
}

async function copyEntry(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
  depth: number,
  budget: CopyBudget,
  limits: SafeTreeLimits,
  includeEntry: (relativePath: string, directory: boolean) => boolean,
): Promise<void> {
  const source = relativePath ? path.join(sourceRoot, relativePath) : sourceRoot;
  const target = relativePath ? path.join(targetRoot, relativePath) : targetRoot;
  const entryStat = await lstat(source);
  if (entryStat.isSymbolicLink()) {
    throw new Error(`symbolic links are not supported: ${relativePath || "."}`);
  }
  if (relativePath && !includeEntry(relativePath, entryStat.isDirectory())) {
    return;
  }
  if (entryStat.isDirectory()) {
    if (relativePath) {
      assertWithinLimits(relativePath, 0, depth, budget, limits);
      await mkdir(target, { mode: entryStat.mode & 0o777 });
    }
    const directoryHandle = await open(
      source,
      fsConstants.O_RDONLY
        | (fsConstants.O_DIRECTORY ?? 0)
        | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const names: string[] = [];
    try {
      const openedStat = await directoryHandle.stat();
      if (
        !openedStat.isDirectory()
        || openedStat.dev !== entryStat.dev
        || openedStat.ino !== entryStat.ino
      ) {
        throw new Error(`source directory changed while copying: ${relativePath || "."}`);
      }
      names.push(...await readdir(source));
      const finalStat = await lstat(source);
      if (finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino) {
        throw new Error(`source directory changed while copying: ${relativePath || "."}`);
      }
    } finally {
      await directoryHandle.close();
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      await copyEntry(
        sourceRoot,
        targetRoot,
        relativePath ? path.join(relativePath, name) : name,
        depth + 1,
        budget,
        limits,
        includeEntry,
      );
    }
    return;
  }
  if (!entryStat.isFile()) {
    throw new Error(`unsupported filesystem entry: ${relativePath}`);
  }
  assertWithinLimits(relativePath, entryStat.size, depth, budget, limits);
  const sourceHandle = await open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const openedStat = await sourceHandle.stat();
    if (!openedStat.isFile() || openedStat.size !== entryStat.size) {
      throw new Error(`source changed while copying: ${relativePath}`);
    }
    targetHandle = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      entryStat.mode & 0o777,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const finalStat = await sourceHandle.stat();
    if (
      finalStat.ino !== openedStat.ino
      || finalStat.size !== openedStat.size
      || finalStat.mtimeMs !== openedStat.mtimeMs
    ) {
      throw new Error(`source changed while copying: ${relativePath}`);
    }
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await targetHandle?.close().catch(() => undefined);
  }
  await chmod(target, entryStat.mode & 0o777);
}

export async function copyDirectoryWithoutLinks(
  sourceRoot: string,
  targetRoot: string,
  limits: SafeTreeLimits = DEFAULT_SAFE_TREE_LIMITS,
  includeEntry: (relativePath: string, directory: boolean) => boolean = () => true,
): Promise<{ entries: number; bytes: number }> {
  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new Error("source must be a directory");
  }
  await mkdir(targetRoot, { recursive: false });
  const budget: CopyBudget = { entries: 0, bytes: 0 };
  try {
    await copyEntry(sourceRoot, targetRoot, "", 0, budget, limits, includeEntry);
    return budget;
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function replaceDirectoryAtomically(
  targetRoot: string,
  stagedRoot: string,
  backupRoot: string,
): Promise<void> {
  let targetMoved = false;
  try {
    await rename(targetRoot, backupRoot);
    targetMoved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await rename(stagedRoot, targetRoot);
  } catch (error) {
    if (targetMoved) {
      await rename(backupRoot, targetRoot);
    }
    throw error;
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readJsonFileBounded(filePath: string, maxBytes = 64 * 1024): Promise<unknown> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxBytes) {
    throw new Error("invalid JSON metadata file");
  }
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}
