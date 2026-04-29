import path from "node:path";
import type { AgentRuntimeSessionCodec } from "../../agent-runtimes/index.js";
import type { agents } from "@rudderhq/db";
import { parseObject } from "../../agent-runtimes/utils.js";
import { resolveDefaultAgentWorkspaceDir } from "../../home-paths.js";
import type { ResolvedWorkspaceForRun } from "../agent-run-context.js";
import {
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@rudderhq/agent-runtime-utils";
import { readNonEmptyString, truncateDisplayId } from "./common.js";

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AgentRuntimeSessionCodec;
}) {
  const desiredDisplayId = truncateDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = normalizeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId ? input.sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (
      input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId)
    );
  const sessionParams =
    canReuseTaskSessionParams
      ? taskSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.agentRuntimeType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  orgId: string;
  agent: {
    id: string;
    name?: string | null;
    workspaceKey?: string | null;
  };
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { orgId, agent, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  if (!previousSessionId) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const canonicalAgentCwd = readNonEmptyString(resolvedWorkspace.cwd) ?? resolveDefaultAgentWorkspaceDir(orgId, agent);
  if (!canonicalAgentCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (previousCwd && path.resolve(previousCwd) === path.resolve(canonicalAgentCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: canonicalAgentCwd,
  };
  if (
    !previousWorkspaceId ||
    !resolvedWorkspace.workspaceId ||
    previousWorkspaceId === resolvedWorkspace.workspaceId
  ) {
    if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
    if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
    if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;
  }

  return {
    sessionParams: migratedSessionParams,
    warning:
      previousCwd
        ? `Agent workspace "${canonicalAgentCwd}" is now the canonical run workspace. ` +
          `Attempting to resume session "${previousSessionId}" that was previously saved in "${previousCwd}".`
        : `Agent workspace "${canonicalAgentCwd}" is now the canonical run workspace. ` +
          `Attempting to resume session "${previousSessionId}" with the canonical agent workspace attached.`,
  };
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[rudder] ${warning}\n`,
  };
}

export const defaultSessionCodec: AgentRuntimeSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};
