// @ts-nocheck
import { buildModelAttemptSpecs } from "@rudderhq/agent-runtime-utils";
import { goals, heartbeatRuns, issues, projects } from "@rudderhq/db";
import { resolveAgentRunScene, type HeartbeatRun } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { parseObject } from "../../agent-runtimes/utils.js";
import { resolveDefaultAgentWorkspaceDir } from "../../home-paths.js";
import { logger } from "../../middleware/logger.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  realizeExecutionWorkspace,
} from "../workspace-runtime.js";
import {
  createAssignmentRunFailureBudget,
  type AssignmentRunGuardrailCheckpoint,
} from "./assignment-run-guardrail.js";
import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";

const {
  readNonEmptyString,
} = heartbeatCore;
const {
  describeSessionResetReason,
  deriveTaskKey,
  formatRuntimeWorkspaceWarningLog,
  getAgentRuntimeSessionCodec,
  normalizeSessionParams,
  parseIssueAssigneeAgentRuntimeOverrides,
  resolveRuntimeSessionParamsForWorkspace,
  selectRunSessionLineage,
  shouldResetTaskSessionForWake,
  truncateDisplayId,
} = heartbeatSessions;

function resolveRuntimeSceneForRun(run: typeof heartbeatRuns.$inferSelect) {
  return resolveAgentRunScene({
    ...run,
    invocationSource: run.invocationSource as HeartbeatRun["invocationSource"],
    triggerDetail: run.triggerDetail as HeartbeatRun["triggerDetail"],
    status: run.status as HeartbeatRun["status"],
    contextSnapshot: run.contextSnapshot as HeartbeatRun["contextSnapshot"],
  });
}

export async function prepareHeartbeatRunExecution(input: any) {
  const {
    db,
    run: initialRun,
    agent,
    assignmentContinuationAttempt: initialAssignmentContinuationAttempt,
    ensureRuntimeState,
    getTaskSession,
    evaluateSessionCompaction,
    runContextSvc,
    executionWorkspacesSvc,
    workspaceOperationsSvc,
    issuesSvc,
    persistRunningExecutionContext,
  } = input;
  let run = initialRun;
  let assignmentContinuationAttempt = initialAssignmentContinuationAttempt;
  await ensureRuntimeState(agent);
  const context = parseObject(run.contextSnapshot);
  delete context.rudderGitIdentity;
  assignmentContinuationAttempt = Math.max(
    0,
    Math.floor(Number(context.assignmentGuardrailContinuationAttempt) || 0),
  );
  const assignmentGuardrailEnabled = run.invocationSource === "assignment"
    || context.wakeSource === "assignment"
    || run.invocationSource === "automation"
    || assignmentContinuationAttempt > 0;
  const assignmentFailureBudget = assignmentGuardrailEnabled ? createAssignmentRunFailureBudget() : null;
  let assignmentGuardrailCheckpoint: AssignmentRunGuardrailCheckpoint | null = null;
  const taskKey = deriveTaskKey(context, null);
  const sessionCodec = getAgentRuntimeSessionCodec(agent.agentRuntimeType);
  const issueId = readNonEmptyString(context.issueId);
  const issueContext = issueId
    ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          executionWorkspaceId: issues.executionWorkspaceId,
          executionWorkspacePreference: issues.executionWorkspacePreference,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeAgentRuntimeOverrides: issues.assigneeAgentRuntimeOverrides,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.orgId, agent.orgId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const goalId = readNonEmptyString(context.goalId);
  const goalContext = goalId
    ? await db
        .select({
          id: goals.id,
          ownerAgentId: goals.ownerAgentId,
          ownerAgentRuntimeOverrides: goals.ownerAgentRuntimeOverrides,
        })
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.orgId, agent.orgId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const issueAssigneeOverrides =
    issueContext && issueContext.assigneeAgentId === agent.id
      ? parseIssueAssigneeAgentRuntimeOverrides(
          issueContext.assigneeAgentRuntimeOverrides,
        )
      : null;
  const goalOwnerOverrides =
    goalContext && goalContext.ownerAgentId === agent.id
      ? parseIssueAssigneeAgentRuntimeOverrides(goalContext.ownerAgentRuntimeOverrides)
      : null;
  const runtimeOverrides = issueContext ? issueAssigneeOverrides : goalOwnerOverrides;
  const issueExecutionWorkspaceSettings = parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings);
  const contextProjectId = readNonEmptyString(context.projectId);
  const executionProjectId = issueContext?.projectId ?? contextProjectId;
  const projectExecutionWorkspacePolicy = executionProjectId
    ? await db
        .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
        .from(projects)
        .where(and(eq(projects.id, executionProjectId), eq(projects.orgId, agent.orgId)))
        .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
    : null;
  const taskSession = taskKey
    ? await getTaskSession(agent.orgId, agent.id, agent.agentRuntimeType, taskKey)
    : null;
  const resetTaskSession = run.sessionReuseScope === "unknown"
    ? shouldResetTaskSessionForWake(context)
    : run.sessionReuseScope === "none" && shouldResetTaskSessionForWake(context);
  const sessionResetReason = describeSessionResetReason(context);
  const taskSessionForRun = resetTaskSession ? null : taskSession;
  const explicitResumeSessionParams = normalizeSessionParams(
    sessionCodec.deserialize(parseObject(context.resumeSessionParams)),
  );
  const explicitResumeSessionDisplayId = truncateDisplayId(
    readNonEmptyString(context.resumeSessionDisplayId) ??
      (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitResumeSessionParams) : null) ??
      readNonEmptyString(explicitResumeSessionParams?.sessionId),
  );
  const taskSessionParams = normalizeSessionParams(
    sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    taskSessionForRun?.sessionDisplayId ??
      (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const frozenSessionParams = normalizeSessionParams(
    sessionCodec.deserialize(run.sessionParamsBeforeJson ?? null),
  );
  const frozenSessionDisplayId = truncateDisplayId(
    run.sessionIdBefore ??
      (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(frozenSessionParams) : null) ??
      readNonEmptyString(frozenSessionParams?.sessionId),
  );
  const sessionSelection = run.sessionReuseScope === "unknown"
    ? selectRunSessionLineage({
        forceFresh: Boolean(heartbeatSessions.readSessionReuseSuppression(context)),
        explicitSessionParams: explicitResumeSessionParams,
        explicitSessionDisplayId: explicitResumeSessionDisplayId,
        taskSessionParams,
        taskSessionDisplayId,
      })
    : {
        reuseScope: run.sessionReuseScope,
        sessionParams: run.sessionReuseScope === "none" ? null : frozenSessionParams,
        sessionDisplayId: run.sessionReuseScope === "none" ? null : frozenSessionDisplayId,
      };
  const previousSessionParams = sessionSelection.sessionParams;
  const runtimeScene = resolveRuntimeSceneForRun(run);
  const config = await runContextSvc.materializeManagedInstructionsForRun({
    ...agent,
    agentRuntimeConfig: parseObject(agent.agentRuntimeConfig),
  });
  const executionWorkspaceMode = resolveExecutionWorkspaceMode({
    projectPolicy: projectExecutionWorkspacePolicy,
    issueSettings: issueExecutionWorkspaceSettings,
    legacyUseProjectWorkspace: runtimeOverrides?.useProjectWorkspace ?? null,
  });
  const resolvedWorkspace = await runContextSvc.resolveWorkspaceForRun(
    agent,
    context,
    previousSessionParams,
    { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
  );
  const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
    agentConfig: config,
    projectPolicy: projectExecutionWorkspacePolicy,
    issueSettings: issueExecutionWorkspaceSettings,
    mode: executionWorkspaceMode,
    legacyUseProjectWorkspace: runtimeOverrides?.useProjectWorkspace ?? null,
  });
  const mergedConfig = runtimeOverrides?.agentRuntimeConfig
    ? { ...workspaceManagedConfig, ...runtimeOverrides.agentRuntimeConfig }
    : workspaceManagedConfig;
  const { resolvedConfig, runtimeConfig, runtimeSkillEntries, secretKeys } =
    await runContextSvc.prepareRuntimeConfig({
      scene: runtimeScene,
      agent,
      baseConfig: mergedConfig,
    });
  context.managedMcpPolicySnapshot = runtimeConfig.managedExternalMcpBindings ?? [];
  const issueRef = issueContext
    ? {
        id: issueContext.id,
        identifier: issueContext.identifier,
        title: issueContext.title,
        projectId: issueContext.projectId,
        projectWorkspaceId: issueContext.projectWorkspaceId,
        executionWorkspaceId: issueContext.executionWorkspaceId,
        executionWorkspacePreference: issueContext.executionWorkspacePreference,
      }
    : null;
  const existingExecutionWorkspace =
    issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
  const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
    orgId: agent.orgId,
    heartbeatRunId: run.id,
    executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
  });
  const executionWorkspace = await realizeExecutionWorkspace({
    base: {
      baseCwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    },
    config: runtimeConfig,
    issue: issueRef,
    agent: {
      id: agent.id,
      name: agent.name,
      orgId: agent.orgId,
    },
    recorder: workspaceOperationRecorder,
  });
  const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
  const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
  const shouldReuseExisting =
    issueRef?.executionWorkspacePreference === "reuse_existing" &&
    existingExecutionWorkspace &&
    existingExecutionWorkspace.status !== "archived";
  let persistedExecutionWorkspace = null;
  try {
    persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
      ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
          cwd: executionWorkspace.cwd,
          repoUrl: executionWorkspace.repoUrl,
          baseRef: executionWorkspace.repoRef,
          branchName: executionWorkspace.branchName,
          providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
          providerRef: executionWorkspace.worktreePath,
          status: "active",
          lastUsedAt: new Date(),
          metadata: {
            ...(existingExecutionWorkspace.metadata ?? {}),
            source: executionWorkspace.source,
            createdByRuntime: executionWorkspace.created,
          },
        })
      : resolvedProjectId
        ? await executionWorkspacesSvc.create({
            orgId: agent.orgId,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            mode:
              executionWorkspaceMode === "isolated_workspace"
                ? "isolated_workspace"
                : executionWorkspaceMode === "operator_branch"
                  ? "operator_branch"
                  : executionWorkspaceMode === "agent_default"
                    ? "adapter_managed"
                    : "shared_workspace",
            strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
            name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
            status: "active",
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            lastUsedAt: new Date(),
            openedAt: new Date(),
            metadata: {
              source: executionWorkspace.source,
              createdByRuntime: executionWorkspace.created,
            },
          })
        : null;
  } catch (error) {
    if (executionWorkspace.created) {
      try {
        await cleanupExecutionWorkspaceArtifacts({
          workspace: {
            id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
            cwd: executionWorkspace.cwd,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            branchName: executionWorkspace.branchName,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            metadata: {
              createdByRuntime: true,
              source: executionWorkspace.source,
            },
          },
          projectWorkspace: {
            cwd: resolvedWorkspace.cwd,
            cleanupCommand: null,
          },
          teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
          recorder: workspaceOperationRecorder,
        });
      } catch (cleanupError) {
        logger.warn(
          {
            runId: run.id,
            issueId,
            executionWorkspaceCwd: executionWorkspace.cwd,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
          "Failed to cleanup realized run workspace after persistence failure",
        );
      }
    }
    throw error;
  }
  await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
  if (
    existingExecutionWorkspace &&
    persistedExecutionWorkspace &&
    existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
    existingExecutionWorkspace.status === "active"
  ) {
    await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
      status: "idle",
      cleanupReason: null,
    });
  }
  if (issueId && persistedExecutionWorkspace) {
    const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
    const shouldSwitchIssueToExistingWorkspace =
      issueRef?.executionWorkspacePreference === "reuse_existing" ||
      executionWorkspaceMode === "isolated_workspace" ||
      executionWorkspaceMode === "operator_branch";
    const nextIssuePatch: Record<string, unknown> = {};
    if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
      nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
    }
    if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
      nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
    }
    if (shouldSwitchIssueToExistingWorkspace) {
      nextIssuePatch.executionWorkspacePreference = "reuse_existing";
      nextIssuePatch.executionWorkspaceSettings = {
        ...(issueExecutionWorkspaceSettings ?? {}),
        mode: nextIssueWorkspaceMode,
      };
    }
    if (Object.keys(nextIssuePatch).length > 0) {
      await issuesSvc.update(issueId, nextIssuePatch);
    }
  }
  if (persistedExecutionWorkspace) {
    context.executionWorkspaceId = persistedExecutionWorkspace.id;
    const workspaceContextRun = await persistRunningExecutionContext(run.id, context);
    if (workspaceContextRun) run = workspaceContextRun;
  }
  const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
    orgId: agent.orgId,
    agent,
    previousSessionParams,
    resolvedWorkspace: {
      ...resolvedWorkspace,
      cwd: resolveDefaultAgentWorkspaceDir(agent.orgId, agent),
      source: "agent_home",
    },
  });
  const runtimeSessionParams = runtimeSessionResolution.sessionParams;
  const runtimeWorkspaceWarnings = [
    ...resolvedWorkspace.warnings,
    ...executionWorkspace.warnings,
    ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
    ...(resetTaskSession && sessionResetReason
      ? [
          taskKey
            ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
            : `Skipping saved session resume because ${sessionResetReason}.`,
        ]
      : []),
  ];
  const runtimeSceneContext = await runContextSvc.buildSceneContext({
    scene: runtimeScene,
    agent,
    resolvedWorkspace,
    runtimeConfig,
    issueId,
    executionWorkspaceMode,
    executionWorkspace: {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
    },
  });
  context.rudderScene = runtimeSceneContext.rudderScene;
  context.rudderWorkspace = runtimeSceneContext.rudderWorkspace;
  context.rudderWorkspaces = runtimeSceneContext.rudderWorkspaces;
  context.rudderStartupContext = runtimeSceneContext.rudderStartupContext;
  context.rudderStartupContextMetrics = runtimeSceneContext.rudderStartupContextMetrics;
  if (runtimeSceneContext.rudderRuntimeServiceIntents) {
    context.rudderRuntimeServiceIntents = runtimeSceneContext.rudderRuntimeServiceIntents;
  } else {
    delete context.rudderRuntimeServiceIntents;
  }
  if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
    context.projectId = executionWorkspace.projectId;
  }
  let previousSessionDisplayId = truncateDisplayId(
    sessionSelection.sessionDisplayId ??
      (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
      readNonEmptyString(runtimeSessionParams?.sessionId),
  );
  let runtimeSessionIdForAdapter =
    readNonEmptyString(runtimeSessionParams?.sessionId);
  let runtimeSessionParamsForAdapter = runtimeSessionParams;

  const sessionCompaction = await evaluateSessionCompaction({
    agent,
    sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
    issueId,
  });
  if (sessionCompaction.rotate) {
    context.rudderSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
    context.rudderSessionRotationReason = sessionCompaction.reason;
    context.rudderPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
    runtimeSessionIdForAdapter = null;
    runtimeSessionParamsForAdapter = null;
    previousSessionDisplayId = null;
    if (sessionCompaction.reason) {
      runtimeWorkspaceWarnings.push(
        `Starting a fresh session because ${sessionCompaction.reason}.`,
      );
    }
  } else {
    delete context.rudderSessionHandoffMarkdown;
    delete context.rudderSessionRotationReason;
    delete context.rudderPreviousSessionId;
  }
  const sessionReuseScope = sessionCompaction.rotate ? "none" : sessionSelection.reuseScope;

  const runtimeForAdapter = {
    sessionId: runtimeSessionIdForAdapter,
    sessionParams: runtimeSessionParamsForAdapter,
    sessionDisplayId: previousSessionDisplayId,
    taskKey,
  };
  const attemptStride = Math.max(1, buildModelAttemptSpecs(runtimeConfig, agent.agentRuntimeType).length);
  const recoveryAttemptOrdinal = Math.max(0, Math.floor(Number(run.networkWaitAttemptCount) || 0));
  const attemptResumeSource = recoveryAttemptOrdinal === 0
    ? "fresh"
    : run.recoveryCheckpoint?.continuation === "resume_same_session"
      ? "same_session"
      : "pristine_replay";
  const resolveLedgerAttemptIndex = (attempt: { index: number }) =>
    recoveryAttemptOrdinal * attemptStride + attempt.index;
  const recoveryStartAttemptIndex = recoveryAttemptOrdinal > 0
    && typeof run.recoveryCheckpoint?.fallbackIndex === "number"
    ? Math.max(0, Math.floor(run.recoveryCheckpoint.fallbackIndex))
    : 0;
  const persistAttempt = async (label: string, operation: () => Promise<unknown>) => {
    try {
      return await operation();
    } catch (error) {
      logger.warn({ err: error, runId: run.id, label }, "failed to persist heartbeat attempt ledger state");
      return null;
    }
  };

  return {
    run,
    assignmentContinuationAttempt,
    context,
    assignmentGuardrailEnabled,
    assignmentFailureBudget,
    assignmentGuardrailCheckpoint,
    taskKey,
    sessionCodec,
    issueId,
    issueContext,
    goalContext,
    runtimeOverrides,
    issueExecutionWorkspaceSettings,
    contextProjectId,
    executionProjectId,
    projectExecutionWorkspacePolicy,
    taskSession,
    resetTaskSession,
    sessionResetReason,
    taskSessionForRun,
    explicitResumeSessionParams,
    explicitResumeSessionDisplayId,
    taskSessionParams,
    taskSessionDisplayId,
    frozenSessionParams,
    frozenSessionDisplayId,
    sessionSelection,
    previousSessionParams,
    runtimeScene,
    config,
    executionWorkspaceMode,
    resolvedWorkspace,
    workspaceManagedConfig,
    mergedConfig,
    resolvedConfig,
    runtimeConfig,
    runtimeSkillEntries,
    secretKeys,
    issueRef,
    existingExecutionWorkspace,
    workspaceOperationRecorder,
    executionWorkspace,
    resolvedProjectId,
    resolvedProjectWorkspaceId,
    shouldReuseExisting,
    persistedExecutionWorkspace,
    runtimeSessionResolution,
    runtimeSessionParams,
    runtimeWorkspaceWarnings,
    runtimeSceneContext,
    previousSessionDisplayId,
    runtimeSessionIdForAdapter,
    runtimeSessionParamsForAdapter,
    sessionCompaction,
    sessionReuseScope,
    runtimeForAdapter,
    attemptStride,
    recoveryAttemptOrdinal,
    attemptResumeSource,
    resolveLedgerAttemptIndex,
    recoveryStartAttemptIndex,
    persistAttempt,
  };
}
