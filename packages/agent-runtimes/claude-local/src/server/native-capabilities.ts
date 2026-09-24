import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ClaudeCapabilityStatus = "supported" | "unsupported" | "unknown";

export type ClaudeCapabilityEvidence = {
  status: ClaudeCapabilityStatus;
  reason: string;
  providerVersion?: string | null;
  transport?: string | null;
  profileBound: boolean;
  profileRequired?: boolean;
};

export type ClaudeProviderBindingRef = {
  id?: string | null;
  orgId?: string | null;
  hostId: string;
  profileId: string;
  workspaceBindingId?: string | null;
  capabilityRevision?: string | null;
};

export type ClaudeProviderSessionRef = {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  sessionDisplayId: string;
};

export type ClaudeDeferredForkIntent = {
  version: 1;
  kind: "claude_fork_on_first_input";
  sourceBindingId: string;
  sourceSession: ClaudeProviderSessionRef;
  sourceSelector: {
    kind: "claude_chain";
    sessionId: string;
    throughInclusiveUuid: string;
    boundaryStatus?: string | null;
    ancestryRevision?: string | null;
  };
};

export type ClaudeAssistantHeadCheck = {
  status: "matched" | "mismatch" | "unavailable";
  sourceAssistantUuid: string;
  currentAssistantUuid: string | null;
  revision: string | null;
  reason: string | null;
};

export type ClaudeTranscriptRange = {
  start?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  end?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  fromExclusive?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  throughInclusive?: string | number | { itemId?: string | null; ordinal?: number | null } | null;
  itemId?: string | null;
};

export type ClaudeNativeTranscriptRawItem = {
  id: string;
  sourceEntryId: string;
  ordinal: number;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
  entry: TranscriptEntry;
  origin: "native";
  visibility: "visible";
  text?: string;
};

export type ClaudeNativeTranscriptReadRequest = {
  runtimeType: string;
  session: ClaudeProviderSessionRef;
  selector?: Record<string, unknown> | null;
  binding?: ClaudeProviderBindingRef | null;
  range?: ClaudeTranscriptRange | null;
  from?: string | null;
  through?: string | null;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type ClaudeNativeTranscriptReadResult = {
  items: readonly ClaudeNativeTranscriptRawItem[];
  nextCursor: string | null;
  source: "native";
  revision: string;
  availability: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
};

/** The only provider-owned state needed to read an official Claude session. */
export type ClaudeLocalProfileTransport = {
  binding: ClaudeProviderBindingRef;
  command?: string;
  cwd: string;
  configDir: string;
  providerVersion: string;
  readFile?: (filePath: string) => Promise<string>;
};

export type ClaudeLocalProfileTransportResolver = (
  binding: ClaudeProviderBindingRef,
) => ClaudeLocalProfileTransport | null | undefined;

type ClaudeRecord = Record<string, unknown>;
type ClaudeParsedRecord = {
  record: ClaudeRecord;
  line: number;
  uuid: string | null;
  parentUuid: string | null;
};

const CLAUDE_NATIVE_TRANSPORT = "claude-cli-jsonl";
const CLAUDE_NATIVE_VERSION = "2.1.216";
const TRANSCRIPT_PAGE_SIZE = 100;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): ClaudeRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ClaudeRecord
    : null;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function bindingMatches(requested: ClaudeProviderBindingRef, profile: ClaudeLocalProfileTransport): boolean {
  const optionalIdentityMatches = (key: keyof ClaudeProviderBindingRef): boolean => {
    const expected = requested[key];
    return expected === undefined || expected === null
      ? true
      : profile.binding[key] === expected;
  };
  return profile.binding.hostId.trim() === requested.hostId.trim()
    && profile.binding.profileId.trim() === requested.profileId.trim()
    && optionalIdentityMatches("id")
    && optionalIdentityMatches("orgId")
    && optionalIdentityMatches("workspaceBindingId")
    && optionalIdentityMatches("capabilityRevision");
}

function profileIdentityMatches(params: Record<string, unknown>, binding: ClaudeProviderBindingRef): boolean {
  const storedHost = stringValue(params.profileHostId ?? params.providerHostId ?? params.hostId);
  const storedProfile = stringValue(params.profileId ?? params.providerProfileId);
  const storedBindingId = stringValue(params.profileBindingId ?? params.providerBindingId ?? params.bindingId);
  const storedOrgId = stringValue(params.profileOrgId ?? params.providerOrgId ?? params.orgId);
  const storedWorkspaceBindingId = stringValue(params.workspaceBindingId ?? params.providerWorkspaceBindingId);
  const storedCapabilityRevision = stringValue(params.capabilityRevision);
  return (!storedHost || storedHost === binding.hostId)
    && (!storedProfile || storedProfile === binding.profileId)
    && (!storedBindingId || !binding.id || storedBindingId === binding.id)
    && (!storedOrgId || !binding.orgId || storedOrgId === binding.orgId)
    && (!storedWorkspaceBindingId || !binding.workspaceBindingId || storedWorkspaceBindingId === binding.workspaceBindingId)
    && (!storedCapabilityRevision || !binding.capabilityRevision || storedCapabilityRevision === binding.capabilityRevision);
}

function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function resolveClaudeSessionFilePath(configDir: string, cwd: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) {
    throw new Error("Claude session ID contains path separators or unsupported characters.");
  }
  return path.join(configDir, "projects", encodeClaudeProjectPath(path.resolve(cwd)), `${sessionId}.jsonl`);
}

export function parseClaudeSessionJsonl(raw: string): {
  records: ClaudeParsedRecord[];
  malformed: boolean;
} {
  const records: ClaudeParsedRecord[] = [];
  let malformed = false;
  raw.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      const record = recordValue(parsed);
      if (!record) {
        malformed = true;
        return;
      }
      records.push({
        record,
        line: lineIndex,
        uuid: stringValue(record.uuid),
        parentUuid: stringValue(record.parentUuid ?? record.parent_uuid),
      });
    } catch {
      malformed = true;
    }
  });
  return { records, malformed };
}

function selectorValue(selector: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!selector) return null;
  for (const key of keys) {
    const value = stringValue(selector[key]);
    if (value) return value;
  }
  return null;
}

function boundaryValue(
  value: string | number | { itemId?: string | null; ordinal?: number | null } | null | undefined,
): { id: string | null; ordinal: number | null } {
  if (typeof value === "string") return { id: value, ordinal: null };
  if (typeof value === "number" && Number.isFinite(value)) return { id: null, ordinal: value };
  if (value && typeof value === "object") {
    return {
      id: stringValue(value.itemId),
      ordinal: typeof value.ordinal === "number" && Number.isFinite(value.ordinal) ? value.ordinal : null,
    };
  }
  return { id: null, ordinal: null };
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const record = recordValue(value);
  if (!record) return undefined;
  for (const key of ["text", "thinking", "content", "result", "message", "delta"]) {
    const text = textFrom(record[key]);
    if (text !== undefined) return text;
  }
  if (Array.isArray(record.content)) {
    const text = record.content.map((entry) => textFrom(entry)).filter((entry): entry is string => entry !== undefined).join("\n");
    return text || undefined;
  }
  return undefined;
}

function recordTimestamp(record: ClaudeRecord): string {
  return stringValue(record.timestamp ?? record.created_at ?? record.createdAt) ?? "";
}

function contentBlocks(record: ClaudeRecord): ClaudeRecord[] {
  const message = recordValue(record.message);
  const content = message?.content ?? record.content;
  if (!Array.isArray(content)) return [];
  return content.map(recordValue).filter((entry): entry is ClaudeRecord => Boolean(entry));
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sessionIdFromRecord(record: ClaudeRecord): string {
  return stringValue(record.session_id ?? record.sessionId) ?? "";
}

function normalizedEntryForBlock(
  record: ClaudeRecord,
  block: ClaudeRecord,
  sourceEntryId: string,
  timestamp: string,
): TranscriptEntry | null {
  const recordType = stringValue(record.type) ?? "";
  const blockType = stringValue(block.type) ?? "";
  const text = textFrom(block);
  if (recordType === "assistant") {
    if (blockType === "text" && text !== undefined) {
      return { kind: "assistant", ts: timestamp, text, sourceEntryId };
    }
    if (blockType === "thinking" && text !== undefined) {
      return { kind: "thinking", ts: timestamp, text, sourceEntryId };
    }
    if (blockType === "tool_use" || blockType.endsWith("_tool_use")) {
      return {
        kind: "tool_call",
        ts: timestamp,
        name: stringValue(block.name) ?? blockType,
        input: block.input ?? {},
        ...(stringValue(block.id ?? block.tool_use_id) ? { toolUseId: stringValue(block.id ?? block.tool_use_id)! } : {}),
        sourceEntryId,
      };
    }
  }
  if (recordType === "user") {
    if (blockType === "text" && text !== undefined) {
      return { kind: "user", ts: timestamp, text, sourceEntryId };
    }
    if (blockType === "tool_result" || blockType.endsWith("_tool_result")) {
      return {
        kind: "tool_result",
        ts: timestamp,
        toolUseId: stringValue(block.tool_use_id ?? block.toolUseId) ?? sourceEntryId,
        ...(stringValue(block.tool_name ?? block.name) ? { toolName: stringValue(block.tool_name ?? block.name)! } : {}),
        content: text ?? "",
        isError: block.is_error === true,
        sourceEntryId,
      };
    }
  }
  return null;
}

function normalizedEntryForRecord(
  record: ClaudeRecord,
  sourceEntryId: string,
  timestamp: string,
): TranscriptEntry {
  const recordType = stringValue(record.type) ?? "";
  const text = textFrom(record) ?? "";
  if (recordType === "assistant") return { kind: "assistant", ts: timestamp, text, sourceEntryId };
  if (recordType === "user") return { kind: "user", ts: timestamp, text, sourceEntryId };
  if (recordType === "system" && stringValue(record.subtype) === "init") {
    return {
      kind: "init",
      ts: timestamp,
      model: stringValue(record.model) ?? "unknown",
      sessionId: sessionIdFromRecord(record),
      sourceEntryId,
    };
  }
  if (recordType === "result") {
    const usage = recordValue(record.usage) ?? {};
    return {
      kind: "result",
      ts: timestamp,
      text: typeof record.result === "string" ? record.result : "",
      inputTokens: numberValue(usage.input_tokens),
      outputTokens: numberValue(usage.output_tokens),
      cachedTokens: numberValue(usage.cache_read_input_tokens) + numberValue(usage.cache_creation_input_tokens),
      costUsd: numberValue(record.total_cost_usd),
      subtype: stringValue(record.subtype) ?? "",
      isError: record.is_error === true,
      errors: Array.isArray(record.errors) ? record.errors.filter((error): error is string => typeof error === "string") : [],
      sourceEntryId,
    };
  }
  return { kind: "stdout", ts: timestamp, text, sourceEntryId };
}

function selectedRecordChain(
  records: ClaudeParsedRecord[],
  selector: Record<string, unknown> | null | undefined,
  request: ClaudeNativeTranscriptReadRequest,
): { records: ClaudeParsedRecord[]; error?: string } {
  const through = selectorValue(selector, ["throughInclusiveUuid", "through", "executionRef"]) ?? request.through;
  const start = selectorValue(selector, ["startExclusiveUuid", "fromExclusive", "from"]) ?? request.from;
  if (selector?.kind === "claude_chain" && (!through || selector.boundaryStatus === "missing")) {
    return { records: [], error: "Claude Run has no verified native execution range." };
  }
  if (!through && !start) return { records };

  const byUuid = new Map(records.flatMap((entry) => entry.uuid ? [[entry.uuid, entry] as const] : []));
  const throughRecord = through ? byUuid.get(through) : records[records.length - 1];
  if (through && !throughRecord) return { records: [], error: `Claude session has no record with UUID ${through}.` };
  if (!throughRecord) return { records: [] };

  const chain = new Set<string>();
  let current: ClaudeParsedRecord | undefined = throughRecord;
  const visited = new Set<string>();
  while (current) {
    if (current.uuid) {
      if (visited.has(current.uuid)) return { records: [], error: "Claude session parentUuid chain contains a cycle." };
      visited.add(current.uuid);
      chain.add(current.uuid);
    }
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }

  let selected = records.filter((entry) => entry.uuid ? chain.has(entry.uuid) : false);
  if (start) {
    const startRecord = byUuid.get(start);
    if (!startRecord || !startRecord.uuid || !chain.has(startRecord.uuid)) {
      return { records: [], error: `Claude session start boundary ${start} is outside the selected parentUuid chain.` };
    }
    selected = selected.filter((entry) => entry.line > startRecord.line);
  }
  return { records: selected };
}

function itemsFromRecords(records: ClaudeParsedRecord[]): ClaudeNativeTranscriptRawItem[] {
  const items: ClaudeNativeTranscriptRawItem[] = [];
  for (const parsed of records) {
    const recordType = stringValue(parsed.record.type) ?? "record";
    const sourceId = parsed.uuid ?? `line:${parsed.line}`;
    const blocks = contentBlocks(parsed.record);
    const timestamp = recordTimestamp(parsed.record) || new Date(0).toISOString();
    if (blocks.length === 0) {
      const text = textFrom(parsed.record);
      items.push({
        id: `claude:${sourceId}`,
        sourceEntryId: sourceId,
        ordinal: parsed.line,
        kind: `claude:${recordType}`,
        ts: timestamp,
        payload: { provider: "claude_code", record: parsed.record },
        entry: normalizedEntryForRecord(parsed.record, sourceId, timestamp),
        origin: "native",
        visibility: "visible",
        ...(text !== undefined ? { text } : {}),
      });
      continue;
    }
    blocks.forEach((block, blockIndex) => {
      const blockType = stringValue(block.type) ?? "content";
      const blockText = textFrom(block);
      items.push({
        id: `claude:${sourceId}:block:${blockIndex}`,
        sourceEntryId: `${sourceId}:block:${blockIndex}`,
        ordinal: parsed.line * 1000 + blockIndex,
        kind: `claude:${recordType}:${blockType}`,
        ts: timestamp,
        payload: { provider: "claude_code", record: parsed.record, block },
        entry: normalizedEntryForBlock(parsed.record, block, `${sourceId}:block:${blockIndex}`, timestamp)
          ?? normalizedEntryForRecord(parsed.record, `${sourceId}:block:${blockIndex}`, timestamp),
        origin: "native",
        visibility: "visible",
        ...(blockText !== undefined ? { text: blockText } : {}),
      });
    });
  }
  return items;
}

function applyRange(items: ClaudeNativeTranscriptRawItem[], range: ClaudeTranscriptRange | null | undefined): ClaudeNativeTranscriptRawItem[] {
  if (!range) return items;
  if (range.itemId) return items.filter((item) => item.id === range.itemId || item.sourceEntryId === range.itemId);
  const start = boundaryValue(range.start ?? range.fromExclusive);
  const end = boundaryValue(range.end ?? range.throughInclusive);
  let selected = items;
  if (start.id) {
    const index = selected.findIndex((item) => item.id === start.id || item.sourceEntryId === start.id);
    if (index >= 0) selected = selected.slice(range.fromExclusive !== undefined ? index + 1 : index);
  } else if (start.ordinal !== null) {
    selected = selected.filter((item) => item.ordinal >= start.ordinal! + (range.fromExclusive !== undefined ? 1 : 0));
  }
  if (end.id) {
    const index = selected.findIndex((item) => item.id === end.id || item.sourceEntryId === end.id);
    if (index >= 0) selected = selected.slice(0, index + 1);
  } else if (end.ordinal !== null) {
    selected = selected.filter((item) => item.ordinal <= end.ordinal!);
  }
  return selected;
}

function decodeCursor(cursor: string | null | undefined, revision: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { revision?: string; offset?: number };
    return parsed.revision === revision && Number.isInteger(parsed.offset) && parsed.offset! >= 0 ? parsed.offset! : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ revision, offset }), "utf8").toString("base64url");
}

async function readProfileSession(
  profile: ClaudeLocalProfileTransport,
  request: ClaudeNativeTranscriptReadRequest,
): Promise<ClaudeNativeTranscriptReadResult> {
  const loaded = await loadProfileSessionRecords(profile, request);
  if (loaded.status !== "available") {
    return {
      items: [],
      nextCursor: null,
      source: "native",
      revision: loaded.revision,
      availability: loaded.status,
      completeness: "unknown",
    };
  }
  const selected = selectedRecordChain(loaded.records, request.selector, request);
  if (selected.error) {
    return { items: [], nextCursor: null, source: "native", revision: loaded.revision, availability: "incompatible", completeness: "unknown" };
  }
  const ranged = applyRange(itemsFromRecords(selected.records), request.range);
  const offset = decodeCursor(request.cursor, loaded.revision);
  const page = ranged.slice(offset, offset + TRANSCRIPT_PAGE_SIZE);
  const nextCursor = offset + page.length < ranged.length ? encodeCursor(loaded.revision, offset + page.length) : null;
  return {
    items: page,
    nextCursor,
    source: "native",
    revision: loaded.revision,
    availability: "available",
    completeness: loaded.malformed ? "partial" : "complete",
  };
}

type ClaudeProfileSessionLoad =
  | { status: "available"; revision: string; records: ClaudeParsedRecord[]; malformed: boolean }
  | { status: "missing" | "incompatible"; revision: string };

async function loadProfileSessionRecords(
  profile: ClaudeLocalProfileTransport,
  request: ClaudeNativeTranscriptReadRequest,
): Promise<ClaudeProfileSessionLoad> {
  const binding = request.binding;
  if (!binding || !binding.hostId.trim() || !binding.profileId.trim()) {
    return { status: "missing", revision: "missing-binding" };
  }
  if (request.runtimeType !== "claude_local") {
    return { status: "incompatible", revision: "runtime-mismatch" };
  }
  if (!bindingMatches(binding, profile)) {
    return { status: "incompatible", revision: "profile-mismatch" };
  }
  const sessionId = request.session.sessionId.trim();
  const params = request.session.sessionParams;
  if (!sessionId || !profileIdentityMatches(params, binding)) {
    return { status: "incompatible", revision: "session-profile-mismatch" };
  }
  const storedCwd = stringValue(params.cwd);
  if (storedCwd && path.resolve(storedCwd) !== path.resolve(profile.cwd)) {
    return { status: "incompatible", revision: "cwd-mismatch" };
  }
  const storedConfigDir = stringValue(params.claudeConfigDir ?? params.configDir);
  if (storedConfigDir && path.resolve(storedConfigDir) !== path.resolve(profile.configDir)) {
    return { status: "incompatible", revision: "config-dir-mismatch" };
  }

  let filePath: string;
  try {
    const expectedPath = resolveClaudeSessionFilePath(profile.configDir, profile.cwd, sessionId);
    const storedPath = stringValue(params.sessionFilePath ?? params.claudeSessionFilePath);
    if (storedPath && path.resolve(storedPath) !== path.resolve(expectedPath)) {
      return { status: "incompatible", revision: "session-file-mismatch" };
    }
    filePath = expectedPath;
  } catch {
    return { status: "incompatible", revision: "invalid-session" };
  }

  let raw: string;
  try {
    raw = await (profile.readFile ?? ((target) => fs.readFile(target, "utf8")))(filePath);
  } catch {
    return { status: "missing", revision: `missing:${stableHash(filePath)}` };
  }
  const revision = stableHash(raw);
  const parsed = parseClaudeSessionJsonl(raw);
  return { status: "available", revision, records: parsed.records, malformed: parsed.malformed };
}

function isCompletedAssistantRecord(record: ClaudeRecord): boolean {
  if (stringValue(record.type) !== "assistant") return false;
  const message = recordValue(record.message);
  const stopReason = stringValue(message?.stop_reason ?? message?.stopReason ?? record.stop_reason)?.toLowerCase();
  return stopReason === "end_turn";
}

export async function verifyClaudeSessionAssistantHead(input: {
  profile: ClaudeLocalProfileTransport;
  binding: ClaudeProviderBindingRef;
  session: ClaudeProviderSessionRef;
  sourceAssistantUuid: string;
}): Promise<ClaudeAssistantHeadCheck> {
  const sourceAssistantUuid = input.sourceAssistantUuid.trim();
  const unavailable = (reason: string, revision: string | null = null): ClaudeAssistantHeadCheck => ({
    status: "unavailable",
    sourceAssistantUuid,
    currentAssistantUuid: null,
    revision,
    reason,
  });
  if (!sourceAssistantUuid) return unavailable("The source assistant UUID is missing.");

  const loaded = await loadProfileSessionRecords(input.profile, {
    runtimeType: "claude_local",
    binding: input.binding,
    session: input.session,
    selector: null,
  });
  if (loaded.status !== "available") {
    return unavailable(`Claude session head could not be verified (${loaded.revision}).`, loaded.revision);
  }
  if (loaded.malformed) return unavailable("Claude session JSONL is malformed or incomplete.", loaded.revision);

  const byUuid = new Map<string, ClaudeParsedRecord>();
  for (const parsed of loaded.records) {
    const recordSessionId = sessionIdFromRecord(parsed.record);
    if (recordSessionId && recordSessionId !== input.session.sessionId) {
      return unavailable("Claude session JSONL contains a different session ID.", loaded.revision);
    }
    if (!parsed.uuid) {
      if (stringValue(parsed.record.type) === "assistant") {
        return unavailable("Claude session contains an assistant event without a stable UUID.", loaded.revision);
      }
      continue;
    }
    if (byUuid.has(parsed.uuid)) {
      return unavailable("Claude session JSONL contains duplicate UUIDs.", loaded.revision);
    }
    byUuid.set(parsed.uuid, parsed);
  }

  let current = [...byUuid.values()].at(-1);
  if (!current) return unavailable("Claude session has no UUID-bearing provider events.", loaded.revision);
  const chain: ClaudeParsedRecord[] = [];
  const visited = new Set<string>();
  while (current) {
    if (!current.uuid || visited.has(current.uuid)) {
      return unavailable("Claude session parentUuid chain is cyclic or ambiguous.", loaded.revision);
    }
    visited.add(current.uuid);
    chain.push(current);
    if (!current.parentUuid) break;
    const parent = byUuid.get(current.parentUuid);
    if (!parent) return unavailable("Claude session parentUuid chain is incomplete.", loaded.revision);
    current = parent;
  }

  const terminalChainRecord = chain.find((entry) => stringValue(entry.record.type) !== "result");
  if (!terminalChainRecord || !isCompletedAssistantRecord(terminalChainRecord.record) || !terminalChainRecord.uuid) {
    return unavailable("Claude session terminal chain head is not a completed assistant event.", loaded.revision);
  }
  const laterConversationRecord = loaded.records.find((entry) => (
    entry.line > terminalChainRecord.line
    && ["assistant", "user"].includes(stringValue(entry.record.type) ?? "")
  ));
  if (laterConversationRecord) {
    return unavailable("Claude session contains a later conversation event after its completed assistant head.", loaded.revision);
  }
  const status = terminalChainRecord.uuid === sourceAssistantUuid ? "matched" : "mismatch";
  return {
    status,
    sourceAssistantUuid,
    currentAssistantUuid: terminalChainRecord.uuid,
    revision: loaded.revision,
    reason: status === "matched"
      ? null
      : `Claude session head advanced to assistant UUID ${terminalChainRecord.uuid}.`,
  };
}

function profileEvidence(profile: ClaudeLocalProfileTransport): ClaudeCapabilityEvidence {
  const hasIdentity = Boolean(profile.binding.hostId.trim() && profile.binding.profileId.trim());
  if (!hasIdentity || !profile.cwd.trim() || !profile.configDir.trim()) {
    return {
      status: "unknown",
      reason: "Claude profile transport is missing host/profile identity, cwd, or CLAUDE_CONFIG_DIR.",
      providerVersion: profile.providerVersion ?? null,
      transport: CLAUDE_NATIVE_TRANSPORT,
      profileBound: false,
      profileRequired: true,
    };
  }
  if (!profile.providerVersion.trim()) {
    return {
      status: "unknown",
      reason: "Claude Code provider version is required before selecting the session-store protocol.",
      transport: CLAUDE_NATIVE_TRANSPORT,
      profileBound: true,
      profileRequired: true,
    };
  }
  return {
    status: "supported",
    reason: `Claude Code ${profile.providerVersion} --resume and its profile-owned JSONL session store are bound to ${profile.binding.hostId}/${profile.binding.profileId}.`,
    providerVersion: profile.providerVersion,
    transport: CLAUDE_NATIVE_TRANSPORT,
    profileBound: true,
    profileRequired: true,
  };
}

function unsupportedNativeEvidence(
  profile: ClaudeLocalProfileTransport,
  capability: "fork" | "steer" | "interrupt",
): ClaudeCapabilityEvidence {
  const evidence = profileEvidence(profile);
  if (evidence.status !== "supported") {
    return {
      ...evidence,
      reason: `${evidence.reason} Claude ${capability} remains unclassified until the verified profile transport is available.`,
    };
  }
  const reason = capability === "fork"
    ? "Claude Code CLI supports --fork-session with --resume/--continue, but it does not accept a completed assistant UUID as the fork boundary. This adapter has no bound Agent SDK operation to create that branch without submitting a query, so exact native Side Chat fork is unsupported."
    : capability === "steer"
      ? "Claude Code supports text steer through its official --input-format stream-json user-message protocol; a live execute handle is required before sending it."
      : "Claude Code has no provider message-level interrupt command; process interruption remains lifecycle-authoritative and is only available through a live execute handle.";
  return {
    status: capability === "fork" ? "unsupported" : "supported",
    reason: `Claude Code ${profile.providerVersion || CLAUDE_NATIVE_VERSION}: ${reason}`,
    providerVersion: profile.providerVersion ?? null,
    transport: capability === "fork" ? CLAUDE_NATIVE_TRANSPORT : "claude-cli-stream-json",
    profileBound: true,
    profileRequired: true,
  };
}

const staticSessionResumeEvidence: ClaudeCapabilityEvidence = {
  status: "supported",
  reason: "Claude Code execute uses the official --resume session argument; a concrete profile-owned session store is required for native history.",
  transport: "claude-cli",
  profileBound: false,
  profileRequired: true,
};

const staticInputEvidence: ClaudeCapabilityEvidence = {
  status: "supported",
  reason: "Claude Code execute is the registered stdin prompt submission boundary.",
  transport: "claude-cli",
  profileBound: true,
  profileRequired: false,
};

const staticContextEvidence: ClaudeCapabilityEvidence = {
  status: "supported",
  reason: "Claude context handoff is an auditable prompt/system-prompt projection; it is not a native Claude branch.",
  transport: "claude-cli",
  profileBound: true,
  profileRequired: false,
};

const staticTranscriptEvidence: ClaudeCapabilityEvidence = {
  status: "unknown",
  reason: "Claude native history is available only after a host-owned profile transport resolves CLAUDE_CONFIG_DIR and the requested session store.",
  transport: CLAUDE_NATIVE_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};

const staticForkEvidence: ClaudeCapabilityEvidence = {
  status: "unknown",
  reason: "Claude boundary fork cannot be classified until the requested provider profile is bound; the unbound adapter does not claim a fork hook.",
  transport: "claude-cli",
  profileBound: false,
  profileRequired: true,
};

const staticControlEvidence: ClaudeCapabilityEvidence = {
  status: "unknown",
  reason: "Claude active-turn control requires a bound provider transport; the CLI adapter does not infer native control from process signals.",
  transport: "claude-cli",
  profileBound: false,
  profileRequired: true,
};

type ClaudeRuntimeProviderCapabilityRegistration = {
  runtimeType: "claude_local";
  sessionResume: { evidence: ClaudeCapabilityEvidence };
  input: { evidence: ClaudeCapabilityEvidence };
  contextHandoff: { evidence: ClaudeCapabilityEvidence };
  transcript: { evidence: ClaudeCapabilityEvidence };
  fork: { evidence: ClaudeCapabilityEvidence };
  control: {
    steer: { evidence: ClaudeCapabilityEvidence };
    interrupt: { evidence: ClaudeCapabilityEvidence };
  };
};

export const runtimeProviderCapabilities: ClaudeRuntimeProviderCapabilityRegistration = {
  runtimeType: "claude_local",
  sessionResume: { evidence: staticSessionResumeEvidence },
  input: { evidence: staticInputEvidence },
  contextHandoff: { evidence: staticContextEvidence },
  transcript: { evidence: staticTranscriptEvidence },
  fork: { evidence: staticForkEvidence },
  control: {
    steer: { evidence: staticControlEvidence },
    interrupt: { evidence: staticControlEvidence },
  },
};

type ProviderControlOperation =
  | { kind: "steer"; input: AgentRuntimeControlSteerInput }
  | { kind: "interrupt"; reason: AgentRuntimeControlInterruptReason };

type ProviderControlRequest = {
  runtimeType: string;
  handle: AgentRuntimeControlHandle | null;
  operation: ProviderControlOperation;
  session?: ClaudeProviderSessionRef | null;
  binding?: ClaudeProviderBindingRef | null;
};

async function delegateSteer(input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  if (!input.handle || input.operation.kind !== "steer") {
    return { disposition: "acceptance_unknown", reason: "Claude stream-json steer requires a live execute control handle." };
  }
  return input.handle.steer(input.operation.input);
}

async function delegateInterrupt(input: ProviderControlRequest): Promise<AgentRuntimeControlInterruptResult> {
  if (!input.handle || input.operation.kind !== "interrupt") return "unverified";
  return input.handle.interrupt(input.operation.reason);
}

export interface ClaudeRuntimeProviderCapabilityAdapter {
  runtimeType: "claude_local";
  sessionResume: { evidence: ClaudeCapabilityEvidence };
  input: { evidence: ClaudeCapabilityEvidence };
  contextHandoff: { evidence: ClaudeCapabilityEvidence };
  transcript: {
    evidence: ClaudeCapabilityEvidence;
    readRange: (input: ClaudeNativeTranscriptReadRequest) => Promise<ClaudeNativeTranscriptReadResult>;
  };
  fork: { evidence: ClaudeCapabilityEvidence };
  control: {
    steer: {
      evidence: ClaudeCapabilityEvidence;
      mode: "native";
      requiresHandle: true;
      execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlSteerResult>;
    };
    interrupt: {
      evidence: ClaudeCapabilityEvidence;
      mode: "process";
      requiresHandle: true;
      execute: (input: ProviderControlRequest) => Promise<AgentRuntimeControlInterruptResult>;
    };
  };
}

function boundCapabilities(profile: ClaudeLocalProfileTransport): ClaudeRuntimeProviderCapabilityAdapter {
  const evidence = profileEvidence(profile);
  const cliEvidence: ClaudeCapabilityEvidence = {
    ...staticInputEvidence,
    providerVersion: profile.providerVersion || null,
    profileBound: Boolean(profile.binding.hostId.trim() && profile.binding.profileId.trim()),
    reason: `Claude Code ${profile.providerVersion || "unknown"} uses the bound ${profile.command?.trim() || "claude"} CLI for prompt input.`,
  };
  const resumeEvidence: ClaudeCapabilityEvidence = {
    ...evidence,
    transport: "claude-cli",
    reason: `${evidence.reason} Session continuity is the official --resume operation, not a native boundary fork.`,
  };
  return {
    runtimeType: "claude_local",
    sessionResume: { evidence: resumeEvidence },
    input: { evidence: cliEvidence },
    contextHandoff: {
      evidence: {
        ...cliEvidence,
        reason: `${cliEvidence.reason} Context handoff remains an auditable prompt projection, not a native branch.`,
      },
    },
    transcript: {
      evidence,
      readRange: (input) => readProfileSession(profile, input),
    },
    fork: { evidence: unsupportedNativeEvidence(profile, "fork") },
    control: {
      steer: {
        evidence: unsupportedNativeEvidence(profile, "steer"),
        mode: "native",
        requiresHandle: true,
        execute: delegateSteer,
      },
      interrupt: {
        evidence: unsupportedNativeEvidence(profile, "interrupt"),
        mode: "process",
        requiresHandle: true,
        execute: delegateInterrupt,
      },
    },
  };
}

export function createClaudeLocalProviderCapabilities(
  profile: ClaudeLocalProfileTransport,
): ClaudeRuntimeProviderCapabilityAdapter {
  return boundCapabilities(profile);
}

function unknownCapabilities(reason: string): ClaudeRuntimeProviderCapabilityAdapter {
  const evidence: ClaudeCapabilityEvidence = {
    ...staticTranscriptEvidence,
    reason: `${reason} A profile-bound Claude JSONL source was not resolved.`,
  };
  return {
    runtimeType: "claude_local",
    sessionResume: { evidence: { ...staticSessionResumeEvidence, reason } },
    input: { evidence: staticInputEvidence },
    contextHandoff: { evidence: staticContextEvidence },
    transcript: {
      evidence,
      readRange: async () => ({ items: [], nextCursor: null, source: "native", revision: "unavailable", availability: "offline", completeness: "unknown" }),
    },
    fork: { evidence: { ...staticForkEvidence, reason } },
    control: {
      steer: { evidence: { ...staticControlEvidence, reason }, mode: "native", requiresHandle: true, execute: delegateSteer },
      interrupt: { evidence: { ...staticControlEvidence, reason }, mode: "process", requiresHandle: true, execute: delegateInterrupt },
    },
  };
}

export function createClaudeLocalProviderCapabilityResolver(
  resolveProfile: ClaudeLocalProfileTransportResolver | null | undefined,
): (runtimeType: string, binding?: ClaudeProviderBindingRef | null) => ClaudeRuntimeProviderCapabilityAdapter | null {
  return (runtimeType, binding) => {
    if (runtimeType !== "claude_local") return null;
    if (!binding?.hostId?.trim() || !binding.profileId?.trim()) {
      return unknownCapabilities("Claude native history and native control require an explicit host/profile binding.");
    }
    if (!resolveProfile) {
      return unknownCapabilities("No Claude profile-bound session-store resolver is installed.");
    }
    let profile: ClaudeLocalProfileTransport | null | undefined;
    try {
      profile = resolveProfile(binding);
    } catch (error) {
      return unknownCapabilities(`Claude profile transport resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!profile) return unknownCapabilities(`No Claude session-store transport is authorized for profile ${binding.profileId}.`);
    if (!bindingMatches(binding, profile)) {
      const reason = `Claude profile transport identity mismatch; native history and native control are unsupported for requested ${binding.hostId}/${binding.profileId}.`;
      const mismatch = unknownCapabilities(reason);
      mismatch.transcript.evidence = { ...mismatch.transcript.evidence, status: "unsupported", reason };
      mismatch.fork.evidence = { ...mismatch.fork.evidence, status: "unsupported", reason };
      mismatch.control.steer.evidence = { ...mismatch.control.steer.evidence, status: "unsupported", reason };
      mismatch.control.interrupt.evidence = { ...mismatch.control.interrupt.evidence, status: "unsupported", reason };
      return mismatch;
    }
    return boundCapabilities(profile);
  };
}

export const resolveClaudeLocalProviderCapabilities = createClaudeLocalProviderCapabilityResolver;
