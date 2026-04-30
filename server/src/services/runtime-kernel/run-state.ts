import type { AgentRuntimeInvocationMeta } from "../../agent-runtimes/index.js";
import { parseObject } from "../../agent-runtimes/utils.js";
import type {
  ExecutionObservabilitySurface,
} from "@rudderhq/shared";
import type { heartbeatRuns } from "@rudderhq/db";
import { summarizeRuntimeSkillsForTrace } from "../runtime-trace-metadata.js";
import { inferUsedSkillsFromPrompt, normalizeLoadedSkill } from "./analytics.js";
import { readNonEmptyString } from "./common.js";

export function resolveHeartbeatObservabilitySurface(
  contextSnapshot: Record<string, unknown> | null | undefined,
): ExecutionObservabilitySurface {
  return readNonEmptyString(contextSnapshot?.issueId) ? "issue_run" : "heartbeat_run";
}

export function buildHeartbeatObservationName(
  run: typeof heartbeatRuns.$inferSelect,
  agentName: string,
): string {
  const contextSnapshot = parseObject(run.contextSnapshot);
  const issueId = readNonEmptyString(contextSnapshot.issueId);
  return issueId ? `issue_run:${issueId}` : `heartbeat:${agentName}`;
}

function compactTraceText(value: string | null | undefined, maxLength = 120) {
  const next = value?.replace(/\s+/g, " ").trim();
  if (!next) return null;
  return next.length > maxLength ? `${next.slice(0, maxLength - 1)}…` : next;
}

export function buildIssueRunTraceName(input: { issueTitle?: string | null; issueId: string }) {
  const issueTitle = compactTraceText(input.issueTitle);
  return issueTitle ? `issue_run:${issueTitle} [${input.issueId}]` : `issue_run:[${input.issueId}]`;
}

export function buildHeartbeatRuntimeTraceMetadata(input: {
  runtimeConfig: Record<string, unknown>;
  runtimeSkills: Array<{
    key: string;
    runtimeName: string;
    name: string | null;
    description: string | null;
  }>;
  adapterMeta?: Pick<AgentRuntimeInvocationMeta, "agentRuntimeType" | "command" | "cwd" | "commandNotes" | "promptMetrics"> | null;
}) {
  const instructionsFilePath = readNonEmptyString(input.runtimeConfig.instructionsFilePath);
  return {
    instructionsConfigured: Boolean(instructionsFilePath),
    instructionsFilePath,
    ...summarizeRuntimeSkillsForTrace(input.runtimeSkills),
    ...(input.adapterMeta
      ? {
        runtimeAgentType: input.adapterMeta.agentRuntimeType,
        runtimeCommand: input.adapterMeta.command,
        runtimeCwd: input.adapterMeta.cwd ?? null,
        runtimeCommandNotes: input.adapterMeta.commandNotes ?? [],
        runtimePromptMetrics: input.adapterMeta.promptMetrics ?? null,
      }
      : {}),
  };
}

export function buildHeartbeatAdapterInvokePayload(input: {
  meta: AgentRuntimeInvocationMeta;
  runtimeSkills: Array<{
    key: string;
    runtimeName: string;
    name: string | null;
    description: string | null;
  }>;
}): Record<string, unknown> {
  const explicitUsedSkills = Array.isArray(input.meta.usedSkills)
    ? input.meta.usedSkills
      .map((entry) => normalizeLoadedSkill(entry))
      .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    : [];
  const usedSkills = explicitUsedSkills.length > 0
    ? explicitUsedSkills
    : inferUsedSkillsFromPrompt(input.meta.prompt, input.runtimeSkills);

  return {
    ...input.meta,
    ...summarizeRuntimeSkillsForTrace(input.runtimeSkills),
    usedSkillCount: usedSkills.length,
    usedSkillKeys: usedSkills.map((entry) => entry.key),
    usedSkills,
  } as Record<string, unknown>;
}
