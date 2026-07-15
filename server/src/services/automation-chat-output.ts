import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  automationRuns,
  automations,
  chatContextLinks,
  chatConversations,
  chatMessages,
  issues,
} from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { CHAT_TRANSCRIPT_KEY } from "./chats.helpers.js";

function automationRunOutputBody(input: {
  output?: string | null;
  status?: string | null;
}) {
  const output = input.output?.trim();
  if (output) return output;
  if (input.status === "failed" || input.status === "timed_out" || input.status === "cancelled") {
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
  const issueId = input.issueId;

  return db.transaction(async (tx) => {
    const row = await tx
      .select({
      issueId: issues.id,
      automationId: automations.id,
      automationTitle: automations.title,
      automationOutputMode: automations.outputMode,
      projectId: automations.projectId,
      assigneeAgentId: automations.assigneeAgentId,
      runId: automationRuns.id,
      orgId: automationRuns.orgId,
      linkedChatConversationId: automationRuns.linkedChatConversationId,
      })
      .from(issues)
      .innerJoin(automationRuns, sql<boolean>`${issues.originRunId} = ${automationRuns.id}::text`)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(and(eq(issues.id, issueId), eq(issues.originKind, "automation_execution")))
      .then((rows) => rows[0] ?? null);

    if (!row || row.automationOutputMode !== "chat_output") return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`automation-chat-output:${row.runId}`}))`);

    let conversationId = row.linkedChatConversationId;
    if (!conversationId) {
      const currentRun = await tx
        .select({ linkedChatConversationId: automationRuns.linkedChatConversationId })
        .from(automationRuns)
        .where(eq(automationRuns.id, row.runId))
        .then((rows) => rows[0] ?? null);
      conversationId = currentRun?.linkedChatConversationId ?? null;
    }
    if (!conversationId) {
      const [conversation] = await tx
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
      if (row.projectId) {
        await tx
          .insert(chatContextLinks)
          .values({
            orgId: row.orgId,
            conversationId,
            entityType: "project",
            entityId: row.projectId,
            metadata: null,
          })
          .onConflictDoNothing();
      }
      await tx
        .update(automationRuns)
        .set({
          linkedChatConversationId: conversationId,
          updatedAt: new Date(),
        })
        .where(eq(automationRuns.id, row.runId));
    }
    const existing = await tx
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
    if (existing) {
      await tx
        .update(automationRuns)
        .set({
          terminalChatMessageId: existing.id,
          lastChatMessageId: existing.id,
          updatedAt: new Date(),
        })
        .where(eq(automationRuns.id, row.runId));
      return existing;
    }

    const now = new Date();
    const [message] = await tx
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

    await tx
      .update(chatConversations)
      .set({ lastMessageAt: message.createdAt, updatedAt: message.createdAt })
      .where(eq(chatConversations.id, conversationId));
    await tx
      .update(automationRuns)
      .set({
        linkedChatConversationId: conversationId,
        terminalChatMessageId: message.id,
        lastChatMessageId: message.id,
        updatedAt: new Date(),
      })
      .where(eq(automationRuns.id, row.runId));

    return message;
  });
}
