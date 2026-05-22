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
import { ExecutionWorkspaceInput, ExecutionWorkspaceIssueRef, ExecutionWorkspaceAgentRef, RealizedExecutionWorkspace, RuntimeServiceRef, RuntimeServiceRecord, runtimeServicesById, runtimeServicesByReuseKey, runtimeServiceLeasesByRun, stableStringify, sanitizeRuntimeServiceBaseEnv, stableRuntimeServiceId, toRuntimeServiceRef, sanitizeSlugPart, renderWorkspaceTemplate, sanitizeBranchName, isAbsolutePath, resolveConfiguredPath, formatCommandForDisplay, executeProcess, runGit, gitErrorIncludes, directoryExists, terminateChildProcess, buildWorkspaceCommandEnv, runWorkspaceCommand, recordGitOperation, recordWorkspaceCommandOperation, provisionExecutionWorktree, buildExecutionWorkspaceCleanupEnv, resolveGitRepoRootForWorkspaceCleanup } from "./workspace-runtime.helpers.js";

export function buildWorkspaceReadyComment(input: {
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
}) {
  const lines = ["## Workspace Ready", ""];
  lines.push(`- Strategy: \`${input.workspace.strategy}\``);
  if (input.workspace.branchName) lines.push(`- Branch: \`${input.workspace.branchName}\``);
  lines.push(`- CWD: \`${input.workspace.cwd}\``);
  if (input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd) {
    lines.push(`- Worktree: \`${input.workspace.worktreePath}\``);
  }
  for (const service of input.runtimeServices) {
    const detail = service.url ? `${service.serviceName}: ${service.url}` : `${service.serviceName}: running`;
    const suffix = service.reused ? " (reused)" : "";
    lines.push(`- Service: ${detail}${suffix}`);
  }
  return lines.join("\n");
}
