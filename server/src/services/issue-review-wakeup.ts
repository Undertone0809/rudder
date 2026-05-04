import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "review" | "on_demand" | "automation";

export interface IssueReviewWakeupDeps {
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

export type IssueReviewWakeupMutation = "status_to_in_review" | "reviewer_changed_in_review" | "create_in_review";

export function buildIssueReviewWakeupOptions(input: {
  issue: {
    id: string;
    identifier?: string | null;
    title: string;
    description?: string | null;
    status: string;
    priority?: string | null;
  };
  mutation: IssueReviewWakeupMutation;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}) {
  return {
    source: "review" as const,
    triggerDetail: "system" as const,
    reason: "issue_review_requested",
    payload: { issueId: input.issue.id, mutation: input.mutation },
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId ?? null,
    contextSnapshot: {
      issueId: input.issue.id,
      source: input.contextSource,
      wakeSource: "review",
      wakeReason: "issue_review_requested",
      role: "reviewer",
      issue: {
        id: input.issue.id,
        identifier: input.issue.identifier ?? null,
        title: input.issue.title,
        description: input.issue.description,
        status: input.issue.status,
        priority: input.issue.priority,
      },
      reviewInstructions:
        "You are the reviewer for this issue. Review the result and leave feedback, request changes, or mark the issue done. Do not take over implementation unless explicitly asked.",
    },
  };
}

export function queueIssueReviewWakeup(input: {
  heartbeat: IssueReviewWakeupDeps;
  issue: {
    id: string;
    identifier?: string | null;
    reviewerAgentId: string | null;
    status: string;
    title: string;
    description?: string | null;
    priority?: string | null;
  };
  mutation: IssueReviewWakeupMutation;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  actorAgentId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.reviewerAgentId || input.issue.status !== "in_review") return;
  if (input.actorAgentId && input.issue.reviewerAgentId === input.actorAgentId) return;

  return input.heartbeat
    .wakeup(input.issue.reviewerAgentId, buildIssueReviewWakeupOptions(input))
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake reviewer on issue review request");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
