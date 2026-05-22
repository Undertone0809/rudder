import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  automations,
  automationRuns,
  chatConversations,
  chatMessages,
  issues,
} from "@rudderhq/db";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { CHAT_TRANSCRIPT_KEY } from "./chats.helpers.js";

function automationRunOutputBody(input: {
  output?: string | null;
  status?: string | null;
}) {
  const output = input.output?.trim();
  if (output) return output;
  if (input.status === "failed" || input.status === "timed_out") {
    return "Automation run failed before it produced a final response.";
  }
  return "Automation run completed.";
}

function chatMessageStatus(status?: string | null) {
  return status === "failed" || status === "timed_out" || status === "cancelled"
    ? "failed"
    : "completed";
}

export async function publishAutomationRunOutputToChat(
  db: Db,
  input: {
    issueId?: string | null;
    output?: string | null;
    status?: string | null;
    transcript?: TranscriptEntry[];
  },
) {
  if (!input.issueId) return null;

  const row = await db
    .select({
      issueId: issues.id,
      automationId: automations.id,
      automationTitle: automations.title,
      automationOutputMode: automations.outputMode,
      automationChatConversationId: automations.chatConversationId,
      assigneeAgentId: automations.assigneeAgentId,
      runId: automationRuns.id,
      orgId: automationRuns.orgId,
      linkedChatConversationId: automationRuns.linkedChatConversationId,
    })
    .from(issues)
    .innerJoin(automationRuns, eq(issues.originRunId, automationRuns.id))
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .where(and(eq(issues.id, input.issueId), eq(issues.originKind, "automation_execution")))
    .then((rows) => rows[0] ?? null);

  if (!row || row.automationOutputMode !== "chat_output") return null;

  let conversationId = row.linkedChatConversationId ?? row.automationChatConversationId;
  if (!conversationId) {
    const [conversation] = await db
      .insert(chatConversations)
      .values({
        orgId: row.orgId,
        title: row.automationTitle || "New chat",
        preferredAgentId: row.assigneeAgentId,
        status: "active",
        issueCreationMode: "manual_approval",
        planMode: false,
      })
      .returning({ id: chatConversations.id });
    conversationId = conversation?.id ?? null;
    if (!conversationId) return null;
    await db
      .update(automationRuns)
      .set({
        linkedChatConversationId: conversationId,
        updatedAt: new Date(),
      })
      .where(eq(automationRuns.id, row.runId));
  }

  const existing = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "assistant"),
        sql<boolean>`${chatMessages.structuredPayload}->>'eventType' = 'automation_run_result'`,
        sql<boolean>`${chatMessages.structuredPayload}->>'runId' = ${row.runId}::text`,
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

  const now = new Date();
  const [message] = await db
    .insert(chatMessages)
    .values({
      orgId: row.orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: chatMessageStatus(input.status),
      body: automationRunOutputBody(input),
      replyingAgentId: row.assigneeAgentId,
      structuredPayload: {
        eventType: "automation_run_result",
        automationId: row.automationId,
        automationTitle: row.automationTitle,
        runId: row.runId,
        issueId: row.issueId,
        status: input.status ?? null,
        links: {
          automation: `/automations/${row.automationId}`,
          issue: `/issues/${row.issueId}`,
        },
        [CHAT_TRANSCRIPT_KEY]: input.transcript ?? [],
      },
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!message) return null;

  await db
    .update(chatConversations)
    .set({ lastMessageAt: message.createdAt, updatedAt: message.createdAt })
    .where(eq(chatConversations.id, conversationId));
  await db
    .update(automationRuns)
    .set({
      linkedChatConversationId: conversationId,
      terminalChatMessageId: message.id,
      lastChatMessageId: message.id,
      updatedAt: new Date(),
    })
    .where(eq(automationRuns.id, row.runId));

  return message;
}
