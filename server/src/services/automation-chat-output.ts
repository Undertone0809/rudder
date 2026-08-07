import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  automationRuns,
  automations,
  chatConversations,
  chatMessages,
  issues,
} from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { replaceDetachedChatTranscript } from "./chat-transcript-persistence.js";
import { CHAT_TRANSCRIPT_KEY, chatTranscriptFromPayload, stripChatMetadataFromPayload } from "./chats.helpers.js";
import { chatService } from "./chats.js";

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
  const chats = chatService(db);

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
      const created = await chats.createWithInitialMessage(row.orgId, {
          title: row.automationTitle || "New chat",
          summary: null,
          preferredAgentId: row.assigneeAgentId,
          issueCreationMode: "manual_approval",
          planMode: false,
          createdByUserId: null,
          contextLinks: row.projectId ? [{
            entityType: "project",
            entityId: row.projectId,
            metadata: null,
          }] : [],
          initialMessage: {
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
              links: { automation: `/automations/${row.automationId}`, issue: `/issues/${row.issueId}` },
              [CHAT_TRANSCRIPT_KEY]: input.transcript ?? [],
            },
          },
          activity: {
            actorType: "system",
            actorId: "automation-chat-output",
            agentId: row.assigneeAgentId,
          },
        }, tx as unknown as Db);
      conversationId = created.conversation.id;
      await tx
        .update(automationRuns)
        .set({
          linkedChatConversationId: conversationId,
          terminalChatMessageId: created.message.id,
          lastChatMessageId: created.message.id,
          updatedAt: new Date(),
        })
        .where(eq(automationRuns.id, row.runId));
      return created.message;
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
    const structuredPayload = {
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
    };
    const transcript = chatTranscriptFromPayload(structuredPayload);
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
      structuredPayload: stripChatMetadataFromPayload(structuredPayload),
      createdAt: now,
      updatedAt: now,
      })
      .returning();
    if (!message) return null;
    if (transcript.length > 0) {
      await replaceDetachedChatTranscript(tx, {
        orgId: row.orgId,
        messageId: message.id,
        entries: transcript,
      });
    }

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
