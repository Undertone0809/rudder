import type { Db } from "@rudderhq/db";
import { chatGenerationEvents, chatGenerations } from "@rudderhq/db";
import type { ChatGenerationEventKind } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { conflict, notFound, unprocessable } from "../errors.js";

type GenerationRow = typeof chatGenerations.$inferSelect;

export type ChatGenerationProtocolTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AppendEventFields = {
  orgId: string;
  generationId: string;
  attemptEpoch: number;
  eventKind: ChatGenerationEventKind;
  payload?: Record<string, unknown>;
  bodyOffset?: number | null;
  bodyLength?: number | null;
  assistantMessageId?: string | null;
  runId?: string | null;
  controlActionId?: string | null;
  queueItemId?: string | null;
  emittedAt?: Date | null;
};

export const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");
export const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export function hashChatGenerationBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function normalizeBodyHash(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw unprocessable("Chat generation body hash must be a SHA-256 hex digest");
  }
  return value.toLowerCase();
}

export function assertGenerationFence(
  generation: GenerationRow,
  input: {
    conversationId?: string;
    expectedAttemptEpoch: number;
    expectedOwnerToken?: string | null;
  },
) {
  if (input.conversationId && generation.conversationId !== input.conversationId) {
    throw notFound("Chat generation not found");
  }
  if (generation.attemptEpoch !== input.expectedAttemptEpoch) {
    throw conflict("Chat generation runtime attempt changed");
  }
  if (input.expectedOwnerToken !== undefined && generation.controlOwnerToken !== input.expectedOwnerToken) {
    throw conflict("Chat generation control owner changed");
  }
}

export async function lockGeneration(
  tx: ChatGenerationProtocolTransaction,
  input: { orgId: string; generationId: string; conversationId?: string },
): Promise<GenerationRow> {
  await tx.execute(sql`
    select ${chatGenerations.id}
    from ${chatGenerations}
    where ${chatGenerations.id} = ${input.generationId}
      and ${chatGenerations.orgId} = ${input.orgId}
    for update
  `);
  const generation = await tx
    .select()
    .from(chatGenerations)
    .where(and(eq(chatGenerations.id, input.generationId), eq(chatGenerations.orgId, input.orgId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!generation || (input.conversationId && generation.conversationId !== input.conversationId)) {
    throw notFound("Chat generation not found");
  }
  return generation;
}

export async function nextGenerationSeq(
  tx: ChatGenerationProtocolTransaction,
  generationId: string,
): Promise<number> {
  return tx
    .select({ value: sql<number>`coalesce(max(${chatGenerationEvents.generationSeq}), 0) + 1` })
    .from(chatGenerationEvents)
    .where(eq(chatGenerationEvents.generationId, generationId))
    .then((rows) => Number(rows[0]?.value ?? 1));
}
