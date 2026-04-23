import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRudderHomeDir, resolveRudderInstanceId } from "./home-paths.js";

export const LOCAL_RUNTIME_OWNER_KINDS = ["cli", "desktop", "dev_runner", "server"] as const;

export type LocalRuntimeOwnerKind = (typeof LOCAL_RUNTIME_OWNER_KINDS)[number];

export type LocalRuntimeDescriptor = {
  instanceId: string;
  localEnv: string | null;
  pid: number;
  listenPort: number;
  apiUrl: string;
  version: string;
  ownerKind: LocalRuntimeOwnerKind;
  startedAt: string;
};

export type RuntimeHealthSnapshot = {
  status: "ok";
  version?: string;
  instanceId?: string;
  localEnv?: string | null;
  runtimeOwnerKind?: LocalRuntimeOwnerKind | null;
};

export type LocalRuntimePaths = {
  runtimeDir: string;
  descriptorPath: string;
  lockPath: string;
};

export type LocalRuntimeProbe =
  | { kind: "missing" }
  | {
      kind: "unusable";
      reason: "invalid_descriptor" | "pid_dead" | "health_unreachable" | "health_mismatch";
      descriptor?: LocalRuntimeDescriptor;
      health?: RuntimeHealthSnapshot | null;
    }
  | {
      kind: "healthy";
      descriptor: LocalRuntimeDescriptor;
      health: RuntimeHealthSnapshot;
      versionMatches: boolean;
    };

const START_LOCK_STALE_MS = 30_000;
const START_LOCK_POLL_MS = 250;

function normalizeString(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeStageToken(value: string | null | undefined): string | null {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.toLowerCase().replace(/[\s-]+/g, "_");
}

export function parseRuntimeOwnerKind(value: string | null | undefined): LocalRuntimeOwnerKind | null {
  const normalized = normalizeString(value)?.toLowerCase().replace(/-/g, "_");
  return (LOCAL_RUNTIME_OWNER_KINDS as readonly string[]).includes(normalized ?? "")
    ? (normalized as LocalRuntimeOwnerKind)
    : null;
}

export function resolveRuntimeOwnerKind(value: string | null | undefined = process.env.RUDDER_RUNTIME_OWNER_KIND): LocalRuntimeOwnerKind | null {
  return parseRuntimeOwnerKind(value);
}

export function inferLocalEnvFromInstanceId(instanceId: string): string | null {
  const normalized = instanceId.trim();
  if (normalized === "default") return "prod_local";
  if (normalized === "dev") return "dev";
  if (normalized === "e2e") return "e2e";
  return null;
}

export function resolveEffectiveLocalEnvName(
  instanceId = resolveRudderInstanceId(),
  value: string | null | undefined = process.env.RUDDER_LOCAL_ENV,
): string | null {
  return normalizeString(value) ?? inferLocalEnvFromInstanceId(instanceId);
}

export function normalizeLangfuseEnvironmentName(value: string | null | undefined): string | null {
  const normalized = normalizeStageToken(value);
  if (!normalized) return null;

  switch (normalized) {
    case "default":
    case "local":
    case "prod":
    case "prod_local":
    case "production":
      return "prod";
    case "dev":
    case "development":
      return "dev";
    case "e2e":
    case "test":
    case "testing":
      return "e2e";
    default:
      return normalizeString(value);
  }
}

export function resolveCanonicalStageName(value: string | null | undefined): string | null {
  return normalizeLangfuseEnvironmentName(value);
}

export function resolveLangfuseEnvironmentName(
  value: string | null | undefined,
  fallbackLocalEnv: string | null | undefined = null,
): string | null {
  return normalizeLangfuseEnvironmentName(value) ?? resolveCanonicalStageName(fallbackLocalEnv);
}

export function resolveLocalRuntimePaths(instanceId = resolveRudderInstanceId()): LocalRuntimePaths {
  const runtimeDir = path.resolve(resolveRudderHomeDir(), "instances", instanceId, "runtime");
  return {
    runtimeDir,
    descriptorPath: path.resolve(runtimeDir, "server.json"),
    lockPath: path.resolve(runtimeDir, "start.lock"),
  };
}

function isValidRuntimeDescriptor(value: unknown): value is LocalRuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.instanceId === "string"
    && (candidate.localEnv === null || typeof candidate.localEnv === "string")
    && typeof candidate.pid === "number"
    && Number.isInteger(candidate.pid)
    && candidate.pid > 0
    && typeof candidate.listenPort === "number"
    && Number.isInteger(candidate.listenPort)
    && candidate.listenPort > 0
    && typeof candidate.apiUrl === "string"
    && typeof candidate.version === "string"
    && parseRuntimeOwnerKind(typeof candidate.ownerKind === "string" ? candidate.ownerKind : null) !== null
    && typeof candidate.startedAt === "string";
}

export async function readLocalRuntimeDescriptor(instanceId = resolveRudderInstanceId()): Promise<LocalRuntimeDescriptor | null> {
  const { descriptorPath } = resolveLocalRuntimePaths(instanceId);
  try {
    const raw = await readFile(descriptorPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidRuntimeDescriptor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeLocalRuntimeDescriptor(descriptor: LocalRuntimeDescriptor): Promise<void> {
  const { runtimeDir, descriptorPath } = resolveLocalRuntimePaths(descriptor.instanceId);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
}

export async function removeLocalRuntimeDescriptorIfOwned(input: {
  instanceId?: string;
  pid?: number;
  apiUrl?: string;
} = {}): Promise<void> {
  const instanceId = input.instanceId ?? resolveRudderInstanceId();
  const { descriptorPath } = resolveLocalRuntimePaths(instanceId);
  const descriptor = await readLocalRuntimeDescriptor(instanceId);
  if (!descriptor) {
    await rm(descriptorPath, { force: true });
    return;
  }
  if (typeof input.pid === "number" && descriptor.pid !== input.pid) return;
  if (typeof input.apiUrl === "string" && descriptor.apiUrl !== input.apiUrl) return;
  await rm(descriptorPath, { force: true });
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type StartLockPayload = {
  pid: number;
  ownerKind: LocalRuntimeOwnerKind | null;
  createdAt: string;
};

async function readStartLock(lockPath: string): Promise<StartLockPayload | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      ownerKind: parseRuntimeOwnerKind(typeof parsed.ownerKind === "string" ? parsed.ownerKind : null),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export async function withRuntimeStartLock<T>(
  input: {
    instanceId?: string;
    ownerKind?: LocalRuntimeOwnerKind | null;
    timeoutMs?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const instanceId = input.instanceId ?? resolveRudderInstanceId();
  const { runtimeDir, lockPath } = resolveLocalRuntimePaths(instanceId);
  const timeoutMs = input.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  const payload: StartLockPayload = {
    pid: process.pid,
    ownerKind: input.ownerKind ?? null,
    createdAt: new Date().toISOString(),
  };

  await mkdir(runtimeDir, { recursive: true });

  while (true) {
    try {
      await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "EEXIST") throw error;

      const existing = await readStartLock(lockPath);
      const lockAgeMs = existing ? Date.now() - Date.parse(existing.createdAt) : Number.POSITIVE_INFINITY;
      const stale = !existing || !isPidRunning(existing.pid) || lockAgeMs > START_LOCK_STALE_MS;
      if (stale) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for local runtime startup lock for instance '${instanceId}'. ` +
            `Held by pid ${existing.pid}${existing.ownerKind ? ` (${existing.ownerKind})` : ""}.`,
        );
      }
      await delay(START_LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function fetchRuntimeHealth(apiUrl: string, timeoutMs = 2_000): Promise<RuntimeHealthSnapshot | null> {
  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    if (payload.status !== "ok") return null;
    return {
      status: "ok",
      version: typeof payload.version === "string" ? payload.version : undefined,
      instanceId: typeof payload.instanceId === "string" ? payload.instanceId : undefined,
      localEnv:
        payload.localEnv === null
          ? null
          : typeof payload.localEnv === "string"
            ? payload.localEnv
            : undefined,
      runtimeOwnerKind: parseRuntimeOwnerKind(
        payload.runtimeOwnerKind === null
          ? null
          : typeof payload.runtimeOwnerKind === "string"
            ? payload.runtimeOwnerKind
            : null,
      ),
    };
  } catch {
    return null;
  }
}

export async function probeLocalRuntime(input: {
  instanceId?: string;
  localEnv?: string | null;
  expectedVersion?: string | null;
} = {}): Promise<LocalRuntimeProbe> {
  const instanceId = input.instanceId ?? resolveRudderInstanceId();
  const descriptor = await readLocalRuntimeDescriptor(instanceId);
  if (!descriptor) return { kind: "missing" };

  if (!isPidRunning(descriptor.pid)) {
    await removeLocalRuntimeDescriptorIfOwned({
      instanceId,
      pid: descriptor.pid,
      apiUrl: descriptor.apiUrl,
    });
    return { kind: "unusable", reason: "pid_dead", descriptor };
  }

  const health = await fetchRuntimeHealth(descriptor.apiUrl);
  if (!health) {
    await removeLocalRuntimeDescriptorIfOwned({
      instanceId,
      pid: descriptor.pid,
      apiUrl: descriptor.apiUrl,
    });
    return { kind: "unusable", reason: "health_unreachable", descriptor, health: null };
  }

  const expectedLocalEnv = normalizeString(input.localEnv);
  const healthInstanceId = normalizeString(health.instanceId);
  const healthLocalEnv = normalizeString(health.localEnv);
  if (healthInstanceId !== instanceId || healthLocalEnv !== expectedLocalEnv) {
    await removeLocalRuntimeDescriptorIfOwned({
      instanceId,
      pid: descriptor.pid,
      apiUrl: descriptor.apiUrl,
    });
    return { kind: "unusable", reason: "health_mismatch", descriptor, health };
  }

  return {
    kind: "healthy",
    descriptor,
    health,
    versionMatches:
      normalizeString(input.expectedVersion) === null
      || normalizeString(health.version) === normalizeString(input.expectedVersion),
  };
}

export async function gracefullyStopRuntime(
  descriptor: Pick<LocalRuntimeDescriptor, "pid" | "instanceId" | "apiUrl">,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!isPidRunning(descriptor.pid)) {
    await removeLocalRuntimeDescriptorIfOwned({
      instanceId: descriptor.instanceId,
      pid: descriptor.pid,
      apiUrl: descriptor.apiUrl,
    });
    return true;
  }

  try {
    process.kill(descriptor.pid, "SIGTERM");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== "ESRCH") return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(descriptor.pid)) {
      await removeLocalRuntimeDescriptorIfOwned({
        instanceId: descriptor.instanceId,
        pid: descriptor.pid,
        apiUrl: descriptor.apiUrl,
      });
      return true;
    }
    await delay(150);
  }

  return !isPidRunning(descriptor.pid);
}

export function localRuntimeDescriptorExists(instanceId = resolveRudderInstanceId()): boolean {
  return existsSync(resolveLocalRuntimePaths(instanceId).descriptorPath);
}
