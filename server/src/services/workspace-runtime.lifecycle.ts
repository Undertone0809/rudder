import fs from "node:fs/promises";
import path from "node:path";
import { asString, parseObject } from "../agent-runtimes/utils.js";
import {
  resolveManagedRunWorkspacesRoot,
  resolveOrganizationWorkspaceRoot,
} from "../home-paths.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";
import { buildExecutionWorkspaceCleanupEnv, directoryExists, ExecutionWorkspaceAgentRef, ExecutionWorkspaceInput, ExecutionWorkspaceIssueRef, gitErrorIncludes, provisionExecutionWorktree, RealizedExecutionWorkspace, recordGitOperation, recordWorkspaceCommandOperation, renderWorkspaceTemplate, resolveConfiguredPath, resolveGitRepoRootForWorkspaceCleanup, runGit, sanitizeBranchName } from "./workspace-runtime.helpers.js";

function isPathWithin(ancestorPath: string, candidatePath: string, allowEqual: boolean) {
  const relative = path.relative(ancestorPath, candidatePath);
  if (relative === "") return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function lstatOrNull(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveManagedLocalWorkspaceCleanupTarget(input: {
  orgId: string;
  workspacePath: string;
}): Promise<{ targetPath: string | null; refusalReason: string | null }> {
  const managedRoot = path.resolve(resolveManagedRunWorkspacesRoot(input.orgId));
  const targetPath = path.resolve(input.workspacePath);
  if (!isPathWithin(managedRoot, targetPath, false)) {
    return {
      targetPath: null,
      refusalReason: `path is not a child of the managed runtime workspace root "${managedRoot}"`,
    };
  }

  const organizationWorkspaceRoot = path.resolve(resolveOrganizationWorkspaceRoot(input.orgId));
  if (isPathWithin(targetPath, organizationWorkspaceRoot, true)) {
    return {
      targetPath: null,
      refusalReason: "path is or contains the organization workspace root",
    };
  }

  const managedRootStat = await lstatOrNull(managedRoot);
  if (!managedRootStat) {
    return { targetPath: null, refusalReason: null };
  }
  if (managedRootStat.isSymbolicLink() || !managedRootStat.isDirectory()) {
    return {
      targetPath: null,
      refusalReason: "managed runtime workspace root is not a real directory",
    };
  }

  const relativeSegments = path.relative(managedRoot, targetPath).split(path.sep).filter(Boolean);
  let currentPath = managedRoot;
  for (const [index, segment] of relativeSegments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatOrNull(currentPath);
    if (!stat) {
      return { targetPath: null, refusalReason: null };
    }
    if (stat.isSymbolicLink()) {
      return {
        targetPath: null,
        refusalReason: `path contains symbolic link "${currentPath}"`,
      };
    }
    const isTarget = index === relativeSegments.length - 1;
    if (!stat.isDirectory()) {
      return {
        targetPath: null,
        refusalReason: isTarget
          ? "managed runtime workspace target is not a directory"
          : `path ancestor "${currentPath}" is not a directory`,
      };
    }
  }

  const [realManagedRoot, realTargetPath] = await Promise.all([
    fs.realpath(managedRoot),
    fs.realpath(targetPath),
  ]);
  if (!isPathWithin(realManagedRoot, realTargetPath, false)) {
    return {
      targetPath: null,
      refusalReason: "resolved path escapes the managed runtime workspace root",
    };
  }

  const realOrganizationWorkspaceRoot = await fs.realpath(organizationWorkspaceRoot).catch(() => null);
  if (
    realOrganizationWorkspaceRoot
    && isPathWithin(realTargetPath, realOrganizationWorkspaceRoot, true)
  ) {
    return {
      targetPath: null,
      refusalReason: "resolved path is or contains the organization workspace root",
    };
  }

  return { targetPath: realTargetPath, refusalReason: null };
}

export async function realizeExecutionWorkspace(input: {
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<RealizedExecutionWorkspace> {
  const rawStrategy = parseObject(input.config.workspaceStrategy);
  const strategyType = asString(rawStrategy.type, "project_primary");
  if (strategyType !== "git_worktree") {
    return {
      ...input.base,
      strategy: "project_primary",
      cwd: input.base.baseCwd,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
    };
  }

  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], input.base.baseCwd);
  const branchTemplate = asString(rawStrategy.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: input.issue,
    agent: input.agent,
    projectId: input.base.projectId,
    repoRef: input.base.repoRef,
  });
  const branchName = sanitizeBranchName(renderedBranch);
  const configuredParentDir = asString(rawStrategy.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".rudder", "worktrees");
  const worktreePath = path.join(worktreeParentDir, branchName);
  const baseRef = asString(rawStrategy.baseRef, input.base.repoRef ?? "HEAD");

  await fs.mkdir(worktreeParentDir, { recursive: true });

  const existingWorktree = await directoryExists(worktreePath);
  if (existingWorktree) {
    const existingGitDir = await runGit(["rev-parse", "--git-dir"], worktreePath).catch(() => null);
    if (existingGitDir) {
      if (input.recorder) {
        await input.recorder.recordOperation({
          phase: "worktree_prepare",
          cwd: repoRoot,
          metadata: {
            repoRoot,
            worktreePath,
            branchName,
            baseRef,
            created: false,
            reused: true,
          },
          run: async () => ({
            status: "succeeded",
            exitCode: 0,
            system: `Reused existing git worktree at ${worktreePath}\n`,
          }),
        });
      }
      await provisionExecutionWorktree({
        strategy: rawStrategy,
        base: input.base,
        repoRoot,
        worktreePath,
        branchName,
        issue: input.issue,
        agent: input.agent,
        created: false,
        recorder: input.recorder ?? null,
      });
      return {
        ...input.base,
        strategy: "git_worktree",
        cwd: worktreePath,
        branchName,
        worktreePath,
        warnings: [],
        created: false,
      };
    }
    throw new Error(`Configured worktree path "${worktreePath}" already exists and is not a git worktree.`);
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        created: true,
      },
      successMessage: `Created git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (!gitErrorIncludes(error, "already exists")) {
      throw error;
    }
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", worktreePath, branchName],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        created: false,
        reusedExistingBranch: true,
      },
      successMessage: `Attached existing branch ${branchName} at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  }
  await provisionExecutionWorktree({
    strategy: rawStrategy,
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created: true,
    recorder: input.recorder ?? null,
  });

  return {
    ...input.base,
    strategy: "git_worktree",
    cwd: worktreePath,
    branchName,
    worktreePath,
    warnings: [],
    created: true,
  };
}

export async function cleanupExecutionWorkspaceArtifacts(input: {
  workspace: {
    id: string;
    orgId?: string | null;
    cwd: string | null;
    providerType: string;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectWorkspace?: {
    cwd: string | null;
    cleanupCommand: string | null;
  } | null;
  teardownCommand?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const warnings: string[] = [];
  const workspacePath = input.workspace.providerRef ?? input.workspace.cwd;
  const cleanupEnv = buildExecutionWorkspaceCleanupEnv({
    workspace: input.workspace,
    projectWorkspaceCwd: input.projectWorkspace?.cwd ?? null,
  });
  const createdByRuntime = input.workspace.metadata?.createdByRuntime === true;
  const cleanupCommands = [
    input.projectWorkspace?.cleanupCommand ?? null,
    input.teardownCommand ?? null,
  ]
    .map((value) => asString(value, "").trim())
    .filter(Boolean);

  for (const command of cleanupCommands) {
    try {
      await recordWorkspaceCommandOperation(input.recorder, {
        phase: "workspace_teardown",
        command,
        cwd: workspacePath ?? input.projectWorkspace?.cwd ?? process.cwd(),
        env: cleanupEnv,
        label: `Run workspace cleanup command "${command}"`,
        metadata: {
          workspaceId: input.workspace.id,
          workspacePath,
          branchName: input.workspace.branchName,
          providerType: input.workspace.providerType,
        },
        successMessage: `Completed cleanup command "${command}"\n`,
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    const repoRoot = await resolveGitRepoRootForWorkspaceCleanup(
      workspacePath,
      input.projectWorkspace?.cwd ?? null,
    );
    const worktreeExists = await directoryExists(workspacePath);
    if (worktreeExists) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root for "${workspacePath}".`);
      } else {
        try {
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: ["worktree", "remove", "--force", workspacePath],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "worktree_remove",
            },
            successMessage: `Removed git worktree ${workspacePath}\n`,
            failureLabel: `git worktree remove ${workspacePath}`,
          });
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (createdByRuntime && input.workspace.branchName) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root to delete branch "${input.workspace.branchName}".`);
      } else {
        try {
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: ["branch", "-d", input.workspace.branchName],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "branch_delete",
            },
            successMessage: `Deleted branch ${input.workspace.branchName}\n`,
            failureLabel: `git branch -d ${input.workspace.branchName}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Skipped deleting branch "${input.workspace.branchName}": ${message}`);
        }
      }
    }
  } else if (input.workspace.providerType === "local_fs" && createdByRuntime && workspacePath) {
    const projectWorkspaceCwd = input.projectWorkspace?.cwd ? path.resolve(input.projectWorkspace.cwd) : null;
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const containsProjectWorkspace = projectWorkspaceCwd
      ? (
          resolvedWorkspacePath === projectWorkspaceCwd ||
          projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
        )
      : false;
    if (containsProjectWorkspace) {
      warnings.push(`Refusing to remove path "${workspacePath}" because it contains the project workspace.`);
    } else if (!input.workspace.orgId) {
      warnings.push(`Refusing to remove path "${workspacePath}" because its organization is unknown.`);
    } else {
      const safeCleanupTarget = await resolveManagedLocalWorkspaceCleanupTarget({
        orgId: input.workspace.orgId,
        workspacePath: resolvedWorkspacePath,
      });
      if (safeCleanupTarget.refusalReason) {
        warnings.push(`Refusing to remove path "${workspacePath}" because ${safeCleanupTarget.refusalReason}.`);
      } else if (safeCleanupTarget.targetPath) {
        await fs.rm(safeCleanupTarget.targetPath, { recursive: true, force: true });
      }
      if (input.recorder) {
        await input.recorder.recordOperation({
          phase: "workspace_teardown",
          cwd: projectWorkspaceCwd ?? process.cwd(),
          metadata: {
            workspaceId: input.workspace.id,
            workspacePath: resolvedWorkspacePath,
            cleanupAction: safeCleanupTarget.targetPath ? "remove_local_fs" : "skip_remove_local_fs",
          },
          run: async () => ({
            status: "succeeded",
            exitCode: 0,
            system: safeCleanupTarget.targetPath
              ? `Removed local workspace directory ${resolvedWorkspacePath}\n`
              : `Skipped removing local workspace directory ${resolvedWorkspacePath}\n`,
          }),
        });
      }
    }
  }

  const cleaned =
    !workspacePath ||
    !(await directoryExists(workspacePath));

  return {
    cleanedPath: workspacePath,
    cleaned,
    warnings,
  };
}
