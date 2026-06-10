import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureGitRepositoryIdentityConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import type { AgentRuntimeServiceReport } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { workspaceRuntimeServices } from "@rudderhq/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { asNumber, asString, parseObject, renderTemplate } from "../agent-runtimes/utils.js";
import { resolveHomeAwarePath } from "../home-paths.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";

export interface ExecutionWorkspaceInput {
  baseCwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
}

export interface ExecutionWorkspaceIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
}

export interface ExecutionWorkspaceAgentRef {
  id: string;
  name: string;
  orgId: string;
}

export interface RealizedExecutionWorkspace extends ExecutionWorkspaceInput {
  strategy: "project_primary" | "git_worktree";
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  warnings: string[];
  created: boolean;
}

export interface RuntimeServiceRef {
  id: string;
  orgId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  reused: boolean;
}

export interface RuntimeServiceRecord extends RuntimeServiceRef {
  db?: Db;
  child: ChildProcess | null;
  leaseRunIds: Set<string>;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  envFingerprint: string;
}

export const runtimeServicesById = new Map<string, RuntimeServiceRecord>();
export const runtimeServicesByReuseKey = new Map<string, string>();
export const runtimeServiceLeasesByRun = new Map<string, string[]>();

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUDDER_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  return env;
}

export function stableRuntimeServiceId(input: {
  agentRuntimeType: string;
  runId: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
  serviceName: string;
  reportId: string | null;
  providerRef: string | null;
  reuseKey: string | null;
}) {
  if (input.reportId) return input.reportId;
  const digest = createHash("sha256")
    .update(
      stableStringify({
        agentRuntimeType: input.agentRuntimeType,
        runId: input.runId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        serviceName: input.serviceName,
        providerRef: input.providerRef,
        reuseKey: input.reuseKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.agentRuntimeType}-${digest}`;
}

export function toRuntimeServiceRef(record: RuntimeServiceRecord, overrides?: Partial<RuntimeServiceRef>): RuntimeServiceRef {
  return {
    id: record.id,
    orgId: record.orgId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: record.lastUsedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    reused: record.reused,
    ...overrides,
  };
}

export function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

export function renderWorkspaceTemplate(template: string, input: {
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  projectId: string | null;
  repoRef: string | null;
}) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id,
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}

export function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "rudder-work";
}

export function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

export function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

export function formatCommandForDisplay(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export async function executeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const proc = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
  return proc;
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = await executeProcess({
    command: "git",
    args,
    cwd,
  });
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

export function gitErrorIncludes(error: unknown, needle: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

export async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

export function terminateChildProcess(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to the direct child kill.
    }
  }
  if (!child.killed) {
    child.kill("SIGTERM");
  }
}

export function buildWorkspaceCommandEnv(input: {
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.RUDDER_WORKSPACE_CWD = input.worktreePath;
  env.RUDDER_WORKSPACE_PATH = input.worktreePath;
  env.RUDDER_WORKSPACE_WORKTREE_PATH = input.worktreePath;
  env.RUDDER_WORKSPACE_BRANCH = input.branchName;
  env.RUDDER_WORKSPACE_BASE_CWD = input.base.baseCwd;
  env.RUDDER_WORKSPACE_REPO_ROOT = input.repoRoot;
  env.RUDDER_WORKSPACE_SOURCE = input.base.source;
  env.RUDDER_WORKSPACE_REPO_REF = input.base.repoRef ?? "";
  env.RUDDER_WORKSPACE_REPO_URL = input.base.repoUrl ?? "";
  env.RUDDER_WORKSPACE_CREATED = input.created ? "true" : "false";
  env.RUDDER_PROJECT_ID = input.base.projectId ?? "";
  env.RUDDER_PROJECT_WORKSPACE_ID = input.base.workspaceId ?? "";
  env.RUDDER_AGENT_ID = input.agent.id;
  env.RUDDER_AGENT_NAME = input.agent.name;
  env.RUDDER_ORG_ID = input.agent.orgId;
  env.RUDDER_ISSUE_ID = input.issue?.id ?? "";
  env.RUDDER_ISSUE_IDENTIFIER = input.issue?.identifier ?? "";
  env.RUDDER_ISSUE_TITLE = input.issue?.title ?? "";
  return env;
}

export async function runWorkspaceCommand(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}) {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  const proc = await executeProcess({
    command: shell,
    args: ["-c", input.command],
    cwd: input.cwd,
    env: input.env,
  });
  if (proc.code === 0) return;

  const details = [proc.stderr.trim(), proc.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${proc.code ?? -1}`,
  );
}

export async function recordGitOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "worktree_prepare" | "worktree_cleanup";
    args: string[];
    cwd: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    failureLabel?: string | null;
  },
): Promise<string> {
  if (!recorder) {
    return runGit(input.args, input.cwd);
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  await recorder.recordOperation({
    phase: input.phase,
    command: formatCommandForDisplay("git", input.args),
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const result = await executeProcess({
        command: "git",
        args: input.args,
        cwd: input.cwd,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
      };
    },
  });

  if (code !== 0) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      details.length > 0
        ? `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed: ${details}`
        : `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed with exit code ${code ?? -1}`,
    );
  }
  return stdout.trim();
}

export async function recordWorkspaceCommandOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "workspace_provision" | "workspace_teardown";
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    label: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
  },
) {
  if (!recorder) {
    await runWorkspaceCommand(input);
    return;
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  await recorder.recordOperation({
    phase: input.phase,
    command: input.command,
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const shell = process.env.SHELL?.trim() || "/bin/sh";
      const result = await executeProcess({
        command: shell,
        args: ["-c", input.command],
        cwd: input.cwd,
        env: input.env,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
      };
    },
  });

  if (code === 0) return;

  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${code ?? -1}`,
  );
}

export async function provisionExecutionWorktree(input: {
  strategy: Record<string, unknown>;
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  await ensureGitRepositoryIdentityConfig({ cwd: input.worktreePath });

  const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
  if (!provisionCommand) return;

  await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: provisionCommand,
    cwd: input.worktreePath,
    env: buildWorkspaceCommandEnv({
      base: input.base,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      issue: input.issue,
      agent: input.agent,
      created: input.created,
    }),
    label: `Run workspace provision command "${provisionCommand}"`,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      created: input.created,
    },
    successMessage: `Provisioned workspace at ${input.worktreePath}\n`,
  });
}

export function buildExecutionWorkspaceCleanupEnv(input: {
  workspace: {
    cwd: string | null;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
  };
  projectWorkspaceCwd?: string | null;
}) {
  const env: NodeJS.ProcessEnv = sanitizeRuntimeServiceBaseEnv(process.env);
  env.RUDDER_WORKSPACE_CWD = input.workspace.cwd ?? "";
  env.RUDDER_WORKSPACE_PATH = input.workspace.cwd ?? "";
  env.RUDDER_WORKSPACE_WORKTREE_PATH =
    input.workspace.providerRef ?? input.workspace.cwd ?? "";
  env.RUDDER_WORKSPACE_BRANCH = input.workspace.branchName ?? "";
  env.RUDDER_WORKSPACE_BASE_CWD = input.projectWorkspaceCwd ?? "";
  env.RUDDER_WORKSPACE_REPO_ROOT = input.projectWorkspaceCwd ?? "";
  env.RUDDER_WORKSPACE_REPO_URL = input.workspace.repoUrl ?? "";
  env.RUDDER_WORKSPACE_REPO_REF = input.workspace.baseRef ?? "";
  env.RUDDER_PROJECT_ID = input.workspace.projectId ?? "";
  env.RUDDER_PROJECT_WORKSPACE_ID = input.workspace.projectWorkspaceId ?? "";
  env.RUDDER_ISSUE_ID = input.workspace.sourceIssueId ?? "";
  return env;
}

export async function resolveGitRepoRootForWorkspaceCleanup(
  worktreePath: string,
  projectWorkspaceCwd: string | null,
): Promise<string | null> {
  if (projectWorkspaceCwd) {
    const resolvedProjectWorkspaceCwd = path.resolve(projectWorkspaceCwd);
    const gitDir = await runGit(["rev-parse", "--git-common-dir"], resolvedProjectWorkspaceCwd)
      .catch(() => null);
    if (gitDir) {
      const resolvedGitDir = path.resolve(resolvedProjectWorkspaceCwd, gitDir);
      return path.dirname(resolvedGitDir);
    }
  }

  const gitDir = await runGit(["rev-parse", "--git-common-dir"], worktreePath).catch(() => null);
  if (!gitDir) return null;
  const resolvedGitDir = path.resolve(worktreePath, gitDir);
  return path.dirname(resolvedGitDir);
}

