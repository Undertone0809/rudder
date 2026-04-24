import { logger } from "../middleware/logger.js";
import { extractCreateAgentBenchmarkMetadata } from "@rudderhq/run-intelligence-core";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

// Issue fields to include in context snapshot
interface IssueContextSnapshot {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
}

function buildIssueContextSnapshot(issue: {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
}): IssueContextSnapshot {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
  };
}

function buildBenchmarkContextSnapshot(description: string | null | undefined) {
  const metadata = extractCreateAgentBenchmarkMetadata(description);
  return metadata ? { benchmark: metadata } : {};
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: {
    id: string;
    assigneeAgentId: string | null;
    status: string;
    title: string;
    description?: string | null;
    priority?: string | null;
  };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        wakeSource: "assignment",
        wakeReason: input.reason,
        issue: buildIssueContextSnapshot(input.issue),
        ...buildBenchmarkContextSnapshot(input.issue.description),
      },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
