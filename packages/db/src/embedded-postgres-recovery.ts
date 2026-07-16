import { execFile as execFileCb } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type SysvSharedMemorySegment = {
  id: string;
  owner: string;
  creatorPid: number;
  lastOperatorPid: number;
};

export type CleanupStaleSysvSharedMemoryResult = {
  staleIds: string[];
  removedIds: string[];
  skippedIds: string[];
};

export function createEmbeddedPostgresStartupError(
  error: unknown,
  fallbackMessage: string,
  recentLogs: string[] = [],
): Error {
  let base: Error;
  if (error instanceof Error) {
    base = error;
  } else if (error === undefined || error === null) {
    base = new Error(fallbackMessage);
  } else if (typeof error === "string") {
    base = new Error(`${fallbackMessage}: ${error}`);
  } else {
    try {
      base = new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
    } catch {
      base = new Error(`${fallbackMessage}: ${String(error)}`);
    }
  }

  const details = recentLogs.map((line) => line.trim()).filter(Boolean);
  if (details.length === 0) return base;
  const wrapped = new Error(
    `${base.message}\nRecent embedded-postgres logs:\n${details.join("\n")}`,
    { cause: base },
  );
  wrapped.name = base.name;
  if (base.stack) {
    const originalFrames = base.stack.split("\n").slice(1);
    wrapped.stack = [`${wrapped.name}: ${wrapped.message}`, ...originalFrames].join("\n");
  }
  if ("code" in base) {
    (wrapped as Error & { code?: unknown }).code = base.code;
  }
  return wrapped;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseSysvSharedMemorySegments(output: string): SysvSharedMemorySegment[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("m "))
    .map((line) => line.split(/\s+/))
    .filter((columns) => columns.length >= 8)
    .map((columns) => ({
      id: columns[1] ?? "",
      owner: columns[4] ?? "",
      creatorPid: Number(columns[6]),
      lastOperatorPid: Number(columns[7]),
    }))
    .filter((segment) => segment.id.length > 0);
}

export function isEmbeddedPostgresSharedMemoryError(
  error: unknown,
  recentLogs: string[] = [],
): boolean {
  const details: string[] = [];
  if (error instanceof Error) {
    details.push(error.message);
    if (typeof error.stack === "string") details.push(error.stack);
  } else if (error !== undefined && error !== null) {
    details.push(String(error));
  }
  details.push(...recentLogs);
  const haystack = details.join("\n");
  return /could not create shared memory segment|shmget\(|No space left on device/i.test(
    haystack,
  );
}

export async function cleanupStaleSysvSharedMemorySegments(options?: {
  username?: string;
}): Promise<CleanupStaleSysvSharedMemoryResult> {
  if (process.platform === "win32") {
    return { staleIds: [], removedIds: [], skippedIds: [] };
  }

  let stdout = "";
  try {
    ({ stdout } = await execFile("ipcs", ["-m", "-p"]));
  } catch {
    return { staleIds: [], removedIds: [], skippedIds: [] };
  }

  const username = options?.username ?? userInfo().username;
  const staleIds = parseSysvSharedMemorySegments(stdout)
    .filter(
      (segment) =>
        segment.owner === username &&
        !isProcessAlive(segment.creatorPid) &&
        !isProcessAlive(segment.lastOperatorPid),
    )
    .map((segment) => segment.id);

  const removedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const id of staleIds) {
    try {
      await execFile("ipcrm", ["-m", id]);
      removedIds.push(id);
    } catch {
      skippedIds.push(id);
    }
  }

  return { staleIds, removedIds, skippedIds };
}
