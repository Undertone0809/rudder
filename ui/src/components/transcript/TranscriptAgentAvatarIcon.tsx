import {
  createAvatar as createOreoAvatar,
  palettes as oreoPalettes,
  shapes as oreoShapes,
} from "@oreo-design/avatar";
import { cn } from "../../lib/utils";

interface TranscriptAgentAvatarInfo {
  seed: string;
  label: string;
}

const transcriptAgentAvatarCache = new Map<string, string>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readFirstReceiver(record: Record<string, unknown>): string | null {
  const receivers = Array.isArray(record.receiver_thread_ids)
    ? record.receiver_thread_ids
    : Array.isArray(record.receiverThreadIds)
      ? record.receiverThreadIds
      : [];
  return receivers.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getTranscriptAgentAvatarInfo(toolName: string, input: unknown): TranscriptAgentAvatarInfo | null {
  const normalizedToolName = toolName.trim().toLowerCase().split(".").pop()?.replace(/-/g, "_");
  if (normalizedToolName !== "spawn_agent") return null;

  const record = asRecord(input);
  if (!record) return null;
  const receiver = readFirstReceiver(record);
  const seed = readString(record, ["id", "tool_use_id", "toolUseId"])
    ?? receiver
    ?? readString(record, ["message", "prompt", "task"]);
  if (!seed) return null;

  return {
    seed,
    label: receiver ? `Agent ${receiver}` : "Spawned agent",
  };
}

export function getTranscriptAgentAvatarImageSrc(seed: string): string {
  const cached = transcriptAgentAvatarCache.get(seed);
  if (cached) return cached;

  const shape = oreoShapes[hashSeed(`${seed}:shape`) % oreoShapes.length]!;
  const palette = oreoPalettes[hashSeed(`${seed}:palette`) % oreoPalettes.length]!;
  const imageSrc = createOreoAvatar({
    shape: shape.id,
    palette: palette.id,
    variantId: seed,
    size: 64,
  }).toDataUri();
  transcriptAgentAvatarCache.set(seed, imageSrc);
  return imageSrc;
}

export function TranscriptAgentAvatarIcon({
  info,
  status,
  className,
}: {
  info: TranscriptAgentAvatarInfo;
  status: "running" | "completed" | "error" | "neutral";
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex h-5 w-5 shrink-0", className)}
      data-transcript-agent-avatar={info.seed}
      aria-label={info.label}
      title={info.label}
    >
      <img
        src={getTranscriptAgentAvatarImageSrc(info.seed)}
        alt=""
        className={cn(
          "h-5 w-5 rounded-full object-cover ring-1",
          status === "error"
            ? "ring-red-500/45"
            : status === "running"
              ? "ring-cyan-500/45"
              : "ring-border/60",
        )}
      />
      {status === "running" || status === "error" ? (
        <span
          className={cn(
            "absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full ring-1 ring-background",
            status === "error" ? "bg-red-500" : "animate-pulse bg-cyan-500",
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
