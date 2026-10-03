import type { Db } from "@rudderhq/db";
import { heartbeatRuns, nativeSegments, runRuntimeSpans, runtimeBindings, runtimeSourceAliases } from "@rudderhq/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import { createHistoricalTranscriptReader } from "./runtime-kernel/historical-transcript-reader.js";
import type { TranscriptItem } from "./runtime-kernel/transcript-reader.js";

export const NATIVE_CHAT_FORK_ALIAS_KIND = "chat_fork_native_span";
export function nativeForkReaderContent(item: TranscriptItem) {
  return { kind: item.kind, ts: item.ts, text: item.text, payload: item.payload,
    entry: item.entry, sourceEntryId: item.sourceEntryId };
}

export async function assertNativeChatForkSourceContent(db: Db, orgId: string, source: NativeChatForkSource) {
  const reader = createHistoricalTranscriptReader(db);
  const items: unknown[] = [];
  let bytes = 2;
  let cursor: string | null = null;
  for (let pages = 0; pages < 25; pages += 1) {
    const page = await reader.readRun({ orgId, runId: source.runId,
      principal: { type: "board", orgId, authorized: true }, limit: 250, cursor });
    if (page.availability !== "available" || !["native", "native_plus_objects"].includes(page.source)) {
      throw unprocessable("Native Fork source transcript is unavailable");
    }
    for (const item of page.items) {
      const content = nativeForkReaderContent(item);
      bytes += Buffer.byteLength(JSON.stringify(content), "utf8") + 1;
      if (items.length >= 5000 || bytes > 2 * 1024 * 1024) throw unprocessable("Native Fork source exceeds its bounded verification budget");
      items.push(content);
    }
    if (!page.nextCursor) {
      if (nativeForkContentHash(items) !== source.contentSha256) throw unprocessable("Native Fork source content changed");
      return;
    }
    if (page.nextCursor === cursor) throw unprocessable("Native Fork source cursor made no progress");
    cursor = page.nextCursor;
  }
  throw unprocessable("Native Fork source exceeds its bounded verification budget");
}
export function nativeForkContentHash(value: unknown): string {
  const canonical = (item: unknown): string => Array.isArray(item)
    ? `[${item.map(canonical).join(",")}]`
    : item && typeof item === "object"
      ? `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
      : JSON.stringify(item) ?? "null";
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function nativeForkSelectorIsExact(value: unknown): boolean {
  const s = value as Record<string, unknown> | null;
  const text = (key: string) => typeof s?.[key] === "string" && Boolean((s[key] as string).trim());
  if (!s || [s.boundaryStatus, s.completeness].some((v) => ["unknown", "partial", "missing", "terminal_only"].includes(String(v)))) return false;
  switch (s.kind) {
    case "codex_turn": return text("threadId") && text("turnId");
    case "claude_chain": return text("sessionId") && text("throughInclusiveUuid");
    case "hermes_execution": return text("sessionRef") && text("providerExecutionRef") && s.boundaryStatus === "exact";
    case "opencode_input": return text("sessionId") && text("userMessageId") && s.boundaryStatus === "exact"
      && Array.isArray(s.terminalMessageIds) && s.terminalMessageIds.length > 0 && s.terminalMessageIds.every((id) => typeof id === "string" && id.trim());
    case "pi_branch_range": return text("sessionResourceRef") && text("throughInclusive");
    case "cursor_execution": return text("sessionId") && (text("executionRef") || text("nativeRangeRef"));
    default: return false;
  }
}

type AliasRow = typeof runtimeSourceAliases.$inferSelect;
export type NativeChatForkSource = {
  runId: string;
  spanId: string;
  bindingId: string;
  segmentId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  selectorJson: Record<string, unknown>;
  selectorSha256: string;
  contentSha256: string | null;
};
type MessageIdentity = { id: string; orgId: string; conversationId: string; runId?: string | null };

export async function findNativeChatForkAlias(db: Pick<Db, "select">, message: Omit<MessageIdentity, "runId">): Promise<AliasRow | null> {
  const rows = await db.select().from(runtimeSourceAliases).where(and(
    eq(runtimeSourceAliases.orgId, message.orgId), eq(runtimeSourceAliases.conversationId, message.conversationId),
    eq(runtimeSourceAliases.sourceKind, NATIVE_CHAT_FORK_ALIAS_KIND),
    isNull(runtimeSourceAliases.releasedAt),
    sql`${runtimeSourceAliases.sourceRangeJson}->>'targetCopiedMessageId' = ${message.id}`,
  )).limit(2);
  if (rows.length > 1) throw unprocessable("Native Fork message has ambiguous source aliases");
  if (rows[0] && (rows[0].principalScopeRef !== `org:${message.orgId}` || !rows[0].readOnly)) {
    throw unprocessable("Native Fork source alias principal is invalid");
  }
  if (rows[0]?.expiresAt && rows[0].expiresAt.getTime() <= Date.now()) throw unprocessable("Native Fork source alias has expired");
  return rows[0] ?? null;
}

export async function loadNativeChatForkSource(db: Pick<Db, "select">, message: MessageIdentity): Promise<NativeChatForkSource | null> {
  const alias = message.runId ? null : await findNativeChatForkAlias(db, message);
  const runId = message.runId ?? alias?.runId;
  if (!runId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.orgId, message.orgId), eq(heartbeatRuns.id, runId))).limit(1);
  if (!alias && run?.contextSnapshot?.transcriptSource === "legacy") return null;
  const context = run?.contextSnapshot as Record<string, unknown> | null;
  const profile = context?.runtimeProviderProfile as Record<string, unknown> | null;
  const runtimeType = profile?.runtimeType ?? context?.agentRuntimeType;
  const nativeRuntime = ["codex_local", "claude_local", "hermes_gateway", "opencode_local", "pi_local", "cursor"].includes(String(runtimeType));
  if (!alias && runtimeType && !nativeRuntime) return null;
  const spans = await db.select().from(runRuntimeSpans).where(and(eq(runRuntimeSpans.orgId, message.orgId), eq(runRuntimeSpans.runId, runId))).limit(2);
  if (!spans.length && !alias && !nativeRuntime) return null;
  const span = spans.length === 1 ? spans[0] : null;
  if (!span || span.state !== "sealed" || span.completeness !== "complete" || !nativeForkSelectorIsExact(span.selectorJson)) {
    throw unprocessable("Native Fork requires a unique sealed complete exact execution span");
  }
  const [binding] = await db.select().from(runtimeBindings).where(and(eq(runtimeBindings.orgId, message.orgId), eq(runtimeBindings.id, span.bindingId))).limit(1);
  const [segment] = await db.select().from(nativeSegments).where(and(eq(nativeSegments.orgId, message.orgId), eq(nativeSegments.id, span.segmentId), eq(nativeSegments.bindingId, span.bindingId))).limit(1);
  const range = alias?.sourceRangeJson;
  const sourceConversationId = alias ? range?.sourceConversationId : message.conversationId;
  const sourceMessageId = alias ? range?.sourceMessageId : message.id;
  const selectorSha256 = nativeForkContentHash(span.selectorJson);
  const selector = span.selectorJson as Record<string, unknown>;
  const session = selector.threadId ?? selector.sessionId ?? selector.sessionRef ?? selector.sessionResourceRef;
  const retained = binding?.status === "closed" && binding.targetType === "manual" && binding.conversationId === null
    && binding.targetId === `retained-native-source:${sourceConversationId}:${binding.id}`;
  if (!run || run.status !== "succeeded" || !binding || !segment || binding.agentId !== run.agentId
    || binding.runtimeType !== segment.runtimeType || profile?.runtimeType !== binding.runtimeType
    || session !== segment.nativeSessionId
    || (run.sessionIdAfter && run.sessionIdAfter !== segment.nativeSessionId)
    || typeof sourceConversationId !== "string" || typeof sourceMessageId !== "string"
    || (!retained && (binding.conversationId !== sourceConversationId || run.chatConversationId !== sourceConversationId))
    || (alias && (alias.bindingId !== span.bindingId || alias.segmentId !== span.segmentId || range?.sourceSpanId !== span.id
      || range?.sourceRunId !== run.id || range?.selectorSha256 !== selectorSha256
      || nativeForkContentHash(range?.selectorJson) !== selectorSha256 || !alias.contentSha256))) {
    throw unprocessable("Native Fork alias or source identity no longer matches its exact range");
  }
  return { runId, spanId: span.id, bindingId: span.bindingId, segmentId: span.segmentId,
    sourceConversationId, sourceMessageId, selectorJson: span.selectorJson as Record<string, unknown>, selectorSha256,
    contentSha256: alias?.contentSha256 ?? null };
}
