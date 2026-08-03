import { isInternalChatTranscriptLifecycleEntry, type HeartbeatRunEvent } from "@rudderhq/shared";
import type { TranscriptEntry } from "../agent-runtimes";

interface RunDetailEventOptions {
  redactText?: (value: string) => string;
  redactValue?: <T>(value: T) => T;
}

const OPERATOR_HIDDEN_RUN_EVENT_TYPES = new Set([
  "issue.execution_released",
]);

const INVOCATION_HIDDEN_RUN_EVENT_TYPES = new Set([
  ...OPERATOR_HIDDEN_RUN_EVENT_TYPES,
  "transcript.entry",
]);

function operatorHiddenRunEvent(event: HeartbeatRunEvent) {
  if (OPERATOR_HIDDEN_RUN_EVENT_TYPES.has(event.eventType)) return true;
  if (/(?:invocation|diagnostic|session)/iu.test(event.eventType)) return true;
  const payload = objectValue(event.payload);
  if (!payload) return false;
  if (payload.internal === true || payload.hidden === true || payload.private === true) return true;
  if (payload.visibility === "internal" || payload.visibility === "hidden") return true;
  const nestedEntry = objectValue(payload.entry);
  const candidate = payload.kind === "system" && typeof payload.text === "string"
    ? { kind: payload.kind, text: payload.text }
    : nestedEntry?.kind === "system" && typeof nestedEntry.text === "string"
      ? { kind: nestedEntry.kind, text: nestedEntry.text }
      : null;
  return candidate ? isInternalChatTranscriptLifecycleEntry(candidate) : false;
}

export function operatorVisibleInvocationRunEvents(
  events: HeartbeatRunEvent[],
): HeartbeatRunEvent[] {
  return events.filter((event) => !INVOCATION_HIDDEN_RUN_EVENT_TYPES.has(event.eventType));
}

function humanizeEventType(eventType: string): string {
  return eventType
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function eventTimestamp(event: HeartbeatRunEvent): string {
  if (event.createdAt instanceof Date) return event.createdAt.toISOString();
  const parsed = new Date(event.createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function todoItemStatusValue(value: unknown): "pending" | "in_progress" | "completed" | null {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : null;
}

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptEntryFromPayload(payloadValue: unknown, fallbackTs: string): TranscriptEntry | null {
  const payload = objectValue(payloadValue);
  if (!payload) return null;

  const kind = textValue(payload.kind);
  const ts = textValue(payload.ts) ?? fallbackTs;
  switch (kind) {
    case "assistant":
    case "thinking": {
      const text = textValue(payload.text);
      if (text === null) return null;
      const delta = booleanValue(payload.delta);
      return delta === null ? { kind, ts, text } : { kind, ts, text, delta };
    }
    case "user":
    case "stderr":
    case "system":
    case "stdout": {
      const text = textValue(payload.text);
      return text === null ? null : { kind, ts, text };
    }
    case "tool_call": {
      const name = textValue(payload.name);
      if (!name) return null;
      const toolUseId = textValue(payload.toolUseId);
      return toolUseId
        ? { kind, ts, name, input: payload.input, toolUseId }
        : { kind, ts, name, input: payload.input };
    }
    case "tool_result": {
      const toolUseId = textValue(payload.toolUseId);
      const content = textValue(payload.content);
      const isError = booleanValue(payload.isError);
      if (!toolUseId || content === null || isError === null) return null;
      const toolName = textValue(payload.toolName);
      return toolName
        ? { kind, ts, toolUseId, toolName, content, isError }
        : { kind, ts, toolUseId, content, isError };
    }
    case "todo_list": {
      const items = Array.isArray(payload.items)
        ? payload.items.flatMap((item) => {
          const record = objectValue(item);
          const text = textValue(record?.text);
          const status = todoItemStatusValue(record?.status);
          return text && status
            ? [{ text, status }]
            : [];
        })
        : null;
      if (!items) return null;
      const todoListId = textValue(payload.todoListId);
      return todoListId ? { kind, ts, todoListId, items } : { kind, ts, items };
    }
    case "init": {
      const model = textValue(payload.model);
      const sessionId = textValue(payload.sessionId);
      return model && sessionId ? { kind, ts, model, sessionId } : null;
    }
    case "result": {
      const text = textValue(payload.text);
      const inputTokens = numberValue(payload.inputTokens);
      const outputTokens = numberValue(payload.outputTokens);
      const cachedTokens = numberValue(payload.cachedTokens);
      const costUsd = numberValue(payload.costUsd);
      const subtype = textValue(payload.subtype);
      const isError = booleanValue(payload.isError);
      const errors = Array.isArray(payload.errors)
        ? payload.errors.filter((error): error is string => typeof error === "string")
        : null;
      return text !== null
        && inputTokens !== null
        && outputTokens !== null
        && cachedTokens !== null
        && costUsd !== null
        && subtype !== null
        && isError !== null
        && errors !== null
        ? { kind, ts, text, inputTokens, outputTokens, cachedTokens, costUsd, subtype, isError, errors }
        : null;
    }
    default:
      return null;
  }
}

export function heartbeatRunEventTranscriptEntry(
  event: HeartbeatRunEvent,
  options: RunDetailEventOptions = {},
): TranscriptEntry | null {
  if (event.eventType !== "transcript.entry") return null;
  const redactValue = options.redactValue ?? (<T,>(value: T) => value);
  const entry = transcriptEntryFromPayload(redactValue(event.payload), eventTimestamp(event));
  return entry ? { ...entry, sourceEntryId: String(event.id) } : null;
}

export function heartbeatRunEventText(
  event: HeartbeatRunEvent,
  options: RunDetailEventOptions = {},
): string {
  const redactText = options.redactText ?? ((value: string) => value);
  const redactValue = options.redactValue ?? (<T,>(value: T) => value);
  const message = typeof event.message === "string" && event.message.trim().length > 0
    ? redactText(event.message)
    : null;

  if (message) return message;

  if (event.payload) {
    const payload = redactValue(event.payload);
    try {
      return `${humanizeEventType(event.eventType)}: ${JSON.stringify(payload)}`;
    } catch {
      return humanizeEventType(event.eventType);
    }
  }

  return humanizeEventType(event.eventType);
}

export function heartbeatRunEventToTranscriptEntry(
  event: HeartbeatRunEvent,
  options: RunDetailEventOptions = {},
): TranscriptEntry {
  const embeddedTranscriptEntry = heartbeatRunEventTranscriptEntry(event, options);
  if (embeddedTranscriptEntry) return embeddedTranscriptEntry;

  const ts = eventTimestamp(event);
  const text = heartbeatRunEventText(event, options);

  if (event.stream === "stdout") {
    return { kind: "stdout", ts, text, sourceEntryId: String(event.id) };
  }

  if (event.stream === "stderr" || event.level === "error" || event.eventType === "error") {
    return { kind: "stderr", ts, text, sourceEntryId: String(event.id) };
  }

  return { kind: "system", ts, text, sourceEntryId: String(event.id) };
}

export function heartbeatRunEventsToTranscriptEntries(
  events: HeartbeatRunEvent[],
  options: RunDetailEventOptions = {},
): TranscriptEntry[] {
  const visibleEvents = events.filter((event) => !operatorHiddenRunEvent(event));
  const embeddedTranscriptEntries = visibleEvents.flatMap((event) => {
    const entry = heartbeatRunEventTranscriptEntry(event, options);
    return entry ? [entry] : [];
  });
  if (embeddedTranscriptEntries.length > 0) return embeddedTranscriptEntries;
  return visibleEvents.map((event) => heartbeatRunEventToTranscriptEntry(event, options));
}

export function mergeTranscriptEntries(
  transcriptEntries: TranscriptEntry[],
  eventEntries: TranscriptEntry[],
): TranscriptEntry[] {
  return [...transcriptEntries, ...eventEntries]
    .map((entry, index) => ({
      entry,
      index,
      time: Number.isFinite(Date.parse(entry.ts)) ? Date.parse(entry.ts) : Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => {
      if (left.time !== right.time) return left.time - right.time;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}
