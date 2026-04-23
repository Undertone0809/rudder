import type { TranscriptEntry } from "../agent-runtimes";
import type { HeartbeatRunEvent } from "@rudder/shared";

interface RunDetailEventOptions {
  redactText?: (value: string) => string;
  redactValue?: <T>(value: T) => T;
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
  const ts = eventTimestamp(event);
  const text = heartbeatRunEventText(event, options);

  if (event.stream === "stdout") {
    return { kind: "stdout", ts, text };
  }

  if (event.stream === "stderr" || event.level === "error" || event.eventType === "error") {
    return { kind: "stderr", ts, text };
  }

  return { kind: "system", ts, text };
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
