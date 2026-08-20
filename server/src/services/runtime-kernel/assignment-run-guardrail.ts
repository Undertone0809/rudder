import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT = 3;
export const ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT = 25;
export const ASSIGNMENT_DEPENDENCY_PREFLIGHT_FAILURE_CODE = "assignment_dependency_preflight_failed";
export const ASSIGNMENT_DEPENDENCY_REPAIR_COMMAND = "pnpm install --frozen-lockfile";
export const ASSIGNMENT_DEPENDENCY_REPAIR_TIMEOUT_MS = 120_000;
const ASSIGNMENT_DEPENDENCY_GRAPH_ARGS = ["list", "--depth", "-1", "--json"];

type ToolFailure = Extract<TranscriptEntry, { kind: "tool_result" }>;
type ToolCall = Extract<TranscriptEntry, { kind: "tool_call" }>;
const execFileAsync = promisify(execFile);

export type AssignmentRunWorkspacePreflight = {
  actualCwd: string;
  projectWorkingSetCwd: string;
  cwdPresent: boolean;
  projectWorkingSetPresent: boolean;
  cwdMatchesProjectWorkingSet: boolean;
  packageManager: "pnpm" | "unknown" | "none";
  packageJsonPresent: boolean;
  pnpmLockPresent: boolean;
  nodeModulesPresent: boolean;
  pnpmVirtualStorePresent: boolean;
  expectedPackageManager: string | null;
  installedPackageManager: string | null;
  configuredStoreDir: string | null;
  configuredVirtualStoreDir: string | null;
  packageManagerMatches: boolean;
  storeDirPresent: boolean;
  virtualStoreMatches: boolean;
  nodeCommandAvailable: boolean | null;
  pnpmCommandAvailable: boolean | null;
  dependencyGraphAvailable: boolean | null;
  ready: boolean;
  recoveryCommand: string | null;
  diagnosticOutput: string | null;
  lockfileFingerprint: string | null;
  workspaceIdentity: string;
  workspaceFingerprint: string;
  readinessFingerprint: string;
};

export type AssignmentRunCommandResult = {
  ok: boolean;
  output: string;
};

export type AssignmentRunCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<AssignmentRunCommandResult>;

export type AssignmentDependencyRepairOutcome = {
  initial: AssignmentRunWorkspacePreflight;
  final: AssignmentRunWorkspacePreflight;
  command: string | null;
  attempted: boolean;
  coalesced: boolean;
  rechecked: boolean;
  succeeded: boolean;
  output: string | null;
  skippedReason: "already_ready" | "unchanged_readiness" | "unsupported_recovery_command" | null;
  workspaceIdentity: string;
  workspaceFingerprint: string;
  readinessFingerprint: string;
};

type AssignmentWorkspaceInspector = (input: {
  actualCwd: string;
  projectWorkingSetCwd: string;
  runCommand?: AssignmentRunCommandRunner;
}) => Promise<AssignmentRunWorkspacePreflight>;

const repairPromises = new Map<string, Promise<AssignmentDependencyRepairOutcome>>();
const failedRepairFingerprints = new Map<string, Set<string>>();

function rememberFailedRepair(workspaceIdentity: string, readinessFingerprints: string[]) {
  const fingerprints = failedRepairFingerprints.get(workspaceIdentity) ?? new Set<string>();
  for (const fingerprint of readinessFingerprints) fingerprints.add(fingerprint);
  failedRepairFingerprints.set(workspaceIdentity, fingerprints);
}

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

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintAssignmentRunWorkspace(input: {
  actualCwd: string;
  projectWorkingSetCwd: string;
  lockfileFingerprint: string | null;
}) {
  return digest(JSON.stringify({
    workspaceIdentity: fingerprintAssignmentRunWorkspaceIdentity(input),
    lockfileFingerprint: input.lockfileFingerprint,
  }));
}

export function fingerprintAssignmentRunWorkspaceIdentity(input: {
  actualCwd: string;
  projectWorkingSetCwd: string;
}) {
  return digest(JSON.stringify({
    actualCwd: path.resolve(input.actualCwd),
    projectWorkingSetCwd: path.resolve(input.projectWorkingSetCwd),
  }));
}

export function fingerprintAssignmentRunReadiness(input: object) {
  const preflight = input as Partial<AssignmentRunWorkspacePreflight>;
  return digest(JSON.stringify({
    actualCwd: preflight.actualCwd,
    projectWorkingSetCwd: preflight.projectWorkingSetCwd,
    workspaceIdentity: preflight.workspaceIdentity,
    workspaceFingerprint: preflight.workspaceFingerprint,
    lockfileFingerprint: preflight.lockfileFingerprint,
    cwdPresent: preflight.cwdPresent,
    projectWorkingSetPresent: preflight.projectWorkingSetPresent,
    cwdMatchesProjectWorkingSet: preflight.cwdMatchesProjectWorkingSet,
    packageManager: preflight.packageManager,
    packageJsonPresent: preflight.packageJsonPresent,
    pnpmLockPresent: preflight.pnpmLockPresent,
    nodeModulesPresent: preflight.nodeModulesPresent,
    pnpmVirtualStorePresent: preflight.pnpmVirtualStorePresent,
    expectedPackageManager: preflight.expectedPackageManager,
    installedPackageManager: preflight.installedPackageManager,
    configuredStoreDir: preflight.configuredStoreDir,
    configuredVirtualStoreDir: preflight.configuredVirtualStoreDir,
    packageManagerMatches: preflight.packageManagerMatches,
    storeDirPresent: preflight.storeDirPresent,
    virtualStoreMatches: preflight.virtualStoreMatches,
    nodeCommandAvailable: preflight.nodeCommandAvailable,
    pnpmCommandAvailable: preflight.pnpmCommandAvailable,
    dependencyGraphAvailable: preflight.dependencyGraphAvailable,
    ready: preflight.ready,
    recoveryCommand: preflight.recoveryCommand,
  }));
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
  runCommand?: AssignmentRunCommandRunner;
}): Promise<AssignmentRunWorkspacePreflight> {
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
  const lockfileContents = pnpmLockPresent ? await readText(pnpmLockPath) : "";
  const lockfileFingerprint = pnpmLockPresent ? digest(lockfileContents) : null;
  const expectedPackageManager = typeof packageJson.packageManager === "string" ? packageJson.packageManager : null;
  const modulesManifest = nodeModulesPresent ? await readText(modulesManifestPath) : "";
  const installedPackageManager = yamlScalar(modulesManifest, "packageManager");
  const configuredStoreDir = yamlScalar(modulesManifest, "storeDir");
  const configuredVirtualStoreDir = yamlScalar(modulesManifest, "virtualStoreDir");
  const runCommand = input.runCommand ?? runPreflightCommand;
  const nodeCommand = packageJsonPresent ? await runCommand("node", ["--version"], input.actualCwd) : null;
  const pnpmCommand = pnpmLockPresent ? await runCommand("pnpm", ["--version"], input.actualCwd) : null;
  const dependencyGraph = pnpmLockPresent && nodeModulesPresent && pnpmVirtualStorePresent
    ? await runCommand("pnpm", ASSIGNMENT_DEPENDENCY_GRAPH_ARGS, input.actualCwd)
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
          ? ASSIGNMENT_DEPENDENCY_REPAIR_COMMAND
          : "pnpm install --force")
      : packageJsonPresent
        ? "npm install"
        : null;
  const workspaceFingerprint = fingerprintAssignmentRunWorkspace({
    actualCwd: input.actualCwd,
    projectWorkingSetCwd: input.projectWorkingSetCwd,
    lockfileFingerprint,
  });
  const workspaceIdentity = fingerprintAssignmentRunWorkspaceIdentity(input);
  const diagnosticOutput = dependencyGraph && !dependencyGraph.ok
    ? dependencyGraph.output
    : pnpmCommand && !pnpmCommand.ok
      ? pnpmCommand.output
      : nodeCommand && !nodeCommand.ok
        ? nodeCommand.output
        : null;
  const preflight: Omit<AssignmentRunWorkspacePreflight, "readinessFingerprint"> = {
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
    diagnosticOutput: diagnosticOutput || null,
    lockfileFingerprint,
    workspaceIdentity,
    workspaceFingerprint,
  };
  return {
    ...preflight,
    readinessFingerprint: fingerprintAssignmentRunReadiness(preflight),
  };
}

function compactCommandOutput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

async function runAssignmentDependencyRepairCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<AssignmentRunCommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: ASSIGNMENT_DEPENDENCY_REPAIR_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      env: { ...process.env, CI: "1" },
    });
    return {
      ok: true,
      output: compactCommandOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
    };
  } catch (error: unknown) {
    const commandError = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    return {
      ok: false,
      output: compactCommandOutput([
        typeof commandError.message === "string" ? commandError.message : String(error),
        typeof commandError.stderr === "string" ? commandError.stderr : "",
        typeof commandError.stdout === "string" ? commandError.stdout : "",
      ].filter(Boolean).join("\n")),
    };
  }
}

function repairOutcomeBase(
  preflight: AssignmentRunWorkspacePreflight,
  overrides: Partial<AssignmentDependencyRepairOutcome> = {},
): AssignmentDependencyRepairOutcome {
  return {
    initial: preflight,
    final: preflight,
    command: null,
    attempted: false,
    coalesced: false,
    rechecked: false,
    succeeded: preflight.ready,
    output: null,
    skippedReason: preflight.ready ? "already_ready" : null,
    workspaceIdentity: preflight.workspaceIdentity,
    workspaceFingerprint: preflight.workspaceFingerprint,
    readinessFingerprint: preflight.readinessFingerprint,
    ...overrides,
  };
}

function rememberRepairFailure(outcome: AssignmentDependencyRepairOutcome) {
  if (outcome.succeeded) return;
  rememberFailedRepair(outcome.workspaceIdentity, [
    outcome.initial.readinessFingerprint,
    outcome.final.readinessFingerprint,
  ]);
}

export async function repairAssignmentRunWorkspace(input: {
  preflight: AssignmentRunWorkspacePreflight;
  inspect?: AssignmentWorkspaceInspector;
  runCommand?: AssignmentRunCommandRunner;
}): Promise<AssignmentDependencyRepairOutcome> {
  const { preflight } = input;
  if (preflight.ready) return repairOutcomeBase(preflight);

  if (preflight.recoveryCommand !== ASSIGNMENT_DEPENDENCY_REPAIR_COMMAND) {
    return repairOutcomeBase(preflight, {
      skippedReason: "unsupported_recovery_command",
    });
  }

  const failedFingerprints = failedRepairFingerprints.get(preflight.workspaceIdentity);
  if (failedFingerprints?.has(preflight.readinessFingerprint)) {
    return repairOutcomeBase(preflight, {
      skippedReason: "unchanged_readiness",
    });
  }

  const repairKey = preflight.workspaceIdentity;
  const existingRepair = repairPromises.get(repairKey);
  if (existingRepair) {
    const sharedOutcome = await existingRepair;
    const outcome = {
      ...sharedOutcome,
      initial: preflight,
      workspaceIdentity: preflight.workspaceIdentity,
      workspaceFingerprint: preflight.workspaceFingerprint,
      readinessFingerprint: preflight.readinessFingerprint,
      coalesced: true,
    };
    rememberRepairFailure(outcome);
    return outcome;
  }

  const inspect = input.inspect ?? inspectAssignmentRunWorkspace;
  const runCommand = input.runCommand ?? runAssignmentDependencyRepairCommand;
  const repairPromise = (async () => {
    let commandResult: AssignmentRunCommandResult;
    try {
      commandResult = await runCommand("pnpm", ["install", "--frozen-lockfile"], preflight.actualCwd);
    } catch (error: unknown) {
      commandResult = {
        ok: false,
        output: compactCommandOutput(error instanceof Error ? error.message : String(error)),
      };
    }
    const final = await inspect({
      actualCwd: preflight.actualCwd,
      projectWorkingSetCwd: preflight.projectWorkingSetCwd,
    });
    const outcome = repairOutcomeBase(preflight, {
      final,
      command: ASSIGNMENT_DEPENDENCY_REPAIR_COMMAND,
      attempted: true,
      rechecked: true,
      succeeded: final.ready,
      output: final.ready
        ? commandResult.output || null
        : final.diagnosticOutput || commandResult.output || preflight.diagnosticOutput || null,
      skippedReason: null,
    });
    rememberRepairFailure(outcome);
    return outcome;
  })();
  repairPromises.set(repairKey, repairPromise);
  try {
    return await repairPromise;
  } finally {
    repairPromises.delete(repairKey);
  }
}

export class AssignmentDependencyPreflightError extends Error {
  readonly errorCode = ASSIGNMENT_DEPENDENCY_PREFLIGHT_FAILURE_CODE;
  readonly failure: {
    preflight: AssignmentRunWorkspacePreflight;
    dependencyRepair: AssignmentDependencyRepairOutcome | null;
  };

  constructor(
    preflight: AssignmentRunWorkspacePreflight,
    dependencyRepair: AssignmentDependencyRepairOutcome | null,
  ) {
    const repairMessage = dependencyRepair?.skippedReason === "unchanged_readiness"
      ? "Automatic dependency repair was already attempted for this unchanged workspace and lockfile state."
      : dependencyRepair?.attempted && dependencyRepair.succeeded === false
        ? `Automatic dependency repair did not make the workspace ready${dependencyRepair.output ? `: ${dependencyRepair.output}` : "."}`
        : null;
    const nextStep = preflight.recoveryCommand
      ? `Next step: ${preflight.recoveryCommand} once after correcting the reported dependency state.`
      : "Next step: restore the project working set and retry.";
    super([
      `Assignment dependency preflight failed in ${preflight.actualCwd}.`,
      repairMessage,
      nextStep,
    ].filter(Boolean).join(" "));
    this.name = "AssignmentDependencyPreflightError";
    this.failure = { preflight, dependencyRepair };
  }
}
