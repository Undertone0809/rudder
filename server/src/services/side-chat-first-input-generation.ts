import type { Db } from "@rudderhq/db";
import { chatGenerations, heartbeatRuns, sideChatFirstInputs } from "@rudderhq/db";
import { and, eq, or, sql } from "drizzle-orm";
import { conflict } from "../errors.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function ensureSideChatFirstInputGeneration(
  tx: DbTransaction,
  input: { orgId: string; conversationId: string; userMessageId: string },
) {
  const intent = await tx.select().from(sideChatFirstInputs).where(and(
    eq(sideChatFirstInputs.orgId, input.orgId),
    eq(sideChatFirstInputs.conversationId, input.conversationId),
  )).for("update").then((rows) => rows[0] ?? null);
  if (
    !intent
    || intent.status !== "accepted"
    || intent.userMessageId !== input.userMessageId
  ) {
    throw conflict("Side Chat first input is not accepted for this Generation", {
      code: "side_chat_first_input_generation_mismatch",
    });
  }

  let generation = intent.generationId
    ? await tx.select().from(chatGenerations).where(and(
      eq(chatGenerations.id, intent.generationId),
      eq(chatGenerations.orgId, input.orgId),
      eq(chatGenerations.conversationId, input.conversationId),
    )).limit(1).then((rows) => rows[0] ?? null)
    : null;
  if (intent.generationId && !generation) {
    throw new Error("Side Chat first input references a missing Generation");
  }

  if (!generation) {
    const now = new Date();
    const [created] = await tx.insert(chatGenerations).values({
      orgId: input.orgId,
      conversationId: input.conversationId,
      status: "active",
      controlOwnerToken: null,
      controlLeaseExpiresAt: null,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!created) throw new Error("Failed to admit Side Chat first-input Generation");
    generation = created;
    await tx.update(sideChatFirstInputs).set({
      generationId: generation.id,
      updatedAt: new Date(),
    }).where(and(
      eq(sideChatFirstInputs.orgId, input.orgId),
      eq(sideChatFirstInputs.conversationId, input.conversationId),
      eq(sideChatFirstInputs.status, "accepted"),
      eq(sideChatFirstInputs.userMessageId, input.userMessageId),
    ));
  }

  const admittedRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    eq(heartbeatRuns.invocationSource, "chat"),
    or(
      sql`${heartbeatRuns.contextSnapshot}->>'chatGenerationId' = ${generation.id}`,
      sql`${heartbeatRuns.contextSnapshot}->>'userMessageId' = ${input.userMessageId}`,
    ),
  )).limit(1).then((rows) => rows[0] ?? null);

  return { generation, executionAdmitted: Boolean(admittedRun) };
}
