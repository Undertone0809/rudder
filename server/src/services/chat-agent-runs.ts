import type { AgentRuntimeNetworkSuspension, TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { chatMessages, goals, heartbeatRuns } from "@rudderhq/db";
import { toHeartbeatRun, type ChatConversation, type HeartbeatRun } from "@rudderhq/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentRuntimeInvocationMeta } from "../agent-runtimes/index.js";
import { summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import { publishLiveEvent } from "./live-events.js";
import { isPostgresError } from "./postgres-errors.js";
import { appendHeartbeatRunEvent } from "./run-events.js";
import { buildHeartbeatAdapterInvokePayload, networkWaitBackoffMs } from "./runtime-kernel/heartbeat.core.js";
import {
  claimExpiredHeartbeatRunExecution,
  reconcileHeartbeatRunEvidence,
  renewHeartbeatRunExecutionLease,
  RUN_EXECUTION_LEASE_MS,
  RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS,
  transitionHeartbeatRunToTerminal,
} from "./runtime-kernel/heartbeat.terminal.js";

const MAX_EVENT_TEXT_CHARS = 2_000;
const ACTIVE_CHAT_RUN_UNIQUE_INDEX = "heartbeat_runs_active_chat_conversation_uq";
const ownedChatRuns = new Map<string, {
  ownerToken: string;
  renewalTimer: ReturnType<typeof setInterval> | null;
}>();

function stopRenewingChatRun(runId: string, ownerToken: string) {
  const owned = ownedChatRuns.get(runId);
  if (!owned || owned.ownerToken !== ownerToken || !owned.renewalTimer) return;
  clearInterval(owned.renewalTimer);
  owned.renewalTimer = null;
}

function stopOwningChatRun(runId: string, ownerToken?: string | null) {
  const owned = ownedChatRuns.get(runId);
  if (!owned || (ownerToken && owned.ownerToken !== ownerToken)) return;
  if (owned.renewalTimer) clearInterval(owned.renewalTimer);
  ownedChatRuns.delete(runId);
}

type RuntimeSkillSummary = Array<{
  key: string;
  runtimeName?: string | null;
  name?: string | null;
  description?: string | null;
}>;

function boundedText(value: string | null | undefined, max = MAX_EVENT_TEXT_CHARS) {
  if (!value) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function transcriptEventPayload(entry: TranscriptEntry): Record<string, unknown> {
  if ("text" in entry && typeof entry.text === "string") {
    return {
      ...entry,
      text: boundedText(entry.text),
      truncated: entry.text.length > MAX_EVENT_TEXT_CHARS,
    };
  }
  return entry as unknown as Record<string, unknown>;
}

function serializeRun(row: typeof heartbeatRuns.$inferSelect): HeartbeatRun {
  return toHeartbeatRun({
    ...row,
    invocationSource: row.invocationSource as HeartbeatRun["invocationSource"],
    triggerDetail: row.triggerDetail as HeartbeatRun["triggerDetail"],
    status: row.status as HeartbeatRun["status"],
    contextSnapshot: row.contextSnapshot as HeartbeatRun["contextSnapshot"],
  });
}

function isActiveChatRunConflict(error: unknown) {
  return isPostgresError(error, "23505", ACTIVE_CHAT_RUN_UNIQUE_INDEX);
}

export function chatAgentRunService(db: Db) {
  async function appendEvent(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const owned = ownedChatRuns.get(run.id);
    if (owned) {
      await renewHeartbeatRunExecutionLease(db, run.id, owned.ownerToken);
    }
    const message = boundedText(event.message, 500);
    const inserted = await appendHeartbeatRunEvent(db, {
      orgId: run.orgId,
      runId: run.id,
      agentId: run.agentId,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      message,
      payload: event.payload,
    });

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq: inserted.seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        message,
        payload: event.payload ?? null,
      },
    });
  }

  async function createRun(input: {
    conversation: Pick<ChatConversation, "id" | "orgId" | "primaryIssueId" | "planMode">;
    agentId: string;
    triggerDetail: "chat_assistant_reply" | "chat_assistant_reply_stream";
    userMessageId?: string | null;
    chatTurnId?: string | null;
    turnVariant?: number | null;
    linkedIssueIds: string[];
    linkedProjectId: string | null;
    linkedGoalId?: string | null;
    runContext?: Record<string, unknown> | null;
    sourceMetadata?: Record<string, unknown> | null;
  }) {
    const linkedGoalId = input.linkedGoalId ?? null;
    if (linkedGoalId) {
      const [goal] = await db
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.id, linkedGoalId), eq(goals.orgId, input.conversation.orgId)))
        .limit(1);
      if (!goal) {
        throw new Error("Chat conversation Goal must belong to the same organization");
      }
    }
    const now = new Date();
    const executionOwnerToken = randomUUID();
    const issueId = input.conversation.primaryIssueId ?? input.linkedIssueIds[0] ?? null;
    const linkedIssueIds = [...new Set([issueId, ...input.linkedIssueIds].filter((value): value is string => Boolean(value)))];
    const contextSnapshot = {
      scene: "chat",
      targetType: "chat_conversation",
      targetId: input.conversation.id,
      conversationId: input.conversation.id,
      messageId: input.userMessageId ?? null,
      userMessageId: input.userMessageId ?? null,
      chatTurnId: input.chatTurnId ?? null,
      turnVariant: input.turnVariant ?? 0,
      issueId,
      linkedIssueIds,
      projectId: input.linkedProjectId,
      planMode: input.conversation.planMode,
      stream: input.triggerDetail === "chat_assistant_reply_stream",
      controlIntent: "new",
      ...(input.sourceMetadata ?? {}),
      ...(input.runContext ?? {}),
      // The explicit column is authoritative; keep the compatibility snapshot
      // aligned even when runtime context contains a stale Goal value.
      goalId: linkedGoalId,
    };
    const run = await db
      .insert(heartbeatRuns)
      .values({
        orgId: input.conversation.orgId,
        agentId: input.agentId,
        invocationSource: "chat",
        triggerDetail: input.triggerDetail,
        status: "running",
        startedAt: now,
        sessionReuseScope: "none",
        executionOwnerToken,
        executionLeaseExpiresAt: new Date(now.getTime() + RUN_EXECUTION_LEASE_MS),
        chatConversationId: input.conversation.id,
        goalId: linkedGoalId,
        contextSnapshot,
      })
      .returning()
      .then((rows) => rows[0])
      .catch((error: unknown) => {
        if (isActiveChatRunConflict(error)) {
          throw new Error("A chat assistant run is already active for this conversation");
        }
        throw error;
      });
    if (!run) throw new Error("Failed to create chat agent run");

    const renewalTimer = setInterval(() => {
      void renewHeartbeatRunExecutionLease(db, run.id, executionOwnerToken).then((renewed) => {
        // Keep the original token until finalization so a late completion stays
        // fenced after recovery has claimed the run with a replacement owner.
        if (!renewed) stopRenewingChatRun(run.id, executionOwnerToken);
      }).catch(() => undefined);
    }, RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS);
    renewalTimer.unref?.();
    ownedChatRuns.set(run.id, { ownerToken: executionOwnerToken, renewalTimer });

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.status",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
      },
    });
    await appendEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "chat run started",
      payload: { scene: "chat", conversationId: input.conversation.id },
    });
    return serializeRun(run);
  }

  /**
   * Reattach the in-process lease to a Chat run claimed by the durable
   * heartbeat recovery coordinator. The coordinator already fenced the row;
   * this method only restores the renewal timer without creating a duplicate
   * active Chat run.
   */
  async function adoptRecoveredRun(
    runId: string,
    ownerToken: string,
  ) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.invocationSource, "chat"),
        eq(heartbeatRuns.executionOwnerToken, ownerToken),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;

    stopOwningChatRun(runId);
    const renewalTimer = setInterval(() => {
      void renewHeartbeatRunExecutionLease(db, runId, ownerToken).then((renewed) => {
        if (!renewed) stopRenewingChatRun(runId, ownerToken);
      }).catch(() => undefined);
    }, RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS);
    renewalTimer.unref?.();
    ownedChatRuns.set(runId, { ownerToken, renewalTimer });
    return {
      ...serializeRun(run),
      // Kept internal to the server-owned recovery path; public run serializers
      // intentionally do not expose session parameters.
      sessionParamsBeforeJson: run.sessionParamsBeforeJson ?? null,
    };
  }

  function releaseOwnedRun(runId: string, ownerToken?: string | null) {
    stopOwningChatRun(runId, ownerToken);
  }

  async function appendAdapterInvoke(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">,
    meta: AgentRuntimeInvocationMeta,
    runtimeSkills: RuntimeSkillSummary,
  ) {
    await appendEvent(run, {
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: buildHeartbeatAdapterInvokePayload({
        meta,
        runtimeSkills: runtimeSkills.map((entry) => ({
          key: entry.key,
          runtimeName: entry.runtimeName ?? entry.key,
          name: entry.name ?? null,
          description: entry.description ?? null,
        })),
      }),
    });
  }

  async function appendTranscriptEntry(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">,
    entry: TranscriptEntry,
  ) {
    await appendEvent(run, {
      eventType: "transcript.entry",
      stream: entry.kind === "stderr" ? "stderr" : entry.kind === "stdout" ? "stdout" : "system",
      level: entry.kind === "stderr" ? "warn" : "info",
      message: "chat transcript entry",
      payload: transcriptEventPayload(entry),
    });
  }

  /**
   * Record a durable, non-terminal provider transport interruption. The run
   * remains owned by the recovery coordinator; this event is deliberately
   * informational so it never enters failed-run or terminal-effect paths.
   */
  async function markWaitingForNetwork(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">,
    suspension: AgentRuntimeNetworkSuspension,
  ) {
    const now = new Date();
    const current = await db
      .select({ networkWaitAttemptCount: heartbeatRuns.networkWaitAttemptCount })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const attempt = (current?.networkWaitAttemptCount ?? 0) + 1;
    const backoff = networkWaitBackoffMs(attempt);
    const nextRetryAt = new Date(now.getTime() + backoff);
    await db
      .update(heartbeatRuns)
      .set({
        runningSubstate: "waiting_for_network",
        networkWaitStartedAt: now,
        networkWaitNextRetryAt: nextRetryAt,
        networkWaitAttemptCount: attempt,
        recoveryCheckpoint: { ...suspension, observedAt: now.toISOString() },
        sessionIdBefore: suspension.sessionId ?? null,
        sessionParamsBeforeJson: suspension.sessionParams ?? null,
        sessionReuseScope: suspension.sessionId || suspension.sessionParams ? "explicit" : "none",
        processExitedAt: now,
        processPid: null,
        processStartedAt: null,
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")));
    await appendEvent(run, {
      eventType: "network.waiting",
      stream: "system",
      level: "info",
      message: "chat run waiting for network",
      payload: {
        kind: suspension.kind,
        code: suspension.code,
        transport: suspension.transport,
        provider: suspension.provider ?? null,
        model: suspension.model ?? null,
        submissionPhase: suspension.submissionPhase,
        continuation: suspension.continuation,
        progress: suspension.progress,
        attempt,
        nextRetryAt: nextRetryAt.toISOString(),
      },
    });
  }

  async function linkAssistantMessage(runId: string, conversationId: string, messageId: string) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;

    const [message] = await db
      .update(chatMessages)
      .set({ runId, updatedAt: new Date() })
      .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
      .returning();
    if (!message) return null;

    const contextSnapshot = {
      ...((run.contextSnapshot ?? {}) as Record<string, unknown>),
      assistantMessageId: messageId,
      messageId,
    };
    const [updated] = await db
      .update(heartbeatRuns)
      .set({ contextSnapshot, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning();
    const nextRun = updated ?? run;

    await appendEvent(nextRun, {
      eventType: "chat.message_linked",
      stream: "system",
      level: "info",
      message: "assistant message linked",
      payload: {
        conversationId,
        assistantMessageId: messageId,
      },
    });
    return message ?? null;
  }

  async function finalizeRun(
    runId: string,
    input: {
      status: "succeeded" | "failed" | "cancelled" | "timed_out";
      error?: string | null;
      errorCode?: string | null;
      resultJson?: Record<string, unknown> | null;
      usageJson?: Record<string, unknown> | null;
    },
  ) {
    const evidence = {
      resultJson: input.resultJson ?? null,
      resultSummaryJson: summarizeHeartbeatRunResultJson(input.resultJson),
      usageJson: input.usageJson ?? null,
    };
    const owned = ownedChatRuns.get(runId);
    const updated = await transitionHeartbeatRunToTerminal(db, {
      runId,
      status: input.status,
      patch: {
        finishedAt: new Date(),
        error: input.error ?? null,
        errorCode: input.errorCode ?? null,
        ...evidence,
      },
      expectedStatuses: ["queued", "running"],
      terminalEffectsPending: false,
      processExitedAt: new Date(),
      expectedExecutionOwnerToken: owned?.ownerToken,
    });
    stopOwningChatRun(runId, owned?.ownerToken);
    if (!updated) {
      await reconcileHeartbeatRunEvidence(db, runId, evidence);
      return db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ? serializeRun(rows[0]) : null);
    }

    publishLiveEvent({
      orgId: updated.orgId,
      type: "heartbeat.run.status",
      payload: {
        runId: updated.id,
        agentId: updated.agentId,
        status: updated.status,
      },
    });
    await appendEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: input.status === "succeeded" ? "info" : input.status === "cancelled" ? "warn" : "error",
      message: `chat run ${input.status}`,
      payload: {
        status: input.status,
        errorCode: input.errorCode ?? null,
      },
    });
    return serializeRun(updated);
  }

  async function finalizeStaleRuns(input: {
    conversationId?: string | null;
    olderThanMs?: number;
    error?: string;
    errorCode?: string;
    now?: Date;
    recoveryCutoff?: Date;
  } = {}) {
    const olderThanMs = input.olderThanMs ?? 30 * 60_000;
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - olderThanMs);
    const recoveryCutoff = input.recoveryCutoff ?? now;
    const conditions = [
      sql`${heartbeatRuns.chatConversationId} is not null`,
      inArray(heartbeatRuns.status, ["queued", "running"]),
      sql`${heartbeatRuns.updatedAt} < ${cutoff.toISOString()}::timestamptz`,
    ];
    if (input.conversationId) {
      conditions.push(eq(heartbeatRuns.chatConversationId, input.conversationId));
    }
    const staleRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.updatedAt));
    let finalized = 0;
    for (const run of staleRuns) {
      const claim = await claimExpiredHeartbeatRunExecution(db, run.id, { now, recoveryCutoff });
      if (!claim) continue;
      const terminal = await transitionHeartbeatRunToTerminal(db, {
        runId: run.id,
        status: "timed_out",
        patch: {
          finishedAt: now,
          error: input.error ?? "Chat run execution lease expired",
          errorCode: input.errorCode ?? "chat_run_stale",
        },
        expectedStatuses: ["queued", "running"],
        terminalEffectsPending: false,
        processExitedAt: now,
        expectedExecutionOwnerToken: claim.ownerToken,
      });
      if (terminal) {
        finalized += 1;
        stopOwningChatRun(run.id);
      }
    }
    return finalized;
  }

  return {
    appendAdapterInvoke,
    appendEvent,
    appendTranscriptEntry,
    createRun,
    adoptRecoveredRun,
    releaseOwnedRun,
    finalizeRun,
    finalizeStaleRuns,
    linkAssistantMessage,
    markWaitingForNetwork,
  };
}
