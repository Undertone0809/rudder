import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { chatMessages, heartbeatRunEvents, heartbeatRuns } from "@rudderhq/db";
import type { ChatConversation, HeartbeatRun } from "@rudderhq/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AgentRuntimeInvocationMeta } from "../agent-runtimes/index.js";
import { publishLiveEvent } from "./live-events.js";
import { buildHeartbeatAdapterInvokePayload } from "./runtime-kernel/heartbeat.core.js";

const MAX_EVENT_TEXT_CHARS = 2_000;
const ACTIVE_CHAT_RUN_UNIQUE_INDEX = "heartbeat_runs_active_chat_conversation_uq";

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
  return {
    ...row,
    invocationSource: row.invocationSource as HeartbeatRun["invocationSource"],
    triggerDetail: row.triggerDetail as HeartbeatRun["triggerDetail"],
    status: row.status as HeartbeatRun["status"],
    contextSnapshot: row.contextSnapshot as HeartbeatRun["contextSnapshot"],
  };
}

function isActiveChatRunConflict(error: unknown) {
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return candidate.code === "23505"
    && (
      candidate.constraint === ACTIVE_CHAT_RUN_UNIQUE_INDEX
      || (typeof candidate.message === "string" && candidate.message.includes(ACTIVE_CHAT_RUN_UNIQUE_INDEX))
    );
}

export function chatAgentRunService(db: Db) {
  async function nextSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

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
    const seq = await nextSeq(run.id);
    await db.insert(heartbeatRunEvents).values({
      orgId: run.orgId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      message: boundedText(event.message, 500),
      payload: event.payload,
    });

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        message: boundedText(event.message, 500),
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
  }) {
    const now = new Date();
    const issueId = input.conversation.primaryIssueId ?? input.linkedIssueIds[0] ?? null;
    const linkedIssueIds = [...new Set([issueId, ...input.linkedIssueIds].filter((value): value is string => Boolean(value)))];
    const contextSnapshot = {
      scene: "chat",
      conversationId: input.conversation.id,
      userMessageId: input.userMessageId ?? null,
      chatTurnId: input.chatTurnId ?? null,
      turnVariant: input.turnVariant ?? 0,
      issueId,
      linkedIssueIds,
      projectId: input.linkedProjectId,
      planMode: input.conversation.planMode,
      stream: input.triggerDetail === "chat_assistant_reply_stream",
      controlIntent: "new",
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
        chatConversationId: input.conversation.id,
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
    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        status: input.status,
        finishedAt: new Date(),
        error: input.error ?? null,
        errorCode: input.errorCode ?? null,
        resultJson: input.resultJson ?? null,
        usageJson: input.usageJson ?? null,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning();
    if (!updated) return null;

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
  } = {}) {
    const olderThanMs = input.olderThanMs ?? 30 * 60_000;
    const cutoff = new Date(Date.now() - olderThanMs);
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
    for (const run of staleRuns) {
      await finalizeRun(run.id, {
        status: "timed_out",
        error: input.error ?? "Chat run was left active without an in-memory generation",
        errorCode: input.errorCode ?? "chat_run_stale",
      });
    }
    return staleRuns.length;
  }

  return {
    appendAdapterInvoke,
    appendEvent,
    appendTranscriptEntry,
    createRun,
    finalizeRun,
    finalizeStaleRuns,
    linkAssistantMessage,
  };
}
