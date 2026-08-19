import type { TranscriptEntry } from "@/agent-runtimes";
import type { ChatMessage } from "@rudderhq/shared";
import { formatElapsedDuration } from "./utils";

function timestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatChatProcessDuration(ms: number): string {
  return formatElapsedDuration(ms);
}

export function lastTranscriptAtMs(entries: TranscriptEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max > 0 ? max : Date.now();
}

export function transcriptStartedAt(entries: TranscriptEntry[], fallback: Date): Date {
  for (const entry of entries) {
    const ts = Date.parse(entry.ts);
    if (Number.isFinite(ts)) return new Date(ts);
  }
  return fallback;
}

export function resolvePersistedChatProcessStartedAt(
  messages: ChatMessage[],
  message: ChatMessage,
  entries: TranscriptEntry[],
): Date {
  const messageMs = timestampMs(message.createdAt);
  const sameTurnUserMessages = message.chatTurnId
    ? messages.filter((candidate) => {
        if (candidate.role !== "user") return false;
        if (candidate.chatTurnId !== message.chatTurnId) return false;
        if ((candidate.turnVariant ?? 0) !== (message.turnVariant ?? 0)) return false;
        const candidateMs = timestampMs(candidate.createdAt);
        return candidateMs !== null && (messageMs === null || candidateMs <= messageMs);
      })
    : [];

  const turnStartMs = sameTurnUserMessages.reduce<number | null>((latest, candidate) => {
    const candidateMs = timestampMs(candidate.createdAt);
    if (candidateMs === null) return latest;
    return latest === null || candidateMs > latest ? candidateMs : latest;
  }, null);
  if (turnStartMs !== null) return new Date(turnStartMs);

  const previousUserMs = messages.reduce<number | null>((latest, candidate) => {
    if (candidate.role !== "user") return latest;
    const candidateMs = timestampMs(candidate.createdAt);
    if (candidateMs === null) return latest;
    if (messageMs !== null && candidateMs > messageMs) return latest;
    return latest === null || candidateMs > latest ? candidateMs : latest;
  }, null);
  if (previousUserMs !== null) return new Date(previousUserMs);

  return transcriptStartedAt(entries, new Date(message.createdAt));
}

export function resolvePersistedChatProcessEndedAt(message: ChatMessage, entries: TranscriptEntry[]): Date {
  const transcriptEndMs = entries.length > 0 ? lastTranscriptAtMs(entries) : 0;
  const messageMs = timestampMs(message.createdAt) ?? 0;
  const endedAt = Math.max(transcriptEndMs, messageMs);
  return new Date(endedAt > 0 ? endedAt : Date.now());
}
