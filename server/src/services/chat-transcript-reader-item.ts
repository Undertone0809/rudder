import type { ChatStreamTranscriptEntry } from "@rudderhq/shared";
import type { TranscriptItem } from "./runtime-kernel/transcript-reader.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptKind(value: unknown): ChatStreamTranscriptEntry["kind"] | null {
  if (typeof value !== "string") return null;
  const kind = value === "hermes:message:assistant"
    ? "assistant"
    : value === "hermes:message:user"
      ? "user"
      : value;
  switch (kind) {
    case "assistant":
    case "thinking":
    case "user":
    case "tool_call":
    case "tool_result":
    case "todo_list":
    case "init":
    case "result":
    case "stderr":
    case "system":
    case "stdout":
      return kind;
    default:
      return null;
  }
}

function isChatTranscriptEntry(value: unknown): value is ChatStreamTranscriptEntry {
  const record = asRecord(value);
  if (!record || typeof record.ts !== "string") return false;
  switch (record.kind) {
    case "assistant":
    case "thinking":
      return typeof record.text === "string"
        && (record.delta === undefined || typeof record.delta === "boolean")
        && (record.phase === undefined || record.phase === "commentary" || record.phase === "final_answer")
        && (record.segmentId === undefined || typeof record.segmentId === "string")
        && (record.generationId === undefined || typeof record.generationId === "string")
        && (record.generationSeqStart === undefined || typeof record.generationSeqStart === "number")
        && (record.generationSeqEnd === undefined || typeof record.generationSeqEnd === "number");
    case "user":
      return typeof record.text === "string"
        && (record.source === undefined || record.source === "steer")
        && (record.messageId === undefined || typeof record.messageId === "string")
        && (record.controlActionId === undefined || typeof record.controlActionId === "string");
    case "tool_call":
      return typeof record.name === "string" && "input" in record
        && (record.toolUseId === undefined || typeof record.toolUseId === "string");
    case "tool_result":
      return typeof record.toolUseId === "string"
        && typeof record.content === "string"
        && typeof record.isError === "boolean"
        && (record.toolName === undefined || typeof record.toolName === "string");
    case "todo_list":
      return (record.todoListId === undefined || typeof record.todoListId === "string")
        && Array.isArray(record.items)
        && record.items.every((item) => {
          const todo = asRecord(item);
          return Boolean(todo && typeof todo.text === "string"
            && (todo.status === "pending" || todo.status === "in_progress" || todo.status === "completed"));
        });
    case "init":
      return typeof record.model === "string" && typeof record.sessionId === "string";
    case "result":
      return typeof record.text === "string"
        && typeof record.inputTokens === "number"
        && typeof record.outputTokens === "number"
        && typeof record.cachedTokens === "number"
        && typeof record.costUsd === "number"
        && typeof record.subtype === "string"
        && typeof record.isError === "boolean"
        && Array.isArray(record.errors)
        && record.errors.every((error) => typeof error === "string");
    case "stderr":
    case "system":
    case "stdout":
      return typeof record.text === "string";
    default:
      return false;
  }
}

function withSourceEntryId(
  entry: ChatStreamTranscriptEntry,
  sourceEntryId: string | null,
): ChatStreamTranscriptEntry {
  return sourceEntryId ? Object.assign({}, entry, { sourceEntryId }) : entry;
}

function cursorAcpEntry(item: TranscriptItem): ChatStreamTranscriptEntry | null {
  const payload = asRecord(item.payload);
  const update = asRecord(payload?.update);
  const updateKind = item.kind.slice("cursor:acp:".length);
  if (
    payload?.provider !== "cursor_agent"
    || payload.transport !== "cursor-agent-acp-stdio"
    || payload.method !== "session/update"
    || update?.sessionUpdate !== updateKind
  ) return null;

  // ACP replay supplies content/window identities, not stable occurrence IDs.
  // Neither can safely anchor a persisted annotation after partial replay.
  const sourceEntryId = item.origin === "object" && typeof item.sourceEntryId === "string" && item.sourceEntryId.length > 0
    ? item.sourceEntryId : null;
  const content = asRecord(update.content);
  const text = typeof content?.text === "string"
    ? content.text
    : typeof item.text === "string" ? item.text : null;

  switch (updateKind) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
    case "agent_message":
    case "agent_thought":
    case "user_message": {
      if (text === null || (content?.type !== undefined && content.type !== "text")) return null;
      const kind = updateKind.startsWith("agent_thought") ? "thinking"
        : updateKind.startsWith("user_message") ? "user" : "assistant";
      const entry = { ts: item.ts, text, ...(updateKind.endsWith("_chunk") ? { delta: true } : {}) };
      return withSourceEntryId({ kind, ...entry }, sourceEntryId);
    }
    case "tool_call":
    case "tool_call_update": {
      if (typeof update.toolCallId !== "string" || !update.toolCallId.trim()) return null;
      const toolName = typeof update.title === "string" && update.title.trim() ? update.title : undefined;
      if (updateKind === "tool_call" && !toolName) return null;
      const terminal = update.status === "completed" || update.status === "failed"
        || update.status === "error" || update.status === "cancelled";
      if (updateKind === "tool_call" && toolName) {
        const output = update.rawOutput ?? update.content ?? update;
        return withSourceEntryId({
          kind: "tool_call", ts: item.ts, name: toolName,
          toolUseId: update.toolCallId, input: update.rawInput ?? update,
          ...(terminal ? {
            status: update.status,
            result: typeof output === "string" ? output : JSON.stringify(output),
            isError: update.status !== "completed",
          } : {}),
        }, sourceEntryId);
      }
      if (terminal) {
        const output = update.rawOutput ?? update.content ?? update;
        return withSourceEntryId({
          kind: "tool_result", ts: item.ts, toolUseId: update.toolCallId,
          ...(toolName ? { toolName } : {}),
          content: typeof output === "string" ? output : JSON.stringify(output),
          isError: update.status !== "completed",
        }, sourceEntryId);
      }
      return withSourceEntryId({
        kind: "system", ts: item.ts,
        text: `Tool ${toolName ?? update.toolCallId}: ${typeof update.status === "string" ? update.status : "updated"}`,
      }, sourceEntryId);
    }
    case "plan": {
      if (!Array.isArray(update.entries) || update.entries.length === 0) return null;
      const items: Array<{ text: string; status: "pending" | "in_progress" | "completed" } | null> = update.entries.map((value) => {
        const planEntry = asRecord(value);
        if (typeof planEntry?.content !== "string" || !planEntry.content.trim()) return null;
        const status = planEntry.status;
        if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
        return { text: planEntry.content, status };
      });
      if (items.some((value) => value === null)) return null;
      return { kind: "todo_list", ts: item.ts, items: items.filter((value): value is NonNullable<typeof value> => value !== null) };
    }
    default:
      return null;
  }
}

function textTranscriptEntry(
  kind: ChatStreamTranscriptEntry["kind"],
  ts: string,
  text: string,
  source: Record<string, unknown> | null,
): ChatStreamTranscriptEntry | null {
  switch (kind) {
    case "assistant":
    case "thinking":
      return {
        kind,
        ts,
        text,
        ...(typeof source?.delta === "boolean" ? { delta: source.delta } : {}),
        ...(source?.phase === "commentary" || source?.phase === "final_answer" ? { phase: source.phase } : {}),
        ...(typeof source?.segmentId === "string" ? { segmentId: source.segmentId } : {}),
        ...(typeof source?.generationId === "string" ? { generationId: source.generationId } : {}),
        ...(typeof source?.generationSeqStart === "number" ? { generationSeqStart: source.generationSeqStart } : {}),
        ...(typeof source?.generationSeqEnd === "number" ? { generationSeqEnd: source.generationSeqEnd } : {}),
      };
    case "user":
      return {
        kind,
        ts,
        text,
        ...(source?.source === "steer" ? { source: source.source } : {}),
        ...(typeof source?.messageId === "string" ? { messageId: source.messageId } : {}),
        ...(typeof source?.controlActionId === "string" ? { controlActionId: source.controlActionId } : {}),
      };
    case "system":
    case "stderr":
    case "stdout":
      return { kind, ts, text };
    default:
      return null;
  }
}

export function chatTranscriptEntryFromReaderItem(item: TranscriptItem): ChatStreamTranscriptEntry | null {
  if (typeof item.ts !== "string") return null;
  if (item.kind.startsWith("cursor:acp:")) return cursorAcpEntry(item);
  const payload = asRecord(item.payload);
  const itemEntry = asRecord(item.entry);
  const nestedEntry = asRecord(payload?.entry);
  const payloadFields = payload ? { ...payload } : null;
  if (payloadFields) delete payloadFields.entry;
  const candidate = payloadFields
    ? { ...payloadFields, ...(nestedEntry ?? {}), ...(itemEntry ?? {}) }
    : itemEntry ?? nestedEntry;
  const kind = transcriptKind(item.kind);
  if (!kind) return null;

  const sourceEntryId = typeof item.sourceEntryId === "string" && item.sourceEntryId.length > 0
    ? item.sourceEntryId
    : typeof candidate?.sourceEntryId === "string"
      ? candidate.sourceEntryId
      : typeof payload?.sourceEntryId === "string"
        ? payload.sourceEntryId
        : null;
  const text = typeof item.text === "string"
    ? item.text
    : typeof candidate?.text === "string"
      ? candidate.text
      : typeof payload?.text === "string"
        ? payload.text
        : null;

  if (candidate) {
    const candidateFields = { ...candidate };
    delete candidateFields.sourceEntryId;
    const normalized = {
      ...candidateFields,
      kind,
      ts: item.ts,
      ...(text !== null ? { text } : {}),
    };
    if (isChatTranscriptEntry(normalized)) {
      return withSourceEntryId(normalized, sourceEntryId);
    }
  }

  if (text === null) return null;
  const textEntry = textTranscriptEntry(kind, item.ts, text, candidate ?? payload);
  return textEntry ? withSourceEntryId(textEntry, sourceEntryId) : null;
}
