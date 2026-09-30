import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlInterruptReason,
  AgentRuntimeControlInterruptResult,
  AgentRuntimeControlSteerInput,
  AgentRuntimeControlSteerResult,
  TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
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

export type ClaudeNativeForkRequest = {
  runtimeType: string;
  session: ClaudeProviderSessionRef;
  boundary: string;
  selector?: Record<string, unknown> | null;
  binding?: ClaudeProviderBindingRef | null;
  signal?: AbortSignal;
};

export type ClaudeNativeForkResult = {
  session: ClaudeProviderSessionRef;
  boundary: string;
  sourceBoundary: string;
  identityMap: Record<string, string>;
  continuity: "native";
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
const CLAUDE_FORK_SDK_VERSION = "0.3.216";
const CLAUDE_FORK_SDK_CLI_VERSION = "2.1.216";
const CLAUDE_FORK_TRANSPORT = `claude-agent-sdk-${CLAUDE_FORK_SDK_VERSION}`;
const TRANSCRIPT_PAGE_SIZE = 100;
const CLAUDE_SESSION_EVENT_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);
const CLAUDE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const claudeRequire = createRequire(import.meta.url);

const CLAUDE_FORK_WORKER_SOURCE = `
import { pathToFileURL } from "node:url";

try {
  const { forkSession } = await import(pathToFileURL(process.env.RUDDER_CLAUDE_AGENT_SDK_ENTRY).href);
  if (typeof forkSession !== "function") throw new Error("The pinned Claude SDK has no forkSession operation.");
  let inputJson = "";
  for await (const chunk of process.stdin) inputJson += chunk;
  const input = JSON.parse(inputJson);
  const result = await forkSession(input.sessionId, {
    dir: input.cwd,
    upToMessageId: input.boundary,
  });
  process.stdout.write("RUDDER_CLAUDE_FORK_RESULT:" + JSON.stringify(result));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
`;

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
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) {
    hash = (hash << 5) - hash + cwd.charCodeAt(index) | 0;
  }
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
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
    let startRecord = byUuid.get(start);
    if (startRecord?.uuid && !chain.has(startRecord.uuid) && stringValue(startRecord.record.type) === "result") {
      const parent = startRecord.parentUuid ? byUuid.get(startRecord.parentUuid) : undefined;
      if (parent?.uuid && chain.has(parent.uuid) && stringValue(parent.record.type) === "assistant") {
        startRecord = parent;
      }
    }
    if (!startRecord?.uuid || !chain.has(startRecord.uuid)) {
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

type ClaudeForkSdkResolution =
  | { status: "available"; entry: string }
  | { status: "unavailable"; reason: string };

function resolveClaudeForkSdk(): ClaudeForkSdkResolution {
  let entry: string;
  try {
    entry = claudeRequire.resolve(CLAUDE_AGENT_SDK_PACKAGE);
  } catch {
    return { status: "unavailable", reason: `The pinned ${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_FORK_SDK_VERSION} package is not installed.` };
  }

  let directory = path.dirname(entry);
  while (true) {
    try {
      const manifest = recordValue(JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")));
      if (manifest?.name === CLAUDE_AGENT_SDK_PACKAGE) {
        const sdkVersion = stringValue(manifest.version);
        const pairedCliVersion = stringValue(manifest.claudeCodeVersion);
        if (sdkVersion !== CLAUDE_FORK_SDK_VERSION || pairedCliVersion !== CLAUDE_FORK_SDK_CLI_VERSION) {
          return {
            status: "unavailable",
            reason: `Claude Agent SDK ${sdkVersion ?? "unknown"} declares Claude Code ${pairedCliVersion ?? "unknown"}; Rudder requires SDK ${CLAUDE_FORK_SDK_VERSION} paired with Claude Code ${CLAUDE_FORK_SDK_CLI_VERSION}.`,
          };
        }
        return { status: "available", entry };
      }
    } catch {
      // Continue walking toward the package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { status: "unavailable", reason: `Could not verify the installed ${CLAUDE_AGENT_SDK_PACKAGE} package metadata.` };
}

function claudeForkEvidence(profile: ClaudeLocalProfileTransport): ClaudeCapabilityEvidence {
  const base = profileEvidence(profile);
  if (base.status !== "supported") return base;
  if (!path.isAbsolute(profile.cwd) || !path.isAbsolute(profile.configDir)) {
    return {
      ...base,
      status: "unsupported",
      transport: CLAUDE_FORK_TRANSPORT,
      reason: "Claude exact boundary fork requires absolute host-authorized cwd and CLAUDE_CONFIG_DIR paths.",
    };
  }
  if (profile.readFile) {
    return {
      ...base,
      status: "unsupported",
      transport: CLAUDE_FORK_TRANSPORT,
      reason: "Claude exact boundary fork requires a local host profile transport because the SDK writes the child session to the profile-owned session store.",
    };
  }
  if (profile.providerVersion !== CLAUDE_FORK_SDK_CLI_VERSION) {
    return {
      ...base,
      status: "unsupported",
      transport: CLAUDE_FORK_TRANSPORT,
      reason: `Exact Claude boundary fork is verified only for Claude Code ${CLAUDE_FORK_SDK_CLI_VERSION} with Claude Agent SDK ${CLAUDE_FORK_SDK_VERSION}; this profile reports ${profile.providerVersion || "no version"}.`,
    };
  }
  const sdk = resolveClaudeForkSdk();
  if (sdk.status !== "available") {
    return {
      ...base,
      status: "unsupported",
      transport: CLAUDE_FORK_TRANSPORT,
      reason: sdk.reason,
    };
  }
  return {
    ...base,
    transport: CLAUDE_FORK_TRANSPORT,
    reason: `Claude Code ${CLAUDE_FORK_SDK_CLI_VERSION} is paired with pinned Claude Agent SDK ${CLAUDE_FORK_SDK_VERSION}; its profile-bound forkSession operation copies through an exact completed assistant UUID without invoking inference.`,
  };
}

function nativeForkError(message: string): Error {
  const error = new Error(message);
  error.name = "ClaudeNativeForkError";
  return error;
}

function isClaudeUuid(value: string): boolean {
  return CLAUDE_UUID_PATTERN.test(value);
}

function sdkTranscriptEvents(records: ClaudeParsedRecord[]): ClaudeParsedRecord[] {
  return records.filter((entry) => (
    Boolean(entry.uuid)
    && CLAUDE_SESSION_EVENT_TYPES.has(stringValue(entry.record.type) ?? "")
    && entry.record.isSidechain !== true
  ));
}

function verifyForkSelector(input: ClaudeNativeForkRequest, boundary: string): void {
  if (!input.selector) return;
  if (stringValue(input.selector.kind) !== "claude_chain") {
    throw nativeForkError("Claude native fork requires a claude_chain source selector.");
  }
  const selectorSessionId = stringValue(input.selector.sessionId);
  if (selectorSessionId && selectorSessionId !== input.session.sessionId) {
    throw nativeForkError("Claude native fork selector does not match the source session.");
  }
  const selectorBoundary = selectorValue(input.selector, ["throughInclusiveUuid", "through", "executionRef"]);
  if (selectorBoundary && selectorBoundary !== boundary) {
    throw nativeForkError("Claude native fork boundary does not match the persisted Run selector.");
  }
  const selectorStatus = stringValue(input.selector.boundaryStatus);
  if (selectorStatus && ["missing", "unknown", "partial", "terminal_only"].includes(selectorStatus)) {
    throw nativeForkError(`Claude native fork cannot use a ${selectorStatus} Run boundary.`);
  }
}

function verifyForkSource(
  input: ClaudeNativeForkRequest,
  profile: ClaudeLocalProfileTransport,
  records: ClaudeParsedRecord[],
): { parentPath: string; transcriptEvents: ClaudeParsedRecord[]; boundaryIndex: number } {
  const binding = input.binding;
  if (!binding || !binding.hostId.trim() || !binding.profileId.trim() || !bindingMatches(binding, profile)) {
    throw nativeForkError("Claude native fork requires the exact host-authorized profile binding.");
  }
  if (input.runtimeType !== "claude_local") throw nativeForkError("Claude native fork received a different runtime type.");
  if (!path.isAbsolute(profile.cwd) || !path.isAbsolute(profile.configDir)) {
    throw nativeForkError("Claude native fork requires absolute host-authorized cwd and CLAUDE_CONFIG_DIR paths.");
  }
  if (profile.readFile) {
    throw nativeForkError("Claude native fork requires a local host profile transport; a redirected transcript reader cannot authorize SDK writes.");
  }

  const sessionId = input.session.sessionId.trim();
  const boundary = input.boundary.trim();
  if (!isClaudeUuid(sessionId)) throw nativeForkError("Claude Agent SDK fork requires a UUID source session ID.");
  if (!isClaudeUuid(boundary)) throw nativeForkError("Claude native fork requires a UUID assistant boundary.");
  const params = input.session.sessionParams;
  const persistedSessionId = stringValue(params.sessionId ?? params.session_id);
  if (persistedSessionId && persistedSessionId !== sessionId) {
    throw nativeForkError("Claude native fork session metadata contains a different provider session ID.");
  }
  const storedCwd = stringValue(params.cwd);
  if (storedCwd && path.resolve(storedCwd) !== path.resolve(profile.cwd)) {
    throw nativeForkError("Claude native fork source session cwd does not match the authorized profile.");
  }
  const storedConfigDir = stringValue(params.claudeConfigDir ?? params.configDir);
  if (storedConfigDir && path.resolve(storedConfigDir) !== path.resolve(profile.configDir)) {
    throw nativeForkError("Claude native fork source session config directory does not match the authorized profile.");
  }
  const storedFilePath = stringValue(params.sessionFilePath ?? params.claudeSessionFilePath);
  const parentPath = resolveClaudeSessionFilePath(profile.configDir, profile.cwd, sessionId);
  if (storedFilePath && path.resolve(storedFilePath) !== path.resolve(parentPath)) {
    throw nativeForkError("Claude native fork source session file does not match the authorized profile.");
  }
  verifyForkSelector(input, boundary);

  const transcriptEvents = sdkTranscriptEvents(records);
  const byUuid = new Map<string, ClaudeParsedRecord>();
  for (const entry of transcriptEvents) {
    const uuid = entry.uuid!;
    if (byUuid.has(uuid)) throw nativeForkError("Claude source session contains duplicate transcript UUIDs.");
    byUuid.set(uuid, entry);
    const rowSessionId = sessionIdFromRecord(entry.record);
    if (rowSessionId && rowSessionId !== sessionId) {
      throw nativeForkError("Claude source session contains a transcript record from another session.");
    }
  }
  const boundaryIndex = transcriptEvents.findIndex((entry) => entry.uuid === boundary);
  const boundaryRecord = boundaryIndex >= 0 ? transcriptEvents[boundaryIndex] : undefined;
  if (!boundaryRecord) throw nativeForkError(`Claude source session has no transcript record with boundary UUID ${boundary}.`);
  if (!isCompletedAssistantRecord(boundaryRecord.record)) {
    throw nativeForkError("Claude native fork boundary is not a completed assistant end_turn record.");
  }

  const sourceBoundaryRecordIndex = records.findIndex((entry) => entry.uuid === boundary);
  const postBoundaryReplacement = records.slice(sourceBoundaryRecordIndex + 1).find((entry) => (
    stringValue(entry.record.type) === "content-replacement"
    && stringValue(entry.record.sessionId) === sessionId
  ));
  if (postBoundaryReplacement) {
    throw nativeForkError("Claude native fork cannot include a content-replacement record after the selected assistant boundary.");
  }

  let current: ClaudeParsedRecord | undefined = boundaryRecord;
  const visited = new Set<string>();
  while (current) {
    const uuid = current.uuid;
    if (!uuid || visited.has(uuid)) throw nativeForkError("Claude native fork boundary ancestry is cyclic or ambiguous.");
    visited.add(uuid);
    if (!current.parentUuid) break;
    current = byUuid.get(current.parentUuid);
    if (!current) throw nativeForkError("Claude native fork boundary ancestry is incomplete.");
  }
  return { parentPath, transcriptEvents, boundaryIndex };
}

async function runClaudeSdkFork(
  profile: ClaudeLocalProfileTransport,
  sdkEntry: string,
  input: Pick<ClaudeNativeForkRequest, "session" | "boundary">,
  parentBytes: Buffer,
): Promise<{ sessionId: string; transcript: Buffer }> {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-fork-home-"));
  const temporaryConfigDir = path.join(temporaryHome, "claude-profile");
  const temporarySessionPath = resolveClaudeSessionFilePath(temporaryConfigDir, profile.cwd, input.session.sessionId);
  const temporarySessionDirectory = path.dirname(temporarySessionPath);

  let result: { sessionId: string; transcript: Buffer } | null = null;
  let operationError: unknown;
  try {
    await fs.mkdir(temporarySessionDirectory, { recursive: true });
    await fs.writeFile(temporarySessionPath, parentBytes, { flag: "wx" });

    const child = spawn(process.execPath, ["--input-type=module", "--eval", CLAUDE_FORK_WORKER_SOURCE], {
      cwd: path.resolve(profile.cwd),
      env: {
        HOME: temporaryHome,
        USERPROFILE: temporaryHome,
        TMPDIR: temporaryHome,
        CLAUDE_CONFIG_DIR: temporaryConfigDir,
        RUDDER_CLAUDE_AGENT_SDK_ENTRY: sdkEntry,
        PATH: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify({
        sessionId: input.session.sessionId,
        cwd: path.resolve(profile.cwd),
        boundary: input.boundary,
      }));
    });

    if (output.code !== 0) {
      throw nativeForkError(`Claude Agent SDK forkSession failed${output.stderr ? `: ${output.stderr.trim()}` : ` (exit ${output.code ?? "signal"})`}.`);
    }
    const marker = "RUDDER_CLAUDE_FORK_RESULT:";
    const markerIndex = output.stdout.lastIndexOf(marker);
    if (markerIndex < 0) throw nativeForkError("Claude Agent SDK forkSession returned no child session identity.");
    let sdkResult: unknown;
    try {
      sdkResult = JSON.parse(output.stdout.slice(markerIndex + marker.length).trim());
    } catch {
      throw nativeForkError("Claude Agent SDK forkSession returned malformed child session data.");
    }
    const childSessionId = stringValue(recordValue(sdkResult)?.sessionId);
    if (!childSessionId || !isClaudeUuid(childSessionId)) {
      throw nativeForkError("Claude Agent SDK forkSession returned an invalid child session ID.");
    }
    if (childSessionId === input.session.sessionId) {
      throw nativeForkError("Claude Agent SDK returned the parent session as its fork.");
    }
    const temporaryChildPath = resolveClaudeSessionFilePath(temporaryConfigDir, profile.cwd, childSessionId);
    result = { sessionId: childSessionId, transcript: await fs.readFile(temporaryChildPath) };
  } catch (error) {
    operationError = error;
  }

  try {
    await fs.rm(temporaryHome, { recursive: true, force: true });
  } catch (cleanupError) {
    const operationMessage = operationError instanceof Error ? operationError.message : String(operationError ?? "none");
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    let stagedChildPaths: string[] = [];
    try {
      const entries = await fs.readdir(temporarySessionDirectory, { withFileTypes: true });
      stagedChildPaths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== path.basename(temporarySessionPath))
        .map((entry) => path.join(temporarySessionDirectory, entry.name));
    } catch {
      // The staging directory path remains actionable if it cannot be inspected.
    }
    const childDetail = stagedChildPaths.length > 0
      ? ` Candidate child file(s): ${stagedChildPaths.join(", ")}.`
      : result?.sessionId
        ? ` The staged child session ID is ${result.sessionId}.`
        : " The SDK may have written a child before returning its identity.";
    throw nativeForkError(`Claude Agent SDK fork staging cleanup failed at ${temporaryHome}.${childDetail} Inspect or reconcile files under ${temporarySessionDirectory}. Fork error: ${operationMessage}. Cleanup error: ${cleanupMessage}.`);
  }

  if (operationError) throw operationError;
  if (!result) throw nativeForkError("Claude Agent SDK fork produced no staged child transcript.");
  return result;
}

function expectedForkRecords(
  transcriptEvents: ClaudeParsedRecord[],
  boundaryIndex: number,
): ClaudeParsedRecord[] {
  return transcriptEvents
    .slice(0, boundaryIndex + 1)
    .filter((entry) => stringValue(entry.record.type) !== "progress");
}

async function verifyClaudeForkChild(input: {
  profile: ClaudeLocalProfileTransport;
  parentSessionId: string;
  childSessionId: string;
  boundary: string;
  parentRecords: ClaudeParsedRecord[];
  expectedRecords: ClaudeParsedRecord[];
}): Promise<{ childBoundary: string; identityMap: Record<string, string> }> {
  const childPath = resolveClaudeSessionFilePath(input.profile.configDir, input.profile.cwd, input.childSessionId);
  const childRaw = await fs.readFile(childPath, "utf8");
  const parsedChild = parseClaudeSessionJsonl(childRaw);
  if (parsedChild.malformed) throw nativeForkError("Claude Agent SDK created a malformed child session transcript.");

  const childEvents = sdkTranscriptEvents(parsedChild.records);
  const childBySource = new Map<string, ClaudeParsedRecord>();
  for (const childEvent of childEvents) {
    const forkedFrom = recordValue(childEvent.record.forkedFrom);
    if (stringValue(forkedFrom?.sessionId) !== input.parentSessionId) {
      throw nativeForkError("Claude Agent SDK child transcript contains an event without the expected parent session identity.");
    }
    const sourceUuid = stringValue(forkedFrom?.messageUuid);
    if (!sourceUuid || childBySource.has(sourceUuid)) {
      throw nativeForkError("Claude Agent SDK child transcript has missing or duplicate source message identities.");
    }
    childBySource.set(sourceUuid, childEvent);
  }

  if (childEvents.length !== input.expectedRecords.length || childBySource.size !== input.expectedRecords.length) {
    throw nativeForkError("Claude Agent SDK child transcript does not contain exactly the source prefix through the requested boundary.");
  }
  const expectedIds = new Set(input.expectedRecords.map((entry) => entry.uuid!));
  const actualSourceOrder = childEvents.map((entry) => stringValue(recordValue(entry.record.forkedFrom)?.messageUuid));
  if (actualSourceOrder.some((sourceUuid, index) => sourceUuid !== input.expectedRecords[index]?.uuid)) {
    throw nativeForkError("Claude Agent SDK child transcript does not preserve the source message order through the boundary.");
  }
  const identityMap: Record<string, string> = {};
  const childIds = new Set<string>();
  const parentByUuid = new Map(input.parentRecords.flatMap((entry) => entry.uuid ? [[entry.uuid, entry] as const] : []));
  for (const source of input.expectedRecords) {
    const sourceUuid = source.uuid!;
    const childEvent = childBySource.get(sourceUuid);
    if (!childEvent || stringValue(childEvent.record.type) !== stringValue(source.record.type)) {
      throw nativeForkError(`Claude Agent SDK child transcript is missing source event ${sourceUuid}.`);
    }
    const childUuid = childEvent.uuid;
    if (!childUuid || !isClaudeUuid(childUuid) || childUuid === sourceUuid || childIds.has(childUuid)) {
      throw nativeForkError("Claude Agent SDK did not remap every copied message UUID to a distinct child identity.");
    }
    const childSessionId = sessionIdFromRecord(childEvent.record);
    if (childSessionId && childSessionId !== input.childSessionId) {
      throw nativeForkError("Claude Agent SDK child event contains a mismatched session ID.");
    }
    const sourceParentUuid = source.parentUuid;
    let expectedChildParent: string | null = null;
    let parent = sourceParentUuid ? parentByUuid.get(sourceParentUuid) : undefined;
    while (parent) {
      if (stringValue(parent.record.type) !== "progress") {
        expectedChildParent = identityMap[parent.uuid!] ?? null;
        break;
      }
      parent = parent.parentUuid ? parentByUuid.get(parent.parentUuid) : undefined;
    }
    if ((childEvent.parentUuid ?? null) !== expectedChildParent) {
      throw nativeForkError(`Claude Agent SDK child event ${childUuid} does not preserve the remapped parent chain.`);
    }
    identityMap[sourceUuid] = childUuid;
    childIds.add(childUuid);
  }
  if (Object.keys(identityMap).length !== expectedIds.size) {
    throw nativeForkError("Claude Agent SDK child identity map is incomplete.");
  }
  const childBoundary = identityMap[input.boundary];
  if (!childBoundary) throw nativeForkError("Claude Agent SDK did not include the selected assistant boundary in its child session.");
  return { childBoundary, identityMap };
}

async function forkClaudeNativeSession(
  input: ClaudeNativeForkRequest,
  profile: ClaudeLocalProfileTransport,
): Promise<ClaudeNativeForkResult> {
  const evidence = claudeForkEvidence(profile);
  if (evidence.status !== "supported") throw nativeForkError(evidence.reason);
  if (input.signal?.aborted) throw nativeForkError("Claude native fork was aborted before source validation.");
  if (!input.binding || !bindingMatches(input.binding, profile)) {
    throw nativeForkError("Claude native fork requires the exact host-authorized profile binding.");
  }
  const sdk = resolveClaudeForkSdk();
  if (sdk.status !== "available") throw nativeForkError(sdk.reason);

  let canonicalCwd: string;
  try {
    canonicalCwd = await fs.realpath(profile.cwd);
  } catch {
    throw nativeForkError("Claude native fork profile cwd is not available on the authorized host.");
  }
  const storedCwd = stringValue(input.session.sessionParams.cwd);
  if (storedCwd) {
    let canonicalStoredCwd: string;
    try {
      canonicalStoredCwd = await fs.realpath(storedCwd);
    } catch {
      throw nativeForkError("Claude native fork source session cwd is not available on the authorized host.");
    }
    if (canonicalStoredCwd !== canonicalCwd) {
      throw nativeForkError("Claude native fork source session cwd does not match the authorized profile.");
    }
  }
  const sdkProfile = { ...profile, cwd: canonicalCwd };
  const sdkInput: ClaudeNativeForkRequest = {
    ...input,
    session: {
      ...input.session,
      sessionParams: { ...input.session.sessionParams, cwd: canonicalCwd },
    },
  };

  const loaded = await loadProfileSessionRecords(sdkProfile, {
    runtimeType: sdkInput.runtimeType,
    binding: sdkInput.binding,
    session: sdkInput.session,
    selector: null,
  });
  if (loaded.status !== "available") throw nativeForkError(`Claude source session is not available in its authorized profile (${loaded.revision}).`);
  if (loaded.malformed) throw nativeForkError("Claude source session JSONL is malformed or incomplete.");
  const source = verifyForkSource(sdkInput, sdkProfile, loaded.records);
  const parentBytes = await fs.readFile(source.parentPath);
  if (stableHash(parentBytes.toString("utf8")) !== loaded.revision) {
    throw nativeForkError("Claude source session changed during boundary validation; retry from a fresh Run snapshot.");
  }
  const expectedRecords = expectedForkRecords(source.transcriptEvents, source.boundaryIndex);
  const sdkFork = await runClaudeSdkFork(sdkProfile, sdk.entry, sdkInput, parentBytes);
  const childSessionId = sdkFork.sessionId;
  let childPath: string | null = null;
  let childCreated = false;
  try {
    childPath = resolveClaudeSessionFilePath(sdkProfile.configDir, sdkProfile.cwd, childSessionId);
    if (input.signal?.aborted) throw nativeForkError("Claude native fork was canceled while the provider operation completed.");
    const parentAfterFork = await fs.readFile(source.parentPath);
    if (!parentBytes.equals(parentAfterFork)) {
      throw nativeForkError("Claude source session changed while the native fork was being created.");
    }
    const childFile = await fs.open(childPath, "wx");
    childCreated = true;
    try {
      await childFile.writeFile(sdkFork.transcript);
    } finally {
      await childFile.close();
    }
    const child = await verifyClaudeForkChild({
      profile: sdkProfile,
      parentSessionId: sdkInput.session.sessionId,
      childSessionId,
      boundary: sdkInput.boundary,
      parentRecords: source.transcriptEvents,
      expectedRecords,
    });
    return {
      session: {
        sessionId: childSessionId,
        sessionDisplayId: childSessionId,
        sessionParams: {
          sessionId: childSessionId,
          cwd: canonicalCwd,
          claudeConfigDir: path.resolve(profile.configDir),
          sessionFilePath: childPath,
          transport: CLAUDE_FORK_TRANSPORT,
          profileHostId: profile.binding.hostId,
          profileId: profile.binding.profileId,
          ...(profile.binding.id ? { profileBindingId: profile.binding.id } : {}),
          ...(profile.binding.orgId ? { profileOrgId: profile.binding.orgId } : {}),
          ...(profile.binding.workspaceBindingId ? { workspaceBindingId: profile.binding.workspaceBindingId } : {}),
          ...(profile.binding.capabilityRevision ? { capabilityRevision: profile.binding.capabilityRevision } : {}),
          ...(stringValue(input.session.sessionParams.workspaceId) ? { workspaceId: stringValue(input.session.sessionParams.workspaceId)! } : {}),
          ...(stringValue(input.session.sessionParams.repoUrl) ? { repoUrl: stringValue(input.session.sessionParams.repoUrl)! } : {}),
          ...(stringValue(input.session.sessionParams.repoRef) ? { repoRef: stringValue(input.session.sessionParams.repoRef)! } : {}),
          forkedFromSessionId: input.session.sessionId,
          lastUuid: child.childBoundary,
          lastAssistantUuid: child.childBoundary,
        },
      },
      boundary: child.childBoundary,
      sourceBoundary: input.boundary,
      identityMap: child.identityMap,
      continuity: "native",
    };
  } catch (error) {
    if (childCreated && childPath) {
      try {
        await fs.rm(childPath, { force: true });
      } catch (cleanupError) {
        const operationMessage = error instanceof Error ? error.message : String(error);
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw nativeForkError(`Claude native fork failed and child session cleanup also failed at ${childPath}; reconcile that exact session file. Fork error: ${operationMessage}. Cleanup error: ${cleanupMessage}.`);
      }
    }
    throw error;
  }
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

function controlEvidence(
  profile: ClaudeLocalProfileTransport,
  capability: "steer" | "interrupt",
): ClaudeCapabilityEvidence {
  const evidence = profileEvidence(profile);
  if (evidence.status !== "supported") {
    return {
      ...evidence,
      reason: `${evidence.reason} Claude ${capability} remains unclassified until the verified profile transport is available.`,
    };
  }
  if (capability === "steer") {
    const versionAudited = profile.providerVersion === CLAUDE_NATIVE_VERSION;
    return {
      ...evidence,
      status: versionAudited ? "unsupported" : "unknown",
      reason: versionAudited
        ? `Claude Code ${profile.providerVersion} accepts stream-json user messages, but this CLI adapter sends no native input priority and only confirms replay; it cannot prove the message affected the active turn. Finish the active Run, then send the message through normal chat input.`
        : `Claude Code ${profile.providerVersion} has not been audited for active-turn steer through this CLI adapter.`,
      transport: "claude-cli-stream-json",
    };
  }
  return {
    ...evidence,
    status: "supported",
    reason: `Claude Agent SDK ${CLAUDE_FORK_SDK_VERSION} exposes Query.interrupt() for a live streaming Query, but this adapter owns the CLI child process instead; Stop is process-level through a live execute handle, not a native provider interrupt.`,
    transport: "claude-cli-process",
  };
}

const CLAUDE_STEER_FALLBACK_REASON = "Claude's CLI control handle cannot verify current-turn steer. Finish the active Run, then send the message through normal chat input.";

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
  reason: `Claude exact assistant-boundary fork requires host authorization and the pinned Claude Agent SDK ${CLAUDE_FORK_SDK_VERSION} paired with Claude Code ${CLAUDE_FORK_SDK_CLI_VERSION}.`,
  transport: CLAUDE_FORK_TRANSPORT,
  profileBound: false,
  profileRequired: true,
};

const staticSteerEvidence: ClaudeCapabilityEvidence = {
  status: "unknown",
  reason: "Claude native Steer requires a bound live query; the CLI adapter does not treat a stream-json replay acknowledgement as proof of active-turn application.",
  transport: "claude-cli-stream-json",
  profileBound: false,
  profileRequired: true,
};

const staticInterruptEvidence: ClaudeCapabilityEvidence = {
  status: "unknown",
  reason: "Claude Stop requires a live execute handle; this CLI adapter uses process lifecycle interruption, not the SDK Query.interrupt() control channel.",
  transport: "claude-cli-process",
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
    steer: { evidence: staticSteerEvidence },
    interrupt: { evidence: staticInterruptEvidence },
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

async function unsupportedSteer(_input: ProviderControlRequest): Promise<AgentRuntimeControlSteerResult> {
  return { disposition: "unsupported", reason: CLAUDE_STEER_FALLBACK_REASON };
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
  fork: {
    evidence: ClaudeCapabilityEvidence;
    fork: (input: ClaudeNativeForkRequest) => Promise<ClaudeNativeForkResult>;
  };
  control: {
    steer: {
      evidence: ClaudeCapabilityEvidence;
      mode?: "native";
      requiresHandle?: true;
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
    fork: {
      evidence: claudeForkEvidence(profile),
      fork: (input) => forkClaudeNativeSession(input, profile),
    },
    control: {
      steer: {
        evidence: controlEvidence(profile, "steer"),
        execute: unsupportedSteer,
      },
      interrupt: {
        evidence: controlEvidence(profile, "interrupt"),
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
    fork: {
      evidence: { ...staticForkEvidence, reason },
      fork: async () => { throw nativeForkError(reason); },
    },
    control: {
      steer: {
        evidence: { ...staticSteerEvidence, reason },
        execute: unsupportedSteer,
      },
      interrupt: {
        evidence: { ...staticInterruptEvidence, reason },
        mode: "process",
        requiresHandle: true,
        execute: delegateInterrupt,
      },
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
