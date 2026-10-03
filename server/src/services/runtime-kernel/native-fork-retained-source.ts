import type { Db } from "@rudderhq/db";
import { chatMessages, runtimeBindings, runtimeSourceAliases } from "@rudderhq/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NativeForkIntentSource } from "./native-fork-intent.js";

/** The caller verifies Reader content; admission rechecks durable ownership under
 * the retention lock, without substituting a deleted conversation's provenance. */
export async function hasRetainedNativeForkSource(
  db: Db,
  source: NativeForkIntentSource,
  targetConversationId: string | null,
  span: { bindingId: string; segmentId: string },
): Promise<boolean> {
  if (!source.sourceConversationId || !targetConversationId) return false;
  const canonical = (item: unknown): string => Array.isArray(item)
    ? `[${item.map(canonical).join(",")}]`
    : item && typeof item === "object"
      ? `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
      : JSON.stringify(item) ?? "null";
  const selectorHash = createHash("sha256").update(canonical(source.selectorJson)).digest("hex");
  const aliases = await db.select().from(runtimeSourceAliases).where(and(
    eq(runtimeSourceAliases.orgId, source.orgId),
    eq(runtimeSourceAliases.conversationId, targetConversationId),
    eq(runtimeSourceAliases.sourceKind, "chat_fork_native_span"),
    isNull(runtimeSourceAliases.releasedAt),
    sql`${runtimeSourceAliases.sourceRangeJson}->>'forkBoundary' = 'true'`,
  )).limit(2);
  if (aliases.length !== 1) return false;
  const alias = aliases[0];
  const range = alias.sourceRangeJson;
  if (!alias.readOnly || alias.principalScopeRef !== `org:${source.orgId}`
    || (alias.expiresAt && alias.expiresAt.getTime() <= Date.now())
    || !alias.contentSha256 || !/^[a-f0-9]{64}$/.test(alias.contentSha256)
    || alias.runId !== source.sourceRunId || alias.bindingId !== span.bindingId || alias.segmentId !== span.segmentId
    || range.sourceConversationId !== source.sourceConversationId || range.sourceRunId !== source.sourceRunId
    || range.sourceSpanId !== source.sourceSpanId || range.selectorSha256 !== selectorHash
    || canonical(range.selectorJson) !== canonical(source.selectorJson)
    || typeof range.targetCopiedMessageId !== "string" || typeof range.sourceMessageId !== "string"
    || alias.sourceRef !== `native-span:${source.sourceSpanId}:message:${range.targetCopiedMessageId}`) return false;
  const [message] = await db.select({ id: chatMessages.id, runId: chatMessages.runId }).from(chatMessages).where(and(
    eq(chatMessages.orgId, source.orgId), eq(chatMessages.conversationId, targetConversationId),
    eq(chatMessages.id, range.targetCopiedMessageId),
  )).limit(1);
  if (!message || message.runId !== null) return false;
  const [binding] = await db.select().from(runtimeBindings).where(and(
    eq(runtimeBindings.orgId, source.orgId), eq(runtimeBindings.id, span.bindingId),
  )).limit(1);
  return Boolean(binding && binding.status === "closed" && binding.targetType === "manual"
    && binding.conversationId === null
    && binding.targetId === `retained-native-source:${source.sourceConversationId}:${span.bindingId}`);
}
