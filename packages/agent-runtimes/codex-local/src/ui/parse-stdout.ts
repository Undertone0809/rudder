import { type TranscriptEntry, type TranscriptTodoItemStatus } from "@rudderhq/agent-runtime-utils";
import { isCodexClosedStdinToolSessionError } from "../shared/tool-errors.js";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function toolResultContent(item: Record<string, unknown>, fallback: string): string {
  return (
    firstString(item.content, item.output, item.result, item.aggregated_output) ||
    stringifyUnknown(item.content ?? item.output ?? item.result) ||
    fallback
  );
}

function isToolError(item: Record<string, unknown>): boolean {
  const status = asString(item.status).toLowerCase();
  return (
    item.is_error === true ||
    item.error === true ||
    status === "error" ||
    status === "failed" ||
    status === "errored"
  );
}

function isImageViewErrorStatus(status: string): boolean {
  return ["failed", "error", "errored", "cancelled", "canceled", "denied", "rejected"]
    .includes(status.trim().toLowerCase());
}

function normalizeTodoStatus(item: Record<string, unknown>): TranscriptTodoItemStatus {
  const rawStatus = asString(item.status) || asString(item.state);
  const normalizedStatus = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalizedStatus === "completed" || normalizedStatus === "complete" || normalizedStatus === "done") {
    return "completed";
  }
  if (normalizedStatus === "in_progress" || normalizedStatus === "running" || normalizedStatus === "active" || normalizedStatus === "current") {
    return "in_progress";
  }
  if (item.completed === true) return "completed";
  if (item.in_progress === true || item.current === true || item.active === true) return "in_progress";
  return "pending";
}

function parseTodoListItem(item: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const rawItems = Array.isArray(item.items) ? item.items : [];
  const items = rawItems
    .map((rawItem) => asRecord(rawItem))
    .filter((todoItem): todoItem is Record<string, unknown> => Boolean(todoItem))
    .map((todoItem) => {
      const text = asString(todoItem.text) || asString(todoItem.title) || asString(todoItem.content) || asString(todoItem.task);
      if (!text.trim()) return null;
      return {
        text,
        status: normalizeTodoStatus(todoItem),
      };
    })
    .filter((todoItem): todoItem is { text: string; status: TranscriptTodoItemStatus } => Boolean(todoItem));

  if (items.length === 0) return [];

  const id = asString(item.id);
  return [{
    kind: "todo_list",
    ts,
    todoListId: id || undefined,
    items,
  }];
}

function parseCodexItemUpdated(item: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const itemType = asString(item.type);

  if (itemType === "userMessage" || itemType === "user_message") {
    return [];
  }

  if (itemType === "todo_list") {
    return parseTodoListItem(item, ts);
  }

  const id = asString(item.id);
  const status = asString(item.status);
  const meta = [id ? `id=${id}` : "", status ? `status=${status}` : ""].filter(Boolean).join(" ");
  return [{
    kind: "system",
    ts,
    text: `item updated: ${itemType || "unknown"}${meta ? ` (${meta})` : ""}`,
  }];
}

function parseCommandExecutionItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id);
  const command = asString(item.command);
  const status = asString(item.status);
  const exitCode = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) ? item.exit_code : null;
  const safeCommand = command;
  const output = asString(item.aggregated_output).replace(/\s+$/, "");

  if (phase === "started") {
    const cwd = asString(item.cwd);
    return [{
      kind: "tool_call",
      ts,
      name: "command_execution",
      toolUseId: id || command || "command_execution",
      input: {
        id,
        command: safeCommand,
        ...(cwd ? { cwd } : {}),
      },
    }];
  }

  const lines: string[] = [];
  if (safeCommand) lines.push(`command: ${safeCommand}`);
  if (status) lines.push(`status: ${status}`);
  if (exitCode !== null) lines.push(`exit_code: ${exitCode}`);
  if (output) {
    if (lines.length > 0) lines.push("");
    lines.push(output);
  }

  const isError =
    (exitCode !== null && exitCode !== 0) ||
    status === "failed" ||
    status === "errored" ||
    status === "error" ||
    status === "cancelled";
  if (isError && isCodexClosedStdinToolSessionError(output)) return [];

  return [{
    kind: "tool_result",
    ts,
    toolUseId: id || command || "command_execution",
    content: lines.join("\n").trim() || "command completed",
    isError,
  }];
}

const FILE_CHANGE_FILE_LIMIT = 100;
const FILE_CHANGE_EVIDENCE_BYTE_LIMIT = 256 * 1024;
const FILE_CHANGE_HEADER_BYTE_LIMIT = 4 * 1024;

interface FileChangeEvidenceChange {
  path: string;
  kind: string | {
    type: string;
    move_path?: string | null;
  };
  diff?: string;
  diff_truncated?: true;
  diff_original_bytes?: number;
}

interface FileChangeEvidenceTruncation {
  truncated: true;
  original_file_count: number;
  retained_file_count: number;
  omitted_file_count: number;
  max_files: number;
  max_bytes: number;
  file_count_limited: boolean;
  byte_limited: boolean;
  truncated_diff_count: number;
  metadata_truncated: boolean;
  message: string;
}

interface FileChangeEvidence {
  id: string;
  status: string;
  changes: FileChangeEvidenceChange[];
  truncation?: FileChangeEvidenceTruncation;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
  }
  return bytes;
}

function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;

  let usedBytes = 0;
  let endIndex = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const charBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    endIndex += char.length;
  }
  return value.slice(0, endIndex);
}

function normalizeFileChangeKind(value: unknown): FileChangeEvidenceChange["kind"] {
  if (typeof value === "string") return value || "update";
  const record = asRecord(value);
  if (!record) return "update";

  const type = firstString(record.type, record.kind) || "update";
  const hasMovePath =
    Object.prototype.hasOwnProperty.call(record, "move_path")
    || Object.prototype.hasOwnProperty.call(record, "movePath");
  const rawMovePath = Object.prototype.hasOwnProperty.call(record, "move_path")
    ? record.move_path
    : record.movePath;
  return {
    type,
    ...(hasMovePath && (typeof rawMovePath === "string" || rawMovePath === null)
      ? { move_path: rawMovePath }
      : {}),
  };
}

function normalizeFileChange(
  value: unknown,
): FileChangeEvidenceChange | null {
  const record = asRecord(value);
  if (!record) return null;

  const change: FileChangeEvidenceChange = {
    path: asString(record.path),
    kind: normalizeFileChangeKind(record.kind),
  };
  if (typeof record.diff === "string") {
    const originalBytes = utf8ByteLength(record.diff);
    const boundedDiff = truncateUtf8(record.diff, FILE_CHANGE_EVIDENCE_BYTE_LIMIT);
    change.diff = boundedDiff;
    if (boundedDiff !== record.diff) {
      change.diff_truncated = true;
      change.diff_original_bytes = originalBytes;
    }
  }
  return change;
}

function createFileChangeTruncation(
  originalFileCount: number,
  retainedFileCount: number,
  options: {
    fileCountLimited: boolean;
    byteLimited: boolean;
    truncatedDiffCount: number;
    metadataTruncated: boolean;
  },
): FileChangeEvidenceTruncation {
  return {
    truncated: true,
    original_file_count: originalFileCount,
    retained_file_count: retainedFileCount,
    omitted_file_count: Math.max(0, originalFileCount - retainedFileCount),
    max_files: FILE_CHANGE_FILE_LIMIT,
    max_bytes: FILE_CHANGE_EVIDENCE_BYTE_LIMIT,
    file_count_limited: options.fileCountLimited,
    byte_limited: options.byteLimited,
    truncated_diff_count: options.truncatedDiffCount,
    metadata_truncated: options.metadataTruncated,
    message:
      "File-change evidence was truncated to at most 100 files and 262144 bytes. "
      + "Raw provider logs may contain omitted paths or diff content.",
  };
}

function fitFileChangeWithTruncatedDiff(
  baseEvidence: Omit<FileChangeEvidence, "changes" | "truncation">,
  retainedChanges: FileChangeEvidenceChange[],
  change: FileChangeEvidenceChange,
  originalFileCount: number,
  fileCountLimited: boolean,
  metadataTruncated: boolean,
  existingTruncatedDiffCount: number,
): FileChangeEvidenceChange | null {
  if (typeof change.diff !== "string") return null;

  const originalDiffBytes = change.diff_original_bytes ?? utf8ByteLength(change.diff);
  const withoutDiff: FileChangeEvidenceChange = {
    path: change.path,
    kind: change.kind,
    diff_truncated: true,
    diff_original_bytes: originalDiffBytes,
  };
  const changesWithoutDiff = [...retainedChanges, withoutDiff];
  const evidenceWithoutDiff: FileChangeEvidence = {
    ...baseEvidence,
    changes: changesWithoutDiff,
    truncation: createFileChangeTruncation(originalFileCount, changesWithoutDiff.length, {
      fileCountLimited,
      byteLimited: true,
      truncatedDiffCount: existingTruncatedDiffCount + 1,
      metadataTruncated,
    }),
  };
  if (jsonByteLength(evidenceWithoutDiff) > FILE_CHANGE_EVIDENCE_BYTE_LIMIT) {
    return null;
  }

  const diffCharacters = Array.from(change.diff);
  if (diffCharacters.length === 0) return withoutDiff;
  const firstCharacterCandidate: FileChangeEvidenceChange = {
    ...withoutDiff,
    diff: diffCharacters[0],
  };
  const evidenceWithFirstCharacter: FileChangeEvidence = {
    ...baseEvidence,
    changes: [...retainedChanges, firstCharacterCandidate],
    truncation: evidenceWithoutDiff.truncation,
  };
  if (jsonByteLength(evidenceWithFirstCharacter) > FILE_CHANGE_EVIDENCE_BYTE_LIMIT) {
    return withoutDiff;
  }

  let low = 0;
  let high = diffCharacters.length;
  let best: FileChangeEvidenceChange = firstCharacterCandidate;

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate: FileChangeEvidenceChange = {
      path: change.path,
      kind: change.kind,
      ...(midpoint > 0 ? { diff: diffCharacters.slice(0, midpoint).join("") } : {}),
      diff_truncated: true,
      diff_original_bytes: originalDiffBytes,
    };
    const changes = [...retainedChanges, candidate];
    const evidence: FileChangeEvidence = {
      ...baseEvidence,
      changes,
      truncation: createFileChangeTruncation(originalFileCount, changes.length, {
        fileCountLimited,
        byteLimited: true,
        truncatedDiffCount: existingTruncatedDiffCount + 1,
        metadataTruncated,
      }),
    };
    if (jsonByteLength(evidence) <= FILE_CHANGE_EVIDENCE_BYTE_LIMIT) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function createFileChangeEvidence(
  item: Record<string, unknown>,
  phase: "started" | "completed",
): FileChangeEvidence {
  const rawId = asString(item.id);
  const rawStatus = asString(item.status, phase === "started" ? "in_progress" : "completed");
  const id = truncateUtf8(rawId, FILE_CHANGE_HEADER_BYTE_LIMIT);
  const status = truncateUtf8(rawStatus, FILE_CHANGE_HEADER_BYTE_LIMIT);
  const metadataTruncated = id !== rawId || status !== rawStatus;
  const baseEvidence = { id, status };
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  const normalizedChanges = rawChanges
    .map(normalizeFileChange)
    .filter((change): change is FileChangeEvidenceChange => Boolean(change));
  const invalidChangeCount = rawChanges.length - normalizedChanges.length;
  const fileCountLimited = normalizedChanges.length > FILE_CHANGE_FILE_LIMIT;
  const candidateChanges = normalizedChanges.slice(0, FILE_CHANGE_FILE_LIMIT);
  const completeEvidence: FileChangeEvidence = {
    ...baseEvidence,
    changes: candidateChanges,
  };

  if (
    !fileCountLimited
    && invalidChangeCount === 0
    && !metadataTruncated
    && jsonByteLength(completeEvidence) <= FILE_CHANGE_EVIDENCE_BYTE_LIMIT
  ) {
    return completeEvidence;
  }

  const retainedChanges: FileChangeEvidenceChange[] = [];
  let byteLimited = metadataTruncated;
  let truncatedDiffCount = 0;

  for (const change of candidateChanges) {
    const changes = [...retainedChanges, change];
    const nextTruncatedDiffCount = truncatedDiffCount + (change.diff_truncated ? 1 : 0);
    const provisionalEvidence: FileChangeEvidence = {
      ...baseEvidence,
      changes,
      truncation: createFileChangeTruncation(rawChanges.length, changes.length, {
        fileCountLimited,
        byteLimited: true,
        truncatedDiffCount: nextTruncatedDiffCount,
        metadataTruncated,
      }),
    };
    if (jsonByteLength(provisionalEvidence) <= FILE_CHANGE_EVIDENCE_BYTE_LIMIT) {
      retainedChanges.push(change);
      truncatedDiffCount = nextTruncatedDiffCount;
      continue;
    }

    byteLimited = true;
    const fittedChange = fitFileChangeWithTruncatedDiff(
      baseEvidence,
      retainedChanges,
      change,
      rawChanges.length,
      fileCountLimited,
      metadataTruncated,
      truncatedDiffCount,
    );
    if (fittedChange) {
      retainedChanges.push(fittedChange);
      truncatedDiffCount += 1;
    }
  }

  const evidence: FileChangeEvidence = {
    ...baseEvidence,
    changes: retainedChanges,
    truncation: createFileChangeTruncation(rawChanges.length, retainedChanges.length, {
      fileCountLimited,
      byteLimited: byteLimited || retainedChanges.length < candidateChanges.length,
      truncatedDiffCount,
      metadataTruncated,
    }),
  };

  while (evidence.changes.length > 0 && jsonByteLength(evidence) > FILE_CHANGE_EVIDENCE_BYTE_LIMIT) {
    evidence.changes.pop();
    evidence.truncation = createFileChangeTruncation(rawChanges.length, evidence.changes.length, {
      fileCountLimited,
      byteLimited: true,
      truncatedDiffCount: evidence.changes.filter((change) => change.diff_truncated).length,
      metadataTruncated,
    });
  }

  return evidence;
}

function isArtifactErrorStatus(status: string): boolean {
  return ["error", "errored", "failed", "cancelled", "canceled", "denied", "rejected"]
    .includes(status.trim().toLowerCase());
}

function fileChangeToolUseId(
  item: Record<string, unknown>,
  evidence: FileChangeEvidence,
): string {
  return asString(item.id)
    || (evidence.changes[0]?.path ? `file_change:${evidence.changes[0].path}` : "file_change");
}

function parseFileChangeItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const evidence = createFileChangeEvidence(item, phase);
  const toolUseId = fileChangeToolUseId(item, evidence);
  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "file_change",
      toolUseId,
      input: evidence,
    }];
  }

  return [{
    kind: "tool_result",
    ts,
    toolUseId,
    toolName: "file_change",
    content: JSON.stringify(evidence),
    isError: isToolError(item) || isArtifactErrorStatus(evidence.status),
  }];
}

function parseImageViewItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const path = asString(item.path);
  const status = asString(item.status, phase === "started" ? "in_progress" : "completed");
  const id = asString(item.id);
  const toolUseId = id || (path ? `image_view:${path}` : "image_view");
  const evidence = { id, status, path };

  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "image_view",
      toolUseId,
      input: evidence,
    }];
  }

  return [{
    kind: "tool_result",
    ts,
    toolUseId,
    toolName: "image_view",
    content: JSON.stringify(evidence),
    isError: isToolError(item) || isImageViewErrorStatus(status),
  }];
}

function parseWebSearchItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id) || "web_search";
  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "web_search",
      toolUseId: id,
      input: {
        id,
        action: item.action ?? item,
      },
    }];
  }

  const content = toolResultContent(item, "web search completed");
  const isError = isToolError(item);
  if (isError && isCodexClosedStdinToolSessionError(content)) return [];
  return [{ kind: "tool_result", ts, toolUseId: id, toolName: "web_search", content, isError }];
}

function parseMcpToolCallItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id) || asString(item.call_id) || "mcp_tool_call";
  const invocation = asRecord(item.invocation) ?? asRecord(item.request) ?? item;
  const server = firstString(
    invocation.server,
    invocation.serverName,
    invocation.server_name,
    invocation.serverLabel,
    invocation.server_label,
    item.server,
    item.serverName,
    item.server_name,
  );
  const tool = firstString(
    invocation.tool,
    invocation.toolName,
    invocation.tool_name,
    invocation.name,
    item.tool,
    item.toolName,
    item.tool_name,
    item.name,
  );
  const safeServer = server.replace(/[^A-Za-z0-9_-]+/g, "_");
  const safeTool = tool.replace(/[^A-Za-z0-9_-]+/g, "_");
  const name = safeServer && safeTool ? `mcp__${safeServer}__${safeTool}` : "mcp_tool_call";

  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name,
      toolUseId: id,
      input: {
        id,
        server,
        tool,
        invocation,
        args:
          invocation.arguments ??
          invocation.args ??
          invocation.params ??
          item.arguments ??
          item.args ??
          item.params,
      },
    }];
  }

  const content = toolResultContent(item, "mcp tool completed");
  const isError = isToolError(item);
  if (isError && isCodexClosedStdinToolSessionError(content)) return [];
  return [{ kind: "tool_result", ts, toolUseId: id, toolName: name, content, isError }];
}

function normalizeCollabAgentToolName(tool: string): string {
  switch (tool) {
    case "spawnAgent":
      return "spawn_agent";
    case "sendInput":
      return "send_input";
    case "resumeAgent":
      return "resume_agent";
    case "wait":
      return "wait_agent";
    case "closeAgent":
      return "close_agent";
    default:
      return tool || "collab_agent_tool_call";
  }
}

function parseCollabAgentTranscriptItems(items: unknown[], fallbackTs: string): TranscriptEntry[] {
  return items.flatMap((rawItem) => {
    const item = asRecord(rawItem);
    if (!item) return [];
    const ts = firstString(item.completedAt, item.startedAt, item.createdAt, item.updatedAt) || fallbackTs;
    const type = asString(item.type);
    if (
      type === "command_execution"
      || type === "web_search"
      || type === "mcp_tool_call"
      || type === "collab_agent_tool_call"
      || type === "collab_tool_call"
      || type === "subAgentActivity"
      || type === "sub_agent_activity"
      || type === "file_change"
      || type === "fileChange"
      || type === "image_view"
      || type === "imageView"
    ) {
      return [
        ...parseCodexItem(item, ts, "started"),
        ...parseCodexItem(item, ts, "completed"),
      ];
    }
    return parseCodexItem(item, ts, "completed");
  });
}

function parseCollabAgentTranscripts(item: Record<string, unknown>, ts: string) {
  const transcripts = asRecord(item.agentTranscripts) ?? asRecord(item.agent_transcripts);
  if (!transcripts) return null;

  const parsed = Object.fromEntries(
    Object.entries(transcripts).flatMap(([threadId, rawSnapshot]) => {
      const snapshot = asRecord(rawSnapshot);
      if (!snapshot) return [];
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      return [[threadId, {
        status: asString(snapshot.status, "unknown"),
        entries: parseCollabAgentTranscriptItems(items, ts),
      }]];
    }),
  );
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function subAgentActivityThreadId(item: Record<string, unknown>): string {
  return firstString(item.agentThreadId, item.agent_thread_id);
}

function parseSubAgentActivityItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  if (phase === "started") return [];

  const id = asString(item.id) || "sub_agent_activity";
  const threadId = subAgentActivityThreadId(item);
  const agentPath = firstString(item.agentPath, item.agent_path);
  const activityKind = asString(item.kind, "updated");
  const agentTranscripts = parseCollabAgentTranscripts(item, ts);
  const receiverThreadIds = threadId ? [threadId] : [];
  const input = {
    id,
    activity_kind: activityKind,
    ...(agentPath ? { agent_path: agentPath } : {}),
    receiver_thread_ids: receiverThreadIds,
    ...(agentTranscripts ? { agent_transcripts: agentTranscripts } : {}),
  };
  const status = activityKind === "interrupted" ? "failed" : "completed";

  return [
    {
      kind: "tool_call",
      ts,
      name: "subagent_activity",
      toolUseId: id,
      input,
    },
    {
      kind: "tool_result",
      ts,
      toolUseId: id,
      toolName: "subagent_activity",
      content: JSON.stringify({
        status,
        activity_kind: activityKind,
        ...(agentPath ? { agent_path: agentPath } : {}),
        receiver_thread_ids: receiverThreadIds,
        ...(agentTranscripts ? { agent_transcripts: agentTranscripts } : {}),
      }),
      isError: activityKind === "interrupted",
    },
  ];
}

function parseCollabAgentToolCallItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const id = asString(item.id) || "collab_agent_tool_call";
  const name = normalizeCollabAgentToolName(asString(item.tool));
  const rawReceiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds
    : Array.isArray(item.receiver_thread_ids)
      ? item.receiver_thread_ids
      : [];
  const receiverThreadIds = rawReceiverThreadIds.length > 0
    ? rawReceiverThreadIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const agentsStates = asRecord(item.agentsStates) ?? asRecord(item.agents_states) ?? {};
  const reasoningEffort = firstString(item.reasoningEffort, item.reasoning_effort);
  const senderThreadId = firstString(item.senderThreadId, item.sender_thread_id);

  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name,
      toolUseId: id,
      input: {
        id,
        ...(asString(item.prompt) ? { message: asString(item.prompt) } : {}),
        ...(asString(item.model) ? { model: asString(item.model) } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(senderThreadId ? { sender_thread_id: senderThreadId } : {}),
        receiver_thread_ids: receiverThreadIds,
        agents_states: agentsStates,
      },
    }];
  }

  const status = asString(item.status, "completed");
  const agentTranscripts = parseCollabAgentTranscripts(item, ts);
  return [{
    kind: "tool_result",
    ts,
    toolUseId: id,
    toolName: name,
    content: JSON.stringify({
      status,
      ...(asString(item.prompt) ? { message: asString(item.prompt) } : {}),
      ...(asString(item.model) ? { model: asString(item.model) } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(senderThreadId ? { sender_thread_id: senderThreadId } : {}),
      receiver_thread_ids: receiverThreadIds,
      agents_states: agentsStates,
      ...(agentTranscripts ? { agent_transcripts: agentTranscripts } : {}),
    }),
    isError: status === "failed" || isToolError(item),
  }];
}

function parseCodexItem(
  item: Record<string, unknown>,
  ts: string,
  phase: "started" | "completed",
): TranscriptEntry[] {
  const itemType = asString(item.type);

  if (itemType === "userMessage" || itemType === "user_message") {
    return [];
  }

  if (itemType === "todo_list") {
    return parseTodoListItem(item, ts);
  }

  if (itemType === "agent_message") {
    const text = asString(item.text);
    const messagePhase = item.phase === "commentary" || item.phase === "final_answer"
      ? item.phase
      : null;
    if (text) {
      return [{
        kind: "assistant",
        ts,
        text,
        ...(item.delta === true ? { delta: true } : {}),
        ...(messagePhase ? { phase: messagePhase } : {}),
        ...(asString(item.id) ? { segmentId: asString(item.id) } : {}),
      }];
    }
    return [];
  }

  if (itemType === "reasoning") {
    const text = asString(item.text);
    if (text) {
      return [{
        kind: "thinking",
        ts,
        text,
        ...(item.delta === true ? { delta: true } : {}),
        ...(asString(item.id) ? { segmentId: asString(item.id) } : {}),
      }];
    }
    return [{ kind: "system", ts, text: phase === "started" ? "reasoning started" : "reasoning completed" }];
  }

  if (itemType === "command_execution") {
    return parseCommandExecutionItem(item, ts, phase);
  }

  if (itemType === "web_search") {
    return parseWebSearchItem(item, ts, phase);
  }

  if (itemType === "mcp_tool_call" || itemType === "mcp_tool_call_begin" || itemType === "mcp_tool_call_end") {
    return parseMcpToolCallItem(item, ts, phase);
  }

  if (
    itemType === "collab_agent_tool_call"
    || itemType === "collabAgentToolCall"
    || itemType === "collab_tool_call"
    || itemType === "collabToolCall"
  ) {
    return parseCollabAgentToolCallItem(item, ts, phase);
  }

  if (itemType === "sub_agent_activity" || itemType === "subAgentActivity") {
    return parseSubAgentActivityItem(item, ts, phase);
  }

  if (itemType === "file_change" || itemType === "fileChange") {
    return parseFileChangeItem(item, ts, phase);
  }

  if (itemType === "imageView" || itemType === "image_view") {
    return parseImageViewItem(item, ts, phase);
  }

  if (itemType === "tool_use") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(item.name, "unknown"),
      toolUseId: asString(item.id),
      input: item.input ?? {},
    }];
  }

  if (itemType === "tool_result" && phase === "completed") {
    const toolUseId = asString(item.tool_use_id, asString(item.id));
    const content =
      asString(item.content) ||
      asString(item.output) ||
      asString(item.result) ||
      stringifyUnknown(item.content ?? item.output ?? item.result);
    const isError = item.is_error === true || asString(item.status) === "error";
    if (isError && isCodexClosedStdinToolSessionError(content)) return [];
    return [{ kind: "tool_result", ts, toolUseId, content, isError }];
  }

  if (itemType === "error" && phase === "completed") {
    const text = errorText(item.message ?? item.error ?? item);
    if (isCodexClosedStdinToolSessionError(text)) return [];
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  const id = asString(item.id);
  const status = asString(item.status);
  const meta = [id ? `id=${id}` : "", status ? `status=${status}` : ""].filter(Boolean).join(" ");
  return [{
    kind: "system",
    ts,
    text: `item ${phase}: ${itemType || "unknown"}${meta ? ` (${meta})` : ""}`,
  }];
}

export function parseCodexStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "thread.started") {
    const threadId = asString(parsed.thread_id);
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "codex"),
      sessionId: threadId,
    }];
  }

  if (type === "turn.started") {
    return [{ kind: "system", ts, text: "turn started" }];
  }

  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(parsed.item);
    if (!item) return [{ kind: "system", ts, text: type.replace(".", " ") }];
    return parseCodexItem(item, ts, type === "item.started" ? "started" : "completed");
  }

  if (type === "item.updated") {
    const item = asRecord(parsed.item);
    if (!item) return [{ kind: "system", ts, text: "item updated" }];
    return parseCodexItemUpdated(item, ts);
  }

  if (type === "turn.completed") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const cachedTokens = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd),
      subtype: asString(parsed.subtype),
      isError: parsed.is_error === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map(errorText).filter(Boolean)
        : [],
    }];
  }

  if (type === "turn.failed") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const cachedTokens = asNumber(usage?.cached_input_tokens, asNumber(usage?.cache_read_input_tokens));
    const message = errorText(parsed.error ?? parsed.message);
    if (isCodexClosedStdinToolSessionError(message)) return [];
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd),
      subtype: asString(parsed.subtype, "turn.failed"),
      isError: true,
      errors: message ? [message] : [],
    }];
  }

  if (type === "error") {
    const message = errorText(parsed.message ?? parsed.error ?? parsed);
    if (isCodexClosedStdinToolSessionError(message)) return [];
    return [{ kind: "stderr", ts, text: message || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
