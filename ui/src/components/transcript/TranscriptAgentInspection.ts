import type { TranscriptEntry } from "../../agent-runtimes";
import {
  asRecord,
  type TranscriptAgentInspection,
  type TranscriptBlock,
  type TranscriptToolCardEntry,
} from "./RunTranscriptView.common";

type AgentSnapshot = {
  status: string | null;
  message: string | null;
  entries: TranscriptEntry[];
};

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readReceiverThreadIds(record: Record<string, unknown>): string[] {
  const values = Array.isArray(record.receiver_thread_ids)
    ? record.receiver_thread_ids
    : Array.isArray(record.receiverThreadIds)
      ? record.receiverThreadIds
      : [];
  const receiverThreadIds = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (receiverThreadIds.length > 0) return receiverThreadIds;
  const activityThreadId = readString(record, ["agent_thread_id", "agentThreadId"]);
  return activityThreadId ? [activityThreadId] : [];
}

function readTranscriptEntries(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is TranscriptEntry => {
    const record = asRecord(entry);
    return typeof record?.kind === "string" && typeof record.ts === "string";
  });
}

function readAgentSnapshots(record: Record<string, unknown>): Map<string, AgentSnapshot> {
  const snapshots = new Map<string, AgentSnapshot>();
  const transcriptRecords = asRecord(record.agent_transcripts) ?? asRecord(record.agentTranscripts);
  const stateRecords = asRecord(record.agents_states) ?? asRecord(record.agentsStates);
  const threadIds = new Set([
    ...Object.keys(transcriptRecords ?? {}),
    ...Object.keys(stateRecords ?? {}),
    ...readReceiverThreadIds(record),
  ]);

  for (const threadId of threadIds) {
    const transcript = asRecord(transcriptRecords?.[threadId]);
    const state = asRecord(stateRecords?.[threadId]);
    const entries = readTranscriptEntries(transcript?.entries);
    const response = readString(state ?? {}, ["message", "response"])
      ?? [...entries].reverse().find((entry) => entry.kind === "assistant")?.text
      ?? null;
    snapshots.set(threadId, {
      status: readString(transcript ?? {}, ["status"]) ?? readString(state ?? {}, ["status"]),
      message: response,
      entries,
    });
  }
  return snapshots;
}

function normalizedToolName(name: string) {
  return name.trim().toLowerCase().split(".").pop()?.replace(/-/g, "_") ?? "";
}

function toolEntries(block: TranscriptBlock): TranscriptToolCardEntry[] {
  if (block.type === "tool") return [block];
  if (block.type === "command_group") return block.items;
  return [];
}

export function collectTranscriptAgentInspections(
  blocks: TranscriptBlock[],
): Map<string, TranscriptAgentInspection> {
  const snapshotsByThreadId = new Map<string, AgentSnapshot>();
  const tools = blocks.flatMap(toolEntries);

  for (const tool of tools) {
    const record = asRecord(tool.input);
    if (!record) continue;
    for (const [threadId, snapshot] of readAgentSnapshots(record)) {
      const current = snapshotsByThreadId.get(threadId);
      if (!current || snapshot.entries.length >= current.entries.length) {
        snapshotsByThreadId.set(threadId, {
          status: snapshot.status ?? current?.status ?? null,
          message: snapshot.message ?? current?.message ?? null,
          entries: snapshot.entries.length > 0 ? snapshot.entries : current?.entries ?? [],
        });
      }
    }
  }

  const inspections = new Map<string, TranscriptAgentInspection>();
  for (const tool of tools) {
    const toolName = normalizedToolName(tool.name);
    if (toolName !== "spawn_agent" && toolName !== "subagent_activity") continue;
    const record = asRecord(tool.input);
    if (!record) continue;
    const directSnapshots = readAgentSnapshots(record);
    const threadId = readReceiverThreadIds(record)[0]
      ?? directSnapshots.keys().next().value
      ?? null;
    if (!threadId) continue;

    const snapshot = snapshotsByThreadId.get(threadId) ?? directSnapshots.get(threadId);
    const callId = tool.toolUseId
      ?? readString(record, ["id", "tool_use_id", "toolUseId"])
      ?? threadId;
    const agentPath = readString(record, ["agent_path", "agentPath"]);
    const prompt = readString(record, ["message", "prompt", "task", "instructions"])
      ?? (agentPath ? `Delegated task to ${agentPath}` : "Delegated task");
    const inspection: TranscriptAgentInspection = {
      callId,
      threadId,
      avatarSeed: readString(record, ["id", "tool_use_id", "toolUseId"]) ?? threadId,
      prompt,
      model: readString(record, ["model"]),
      reasoningEffort: readString(record, ["reasoning_effort", "reasoningEffort"]),
      status: snapshot?.status ?? (tool.status === "running" ? "running" : tool.status),
      response: snapshot?.message ?? null,
      entries: snapshot?.entries ?? [],
    };
    inspections.set(callId, inspection);
    inspections.set(threadId, inspection);
  }
  return inspections;
}

export function transcriptAgentInspectionForTool(
  tool: TranscriptToolCardEntry,
  inspections: Map<string, TranscriptAgentInspection>,
): TranscriptAgentInspection | null {
  const toolName = normalizedToolName(tool.name);
  if (toolName !== "spawn_agent" && toolName !== "subagent_activity") return null;
  const record = asRecord(tool.input);
  const callId = tool.toolUseId
    ?? (record ? readString(record, ["id", "tool_use_id", "toolUseId"]) : null);
  const threadId = record ? readReceiverThreadIds(record)[0] : null;
  return (callId ? inspections.get(callId) : null)
    ?? (threadId ? inspections.get(threadId) : null)
    ?? null;
}
