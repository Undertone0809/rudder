import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT = 3;
export const ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT = 25;

type ToolFailure = Extract<TranscriptEntry, { kind: "tool_result" }>;
type ToolCall = Extract<TranscriptEntry, { kind: "tool_call" }>;
const execFileAsync = promisify(execFile);

export type AssignmentRunGuardrailCheckpoint = {
  reason: "repeated_failure" | "total_failure_budget";
  failureCount: number;
  consecutiveFailureCount: number;
  fingerprint: string;
  toolName: string;
  unresolvedError: string;
  nextRecoveryCommand: string | null;
  completedWorkSummary?: string;
};

export function resolveProjectWorkingSetCwd(
  resources: Array<{
    role?: string | null;
    resource?: { kind?: string | null; sourceType?: string | null; locator?: string | null } | null;
  }>,
) {
  const workingSet = resources.find((entry) =>
    entry.role === "working_set"
    && entry.resource?.kind === "directory"
    && entry.resource.sourceType === "external"
    && typeof entry.resource.locator === "string"
    && path.isAbsolute(entry.resource.locator));
  return workingSet?.resource?.locator?.trim() || null;
}

function compactFailureText(value: string) {
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\S+\b/g, "<timestamp>")
    .replace(/\/[^\s:'\"]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function commandIdentity(entry: ToolCall | undefined, toolUseId: string) {
  if (!entry) return `tool-use:${toolUseId}`;
  return compactFailureText(JSON.stringify(entry.input)).slice(0, 500);
}

export function fingerprintToolFailure(entry: ToolFailure, call?: ToolCall) {
  return `${entry.toolName ?? call?.name ?? "unknown"}:${commandIdentity(call, entry.toolUseId)}:${compactFailureText(entry.content).slice(0, 500)}`;
}

function inferRecoveryCommand(entry: ToolFailure) {
  const content = entry.content.toLowerCase();
  if (content.includes("node_modules") || content.includes("cannot find module") || content.includes("module not found")) {
    return "pnpm install --frozen-lockfile";
  }
  if (content.includes("unexpected store") || content.includes("virtual store") || content.includes("store-dir")) {
    return "pnpm install --force";
  }
  return null;
}

export function createAssignmentRunFailureBudget() {
  let failureCount = 0;
  let lastFingerprint: string | null = null;
  let consecutiveFailureCount = 0;
  let processedEntryCount = 0;
  let checkpoint: AssignmentRunGuardrailCheckpoint | null = null;
  const callsById = new Map<string, ToolCall>();

  return {
    observe(entries: TranscriptEntry[]) {
      if (checkpoint) return checkpoint;
      const nextEntries = entries.slice(processedEntryCount);
      processedEntryCount = entries.length;
      for (const entry of nextEntries) {
        if (entry.kind === "tool_call" && entry.toolUseId) {
          callsById.set(entry.toolUseId, entry);
          continue;
        }
        if (entry.kind !== "tool_result") continue;
        if (!entry.isError) {
          lastFingerprint = null;
          consecutiveFailureCount = 0;
          continue;
        }
        failureCount += 1;
        const fingerprint = fingerprintToolFailure(entry, callsById.get(entry.toolUseId));
        consecutiveFailureCount = fingerprint === lastFingerprint ? consecutiveFailureCount + 1 : 1;
        lastFingerprint = fingerprint;
        const reason = consecutiveFailureCount >= ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT
          ? "repeated_failure"
          : failureCount >= ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT
            ? "total_failure_budget"
            : null;
        if (reason) {
          checkpoint = {
            reason,
            failureCount,
            consecutiveFailureCount,
            fingerprint,
            toolName: entry.toolName ?? "unknown",
            unresolvedError: entry.content.slice(0, 2_000),
            nextRecoveryCommand: inferRecoveryCommand(entry),
          };
          return checkpoint;
        }
      }
      return null;
    },
    snapshot() {
      return { failureCount, consecutiveFailureCount, checkpoint };
    },
  };
}

async function pathExists(candidate: string) {
  return fs.access(candidate).then(() => true, () => false);
}

async function readText(candidate: string) {
  return fs.readFile(candidate, "utf8").catch(() => "");
}

function parseJsonObject(contents: string) {
  try {
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function yamlScalar(contents: string, key: string) {
  const match = contents.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.replace(/^['"]|['"]$/g, "").trim() || null;
}

async function runPreflightCommand(command: string, args: string[], cwd: string) {
  return execFileAsync(command, args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    env: { ...process.env, CI: "1" },
  }).then(
    ({ stdout }) => ({ ok: true, output: stdout.trim().slice(0, 500) }),
    (error: unknown) => ({
      ok: false,
      output: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }),
  );
}

export async function inspectAssignmentRunWorkspace(input: {
  actualCwd: string;
  projectWorkingSetCwd: string;
}) {
  const packageJsonPath = path.join(input.actualCwd, "package.json");
  const pnpmLockPath = path.join(input.actualCwd, "pnpm-lock.yaml");
  const virtualStorePath = path.join(input.actualCwd, "node_modules", ".pnpm");
  const modulesManifestPath = path.join(input.actualCwd, "node_modules", ".modules.yaml");
  const [cwdPresent, projectWorkingSetPresent, packageJsonPresent, pnpmLockPresent, nodeModulesPresent, pnpmVirtualStorePresent] = await Promise.all([
    fs.stat(input.actualCwd).then((stat) => stat.isDirectory(), () => false),
    fs.stat(input.projectWorkingSetCwd).then((stat) => stat.isDirectory(), () => false),
    pathExists(packageJsonPath),
    pathExists(pnpmLockPath),
    pathExists(path.join(input.actualCwd, "node_modules")),
    pathExists(virtualStorePath),
  ]);
  const packageJson = packageJsonPresent ? parseJsonObject(await readText(packageJsonPath)) : {};
  const expectedPackageManager = typeof packageJson.packageManager === "string" ? packageJson.packageManager : null;
  const modulesManifest = nodeModulesPresent ? await readText(modulesManifestPath) : "";
  const installedPackageManager = yamlScalar(modulesManifest, "packageManager");
  const configuredStoreDir = yamlScalar(modulesManifest, "storeDir");
  const configuredVirtualStoreDir = yamlScalar(modulesManifest, "virtualStoreDir");
  const nodeCommand = packageJsonPresent ? await runPreflightCommand("node", ["--version"], input.actualCwd) : null;
  const pnpmCommand = pnpmLockPresent ? await runPreflightCommand("pnpm", ["--version"], input.actualCwd) : null;
  const dependencyGraph = pnpmLockPresent && nodeModulesPresent && pnpmVirtualStorePresent
    ? await runPreflightCommand("pnpm", ["list", "--depth", "-1", "--offline", "--json"], input.actualCwd)
    : null;
  const packageManagerMatches = !expectedPackageManager
    || !installedPackageManager
    || expectedPackageManager === installedPackageManager;
  const storeDirPresent = !configuredStoreDir || await pathExists(
    path.isAbsolute(configuredStoreDir) ? configuredStoreDir : path.join(input.actualCwd, configuredStoreDir),
  );
  const virtualStoreMatches = !configuredVirtualStoreDir || configuredVirtualStoreDir === ".pnpm";
  const ready = cwdPresent
    && projectWorkingSetPresent
    && (!packageJsonPresent || Boolean(nodeCommand?.ok))
    && (!pnpmLockPresent || Boolean(pnpmCommand?.ok))
    && (!packageJsonPresent || nodeModulesPresent)
    && (!pnpmLockPresent || pnpmVirtualStorePresent)
    && packageManagerMatches
    && storeDirPresent
    && virtualStoreMatches
    && (!dependencyGraph || dependencyGraph.ok);
  const recoveryCommand = ready
    ? null
    : pnpmLockPresent
      ? (packageManagerMatches && storeDirPresent && virtualStoreMatches
          ? "pnpm install --frozen-lockfile"
          : "pnpm install --force")
      : packageJsonPresent
        ? "npm install"
        : null;
  return {
    actualCwd: input.actualCwd,
    projectWorkingSetCwd: input.projectWorkingSetCwd,
    cwdPresent,
    projectWorkingSetPresent,
    cwdMatchesProjectWorkingSet: path.resolve(input.actualCwd) === path.resolve(input.projectWorkingSetCwd),
    packageManager: pnpmLockPresent ? "pnpm" : packageJsonPresent ? "unknown" : "none",
    packageJsonPresent,
    pnpmLockPresent,
    nodeModulesPresent,
    pnpmVirtualStorePresent,
    expectedPackageManager,
    installedPackageManager,
    configuredStoreDir,
    configuredVirtualStoreDir,
    packageManagerMatches,
    storeDirPresent,
    virtualStoreMatches,
    nodeCommandAvailable: nodeCommand?.ok ?? null,
    pnpmCommandAvailable: pnpmCommand?.ok ?? null,
    dependencyGraphAvailable: dependencyGraph?.ok ?? null,
    ready,
    recoveryCommand,
  };
}
