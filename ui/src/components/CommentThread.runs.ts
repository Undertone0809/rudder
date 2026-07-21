import type { Agent } from "@rudderhq/shared";
import type { LiveRunForIssue } from "../api/agent-runs";

export interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
  invocationSource?: string;
  triggerDetail?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
}

export function commentThreadTranscriptRuns(
  linkedRuns: LinkedRunItem[],
  agentMap?: Map<string, Agent>,
): LiveRunForIssue[] {
  return linkedRuns.map((run) => {
    const agent = agentMap?.get(run.agentId);
    return {
      id: run.runId,
      status: run.status,
      invocationSource: "issue_timeline",
      triggerDetail: null,
      startedAt: typeof run.startedAt === "string" ? run.startedAt : run.startedAt?.toISOString() ?? null,
      finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : run.finishedAt?.toISOString() ?? null,
      createdAt: typeof run.createdAt === "string" ? run.createdAt : run.createdAt.toISOString(),
      agentId: run.agentId,
      agentName: agent?.name ?? run.agentId.slice(0, 8),
      agentRuntimeType: agent?.agentRuntimeType ?? "process",
      issueId: null,
      resultJson: run.resultJson ?? null,
    };
  });
}
