import type {
  ChatStreamTranscriptEntry,
  ChatWorkManifestSubagentState,
  ChatWorkManifestSubagentStatus,
  ChatWorkManifestSubagentSummary,
} from "./types/chat.js";

export interface ChatSubagentInspection extends ChatWorkManifestSubagentSummary {
  response: string | null;
  entries: ChatStreamTranscriptEntry[];
}

export interface CollectChatSubagentContext {
  sourceMessageId: string;
  runId: string | null;
  sourceActive: boolean;
  sourceTerminalStatus?: Extract<ChatWorkManifestSubagentStatus, "completed" | "stopped"> | null;
  senderLabel?: string | null;
}

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function readString(record: RecordValue | null | undefined, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readStrings(record: RecordValue, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  const one = readString(record, ["agent_thread_id", "agentThreadId"]);
  return one ? [one] : [];
}

function readTranscriptEntries(value: unknown): ChatStreamTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ChatStreamTranscriptEntry => {
    const record = asRecord(entry);
    return typeof record?.kind === "string" && typeof record.ts === "string";
  });
}

function normalizedToolName(value: string | null | undefined) {
  return value?.trim().toLowerCase().split(".").pop()?.replace(/-/gu, "_") ?? "";
}

function normalizeStatus(
  rawStatus: string | null,
  sourceActive: boolean,
  sourceTerminalStatus: CollectChatSubagentContext["sourceTerminalStatus"],
  isError: boolean,
): { state: ChatWorkManifestSubagentState; status: ChatWorkManifestSubagentStatus } {
  const value = rawStatus
    ?.trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s-]+/gu, "_")
    .toLowerCase() ?? "";
  if (isError || value === "failed" || value === "error") {
    return { state: "done", status: "failed" };
  }
  if (value === "interrupted") return { state: "done", status: "interrupted" };
  if (value === "cancelled" || value === "canceled") return { state: "done", status: "cancelled" };
  if (value === "stopped" || value === "closed") return { state: "done", status: "stopped" };
  if (value === "completed" || value === "complete" || value === "done" || value === "success") {
    return { state: "done", status: "completed" };
  }
  if (value === "pending" || value === "queued") return { state: "active", status: "pending" };
  if (
    value === "running"
    || value === "in_progress"
    || value === "inprogress"
    || value === "started"
    || value === "active"
  ) {
    if (sourceTerminalStatus) {
      return { state: "done", status: sourceTerminalStatus };
    }
    return { state: "active", status: "running" };
  }
  return sourceActive
    ? { state: "active", status: "unknown" }
    : { state: "done", status: "unknown" };
}

function latestTimestamp(entries: ChatStreamTranscriptEntry[], fallback: string) {
  let latest = Number.isFinite(Date.parse(fallback)) ? fallback : new Date(0).toISOString();
  for (const entry of entries) {
    if (!Number.isFinite(Date.parse(entry.ts))) continue;
    if (Date.parse(entry.ts) > Date.parse(latest)) latest = entry.ts;
  }
  return latest;
}

function responseFromEntries(entries: ChatStreamTranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant" && entry.text.trim()) return entry.text.trim();
  }
  return null;
}

function mergeTranscriptEntries(
  left: ChatStreamTranscriptEntry[],
  right: ChatStreamTranscriptEntry[],
) {
  const mergeKey = (entry: ChatStreamTranscriptEntry) => (
    entry.kind === "assistant" || entry.kind === "thinking"
      ? JSON.stringify({
        kind: entry.kind,
        ts: entry.ts,
        text: entry.text,
        delta: entry.delta ?? null,
        phase: entry.phase ?? null,
        segmentId: entry.segmentId ?? null,
      })
      : JSON.stringify(entry)
  );
  const provenanceScore = (entry: ChatStreamTranscriptEntry) => (
    entry.kind === "assistant" || entry.kind === "thinking"
      ? Number(entry.generationId !== undefined)
        + Number(entry.generationSeqStart !== undefined)
        + Number(entry.generationSeqEnd !== undefined)
      : 0
  );
  const available = new Map<string, number[]>();
  const merged = [...left];
  left.forEach((entry, index) => {
    const key = mergeKey(entry);
    available.set(key, [...(available.get(key) ?? []), index]);
  });
  for (const entry of right) {
    const key = mergeKey(entry);
    const matching = available.get(key);
    const index = matching?.shift();
    if (index === undefined) {
      merged.push(entry);
      continue;
    }
    if (provenanceScore(entry) > provenanceScore(merged[index]!)) merged[index] = entry;
  }
  return merged.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function humanizeAgentPath(agentPath: string | null) {
  const tail = agentPath?.split("/").filter(Boolean).at(-1)?.trim() ?? "";
  if (!tail) return null;
  return tail
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\b\p{L}/gu, (character) => character.toUpperCase());
}

function fallbackThreadLabel(threadId: string) {
  const identity = threadId.startsWith("thread-") ? threadId.slice("thread-".length) : threadId;
  const suffix = identity.length > 8 ? identity.slice(-8) : identity;
  return `Sub-agent ${suffix}`;
}

function promptLabel(prompt: string) {
  const compact = prompt.replace(/\s+/gu, " ").trim();
  if (!compact || compact === "Delegated task") return null;
  return compact.length > 52 ? `${compact.slice(0, 51).trimEnd()}…` : compact;
}

function mergeResultRecord(input: RecordValue, content: string): RecordValue {
  try {
    const result = asRecord(JSON.parse(content));
    return result ? { ...input, ...result } : input;
  } catch {
    return input;
  }
}

function inspectionForThread(
  record: RecordValue,
  context: CollectChatSubagentContext,
  callId: string,
  threadId: string,
  eventTs: string,
  isError: boolean,
  toolName: string,
): ChatSubagentInspection {
  const transcriptRecords = asRecord(record.agent_transcripts) ?? asRecord(record.agentTranscripts);
  const stateRecords = asRecord(record.agents_states) ?? asRecord(record.agentsStates);
  const transcript = asRecord(transcriptRecords?.[threadId]);
  const state = asRecord(stateRecords?.[threadId]);
  const entries = readTranscriptEntries(transcript?.entries);
  const agentPath = readString(record, ["agent_path", "agentPath"]);
  const prompt = readString(record, ["message", "prompt", "task", "instructions"])
    ?? (agentPath ? `Delegated task to ${agentPath}` : "Delegated task");
  const response = readString(state, ["message", "response"])
    ?? responseFromEntries(entries);
  const rawStatus = readString(transcript, ["status"])
    ?? readString(state, ["status"])
    ?? (normalizedToolName(toolName) === "subagent_activity"
      ? readString(record, ["activity_kind", "activityKind", "status"])
      : null);
  const normalized = normalizeStatus(
    rawStatus,
    context.sourceActive,
    context.sourceTerminalStatus,
    isError,
  );
  const label = humanizeAgentPath(agentPath)
    ?? promptLabel(prompt)
    ?? fallbackThreadLabel(threadId);
  return {
    callId,
    threadId,
    sourceMessageId: context.sourceMessageId,
    runId: context.runId,
    senderLabel: context.senderLabel ?? null,
    label,
    prompt,
    avatarSeed: readString(record, ["id", "tool_use_id", "toolUseId"]) ?? callId ?? threadId,
    model: readString(record, ["model"]),
    reasoningEffort: readString(record, ["reasoning_effort", "reasoningEffort"]),
    ...normalized,
    startedAt: eventTs,
    updatedAt: latestTimestamp(entries, eventTs),
    response,
    entries,
  };
}

export function collectChatSubagentInspections(
  entries: ChatStreamTranscriptEntry[],
  context: CollectChatSubagentContext,
): ChatSubagentInspection[] {
  const pendingCalls = new Map<string, {
    name: string;
    input: RecordValue;
    ts: string;
  }>();
  const observations: ChatSubagentInspection[] = [];

  const append = (
    name: string,
    record: RecordValue,
    callId: string,
    ts: string,
    isError: boolean,
  ) => {
    const toolName = normalizedToolName(name);
    const identityTool = toolName === "spawn_agent" || toolName === "subagent_activity";
    const snapshotTool = new Set([
      "wait_agent",
      "send_input",
      "resume_agent",
      "close_agent",
      "followup_task",
      "send_message",
    ]).has(toolName);
    if (!identityTool && !snapshotTool) return;
    const transcriptRecords = asRecord(record.agent_transcripts) ?? asRecord(record.agentTranscripts);
    const stateRecords = asRecord(record.agents_states) ?? asRecord(record.agentsStates);
    if (!identityTool && !transcriptRecords && !stateRecords) return;
    const threadIds = new Set([
      ...readStrings(record, ["receiver_thread_ids", "receiverThreadIds"]),
      ...Object.keys(transcriptRecords ?? {}),
      ...Object.keys(stateRecords ?? {}),
    ]);
    for (const threadId of threadIds) {
      observations.push(inspectionForThread(record, context, callId, threadId, ts, isError, toolName));
    }
  };

  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      const input = asRecord(entry.input);
      const callId = entry.toolUseId ?? readString(input, ["id", "tool_use_id", "toolUseId"]);
      if (!input || !callId) continue;
      pendingCalls.set(callId, { name: entry.name, input, ts: entry.ts });
      append(entry.name, input, callId, entry.ts, false);
      continue;
    }
    if (entry.kind !== "tool_result") continue;
    const pending = pendingCalls.get(entry.toolUseId);
    const name = pending?.name ?? entry.toolName ?? "";
    const input = mergeResultRecord(pending?.input ?? {}, entry.content);
    append(name, input, entry.toolUseId, pending?.ts ?? entry.ts, entry.isError);
  }

  return mergeChatSubagentInspections(observations);
}

function mergeChatSubagentInspections(
  inspections: ChatSubagentInspection[],
): ChatSubagentInspection[] {
  const merged = new Map<string, ChatSubagentInspection>();
  for (const inspection of inspections) {
    const current = merged.get(inspection.threadId);
    if (!current) {
      merged.set(inspection.threadId, inspection);
      continue;
    }
    const incomingIsNewer = Date.parse(inspection.updatedAt) >= Date.parse(current.updatedAt);
    const identitySource = Date.parse(inspection.startedAt) < Date.parse(current.startedAt)
      ? inspection
      : current;
    const stateSource = incomingIsNewer ? inspection : current;
    const transcriptEntries = mergeTranscriptEntries(current.entries, inspection.entries);
    merged.set(inspection.threadId, {
      ...stateSource,
      callId: identitySource.callId,
      prompt: identitySource.prompt,
      label: identitySource.label,
      avatarSeed: identitySource.avatarSeed,
      model: identitySource.model ?? stateSource.model,
      reasoningEffort: identitySource.reasoningEffort ?? stateSource.reasoningEffort,
      startedAt: identitySource.startedAt,
      response:
        stateSource.response
        ?? responseFromEntries(transcriptEntries)
        ?? current.response
        ?? inspection.response,
      entries: transcriptEntries,
    });
  }
  return [...merged.values()];
}

export function mergeChatSubagentSummaries(
  summaries: ChatWorkManifestSubagentSummary[],
): ChatWorkManifestSubagentSummary[] {
  return mergeChatSubagentInspections(summaries.map((summary) => ({
    ...summary,
    response: null,
    entries: [],
  }))).map(({ response: _response, entries: _entries, ...summary }) => summary);
}
