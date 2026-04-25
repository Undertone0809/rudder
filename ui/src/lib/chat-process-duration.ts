import type { ChatMessage } from "@rudder/shared";
import type { TranscriptEntry } from "@/agent-runtimes";

function timestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatChatProcessDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return "under 1s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
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
