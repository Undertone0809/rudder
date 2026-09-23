import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const HERMES_PRODUCT_HISTORY_HELPER_VERSION = "rudder-hermes-product-history-v1";
export const HERMES_PRODUCT_HISTORY_TRANSPORT = "hermes-session-db-read-only";
const HERMES_RUNTIME_TYPE = "hermes_gateway";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_DIAGNOSTIC = 2_000;
const CLOSE_GRACE_MS = 750;

type JsonRecord = Record<string, unknown>;

export type HermesProductHistoryProfile = {
  /** Host-resolved absolute interpreter path; never taken from session parameters. */
  pythonCommand: string;
  /** Host-authorized Hermes source root containing hermes_state.py. */
  sourcePath: string;
  /** Host-authorized Hermes home whose state.db is the only database read. */
  hermesHome: string;
  providerVersion?: string | null;
  hostId?: string | null;
  profileId?: string | null;
};

export type HermesProductHistoryRange = {
  startExclusive?: number | null;
  endInclusive?: number | null;
};

export type HermesProductHistoryRequest = {
  runtimeType: string;
  sessionId: string;
  profile: HermesProductHistoryProfile;
  range?: HermesProductHistoryRange | null;
  cursor?: string | null;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type HermesProductHistoryRawRow = JsonRecord;

export type HermesProductHistoryTypedEntry = {
  rowId: number;
  sessionId: string;
  role: string;
  content: unknown;
  toolCallId: string | null;
  toolCalls: readonly unknown[];
  toolName: string | null;
  effectDisposition: string | null;
  timestamp: unknown;
  tokenCount: number | null;
  finishReason: string | null;
  reasoning: unknown;
  reasoningContent: unknown;
  reasoningDetails: unknown;
  codexReasoningItems: unknown;
  codexMessageItems: unknown;
  platformMessageId: string | null;
  observed: boolean | null;
  compressedSummary: boolean | null;
  active: boolean | null;
  compacted: boolean | null;
  apiContent: string | null;
  displayKind: string | null;
  displayMetadata: unknown;
};

export type HermesProductHistoryItem = {
  id: string;
  sourceEntryId: string;
  rowId: number;
  sessionId: string;
  ordinal: number;
  kind: string;
  ts: string;
  payload: JsonRecord;
  raw: HermesProductHistoryRawRow;
  entry: HermesProductHistoryTypedEntry;
  origin: "native";
  visibility: "visible";
  text?: string;
};

export type HermesProductHistorySessionMetadata = {
  id: string;
  source: string | null;
  parentSessionId: string | null;
  profileName: string | null;
  cwd: string | null;
  startedAt: unknown;
  endedAt: unknown;
  endReason: string | null;
  messageCount: number | null;
  toolCallCount: number | null;
};

export type HermesProductHistoryLineage = {
  requestedSessionId: string;
  readSessionId: string;
  compressionTipSessionId: string | null;
  resolvedResumeSessionId: string | null;
  successorSessionId: string | null;
  relation: "none" | "compression" | "unknown";
  rebound: false;
};

export type HermesProductHistoryResult = {
  items: readonly HermesProductHistoryItem[];
  nextCursor: string | null;
  source: "native";
  transport: typeof HERMES_PRODUCT_HISTORY_TRANSPORT;
  revision: string;
  availability: "available" | "offline" | "missing" | "incompatible";
  completeness: "complete" | "partial" | "unknown";
  range: { startExclusive: number | null; endInclusive: number | null };
  metadata: {
    helperVersion: typeof HERMES_PRODUCT_HISTORY_HELPER_VERSION;
    tailRowId: number | null;
    session: HermesProductHistorySessionMetadata | null;
    successor: HermesProductHistorySessionMetadata | null;
    lineage: HermesProductHistoryLineage;
  };
};

export type HermesProductHistoryErrorCode =
  | "invalid_profile"
  | "invalid_range"
  | "invalid_cursor"
  | "cursor_scope_mismatch"
  | "scope_violation"
  | "helper_failed"
  | "aborted";

export class HermesProductHistoryError extends Error {
  override readonly name = "HermesProductHistoryError";

  constructor(readonly code: HermesProductHistoryErrorCode, message: string) {
    super(message);
  }
}

type NormalizedRange = { startExclusive: number | null; endInclusive: number | null };
type CursorPayload = {
  version: 1;
  runtimeType: typeof HERMES_RUNTIME_TYPE;
  sessionId: string;
  profileScope: string;
  range: NormalizedRange;
  afterRowId: number;
};

type HelperResponse = {
  ok: boolean;
  error?: { code?: string; message?: string };
  helperVersion?: string;
  sessionId?: string;
  rows?: JsonRecord[];
  tailRowId?: number | null;
  session?: JsonRecord | null;
  compressionTipSessionId?: string | null;
  resolvedResumeSessionId?: string | null;
  successorSession?: JsonRecord | null;
};

const PYTHON_HELPER_SOURCE = String.raw`
import json
import os
import sys
from pathlib import Path

HELPER_VERSION = "${HERMES_PRODUCT_HISTORY_HELPER_VERSION}"

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str) + "\n")
    sys.stdout.flush()

def main():
    request = json.loads(sys.stdin.read() or "{}")
    if request.get("helperVersion") != HELPER_VERSION:
        emit({"ok": False, "error": {"code": "helper_version_mismatch", "message": "Hermes history helper version mismatch."}})
        return
    if request.get("runtimeType") != "hermes_gateway":
        emit({"ok": False, "error": {"code": "runtime_mismatch", "message": "Hermes history helper received a different runtime type."}})
        return
    session_id = str(request.get("sessionId") or "").strip()
    if not session_id:
        emit({"ok": False, "error": {"code": "session_missing", "message": "Hermes history session ID is missing."}})
        return
    after_id = request.get("afterId")
    if after_id is not None:
        after_id = int(after_id)
    limit = int(request.get("limit") or 1)
    source_path = os.environ.get("RUDDER_HERMES_SOURCE", "")
    if source_path:
        sys.path.insert(0, source_path)
    from hermes_state import SessionDB

    home = Path(os.environ["HERMES_HOME"]).expanduser()
    db = SessionDB(db_path=home / "state.db", read_only=True)
    try:
        session = db.get_session(session_id)
        if session is None:
            emit({"ok": True, "helperVersion": HELPER_VERSION, "sessionId": session_id, "session": None, "rows": [], "tailRowId": None, "compressionTipSessionId": None, "resolvedResumeSessionId": None, "successorSession": None})
            return

        # The official API forbids after_id with include_compacted.  The raw
        # audit read intentionally uses include_inactive and leaves compaction
        # generations un-deduped so pre-compression rows remain addressable.
        rows = db.get_messages(
            session_id,
            include_inactive=True,
            include_compacted=False,
            limit=limit,
            after_id=after_id,
        )
        tail_rows = db.get_messages(
            session_id,
            include_inactive=True,
            include_compacted=False,
            latest=True,
            limit=1,
        )
        tail_row_id = tail_rows[0].get("id") if tail_rows else None
        tip_id = db.get_compression_tip(session_id)
        resume_id = db.resolve_resume_session_id(session_id)
        successor = db.get_session(tip_id) if tip_id and tip_id != session_id else None
        emit({
            "ok": True,
            "helperVersion": HELPER_VERSION,
            "sessionId": session_id,
            "rows": rows,
            "tailRowId": tail_row_id,
            "session": session,
            "compressionTipSessionId": tip_id,
            "resolvedResumeSessionId": resume_id,
            "successorSession": successor,
        })
    finally:
        db.close()

try:
    main()
except Exception as exc:
    emit({"ok": False, "error": {"code": "helper_failed", "message": str(exc)[:2000]}})
`;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > MAX_DIAGNOSTIC ? `${compact.slice(0, MAX_DIAGNOSTIC)}... [truncated]` : compact;
}

function requireAbsolute(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!text || !path.isAbsolute(text)) {
    throw new HermesProductHistoryError("invalid_profile", `${label} must be an absolute host-owned path.`);
  }
  return path.resolve(text);
}

function validateProfile(profile: HermesProductHistoryProfile): HermesProductHistoryProfile {
  return {
    ...profile,
    pythonCommand: requireAbsolute(profile.pythonCommand, "Hermes history Python interpreter"),
    sourcePath: requireAbsolute(profile.sourcePath, "Hermes history source path"),
    hermesHome: requireAbsolute(profile.hermesHome, "Hermes history HERMES_HOME"),
  };
}

function normalizeRange(value: HermesProductHistoryRange | null | undefined): NormalizedRange {
  const startExclusive = value?.startExclusive ?? null;
  const endInclusive = value?.endInclusive ?? null;
  for (const [label, boundary] of [["startExclusive", startExclusive], ["endInclusive", endInclusive]] as const) {
    if (boundary !== null && (!Number.isSafeInteger(boundary) || boundary < 0)) {
      throw new HermesProductHistoryError("invalid_range", `${label} must be a non-negative safe integer.`);
    }
  }
  if (startExclusive !== null && endInclusive !== null && endInclusive < startExclusive) {
    throw new HermesProductHistoryError("invalid_range", "endInclusive must not precede startExclusive.");
  }
  return { startExclusive, endInclusive };
}

function normalizedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new HermesProductHistoryError("invalid_range", `History page limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}

function profileScope(profile: HermesProductHistoryProfile): string {
  return createHash("sha256").update(JSON.stringify([
    path.resolve(profile.pythonCommand),
    path.resolve(profile.sourcePath),
    path.resolve(profile.hermesHome),
    profile.providerVersion ?? null,
    profile.hostId ?? null,
    profile.profileId ?? null,
  ])).digest("hex");
}

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (
      parsed?.version !== 1
      || parsed.runtimeType !== HERMES_RUNTIME_TYPE
      || typeof parsed.sessionId !== "string"
      || typeof parsed.profileScope !== "string"
      || typeof parsed.afterRowId !== "number"
    ) throw new Error("invalid cursor shape");
    const range = asRecord(parsed.range);
    if (!range || (range.startExclusive !== null && typeof range.startExclusive !== "number")
      || (range.endInclusive !== null && typeof range.endInclusive !== "number")) {
      throw new Error("invalid cursor range");
    }
    return {
      version: 1,
      runtimeType: HERMES_RUNTIME_TYPE,
      sessionId: parsed.sessionId,
      profileScope: parsed.profileScope,
      range: {
        startExclusive: range.startExclusive as number | null,
        endInclusive: range.endInclusive as number | null,
      },
      afterRowId: parsed.afterRowId,
    };
  } catch (error) {
    throw new HermesProductHistoryError("invalid_cursor", `Invalid Hermes history cursor: ${boundedDiagnostic(error)}.`);
  }
}

function cursorFor(input: HermesProductHistoryRequest, profile: HermesProductHistoryProfile, range: NormalizedRange): number | null {
  if (!input.cursor) return range.startExclusive;
  const cursor = decodeCursor(input.cursor);
  if (cursor.sessionId !== input.sessionId || cursor.profileScope !== profileScope(profile)) {
    throw new HermesProductHistoryError("cursor_scope_mismatch", "Hermes history cursor belongs to another session or host profile.");
  }
  if (cursor.range.startExclusive !== range.startExclusive || cursor.range.endInclusive !== range.endInclusive) {
    throw new HermesProductHistoryError("cursor_scope_mismatch", "Hermes history cursor belongs to another row range.");
  }
  if (!Number.isSafeInteger(cursor.afterRowId) || cursor.afterRowId < 0) {
    throw new HermesProductHistoryError("invalid_cursor", "Hermes history cursor has an invalid row boundary.");
  }
  return cursor.afterRowId;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new HermesProductHistoryError("invalid_range", `History timeout must be between 1 and ${MAX_TIMEOUT_MS}ms.`);
  }
  return timeout;
}

function stableRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorResult(
  availability: HermesProductHistoryResult["availability"],
  range: NormalizedRange,
  lineage: HermesProductHistoryLineage,
  message: string,
): HermesProductHistoryResult {
  return {
    items: [],
    nextCursor: null,
    source: "native",
    transport: HERMES_PRODUCT_HISTORY_TRANSPORT,
    revision: `${availability}:${stableRevision(message)}`,
    availability,
    completeness: "unknown",
    range,
    metadata: {
      helperVersion: HERMES_PRODUCT_HISTORY_HELPER_VERSION,
      tailRowId: null,
      session: null,
      successor: null,
      lineage,
    },
  };
}

function projectSession(value: unknown): HermesProductHistorySessionMetadata | null {
  const row = asRecord(value);
  const id = stringValue(row?.id);
  if (!id) return null;
  return {
    id,
    source: stringValue(row?.source),
    parentSessionId: stringValue(row?.parent_session_id),
    profileName: stringValue(row?.profile_name),
    cwd: stringValue(row?.cwd),
    startedAt: row?.started_at ?? null,
    endedAt: row?.ended_at ?? null,
    endReason: stringValue(row?.end_reason),
    messageCount: typeof row?.message_count === "number" ? row.message_count : null,
    toolCallCount: typeof row?.tool_call_count === "number" ? row.tool_call_count : null,
  };
}

function requireRowId(row: JsonRecord): number {
  const rowId = row.id;
  if (typeof rowId !== "number" || !Number.isSafeInteger(rowId) || rowId < 0) {
    throw new HermesProductHistoryError("scope_violation", "Hermes history helper returned a row without a safe numeric ID.");
  }
  return rowId;
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    const text = value.map(textFrom).filter((entry): entry is string => Boolean(entry)).join("\n");
    return text || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["text", "content", "output", "message", "summary"]) {
    const text = textFrom(record[key]);
    if (text) return text;
  }
  return undefined;
}

function typedEntry(row: JsonRecord, rowId: number, sessionId: string): HermesProductHistoryTypedEntry {
  return {
    rowId,
    sessionId,
    role: stringValue(row.role) ?? "unknown",
    content: row.content ?? null,
    toolCallId: stringValue(row.tool_call_id),
    toolCalls: Array.isArray(row.tool_calls) ? row.tool_calls : [],
    toolName: stringValue(row.tool_name),
    effectDisposition: stringValue(row.effect_disposition),
    timestamp: row.timestamp ?? null,
    tokenCount: typeof row.token_count === "number" ? row.token_count : null,
    finishReason: stringValue(row.finish_reason),
    reasoning: row.reasoning ?? null,
    reasoningContent: row.reasoning_content ?? null,
    reasoningDetails: row.reasoning_details ?? null,
    codexReasoningItems: row.codex_reasoning_items ?? null,
    codexMessageItems: row.codex_message_items ?? null,
    platformMessageId: stringValue(row.platform_message_id),
    observed: typeof row.observed === "number" ? row.observed !== 0 : null,
    compressedSummary: typeof row._compressed_summary === "boolean" ? row._compressed_summary : null,
    active: typeof row.active === "number" ? row.active !== 0 : null,
    compacted: typeof row.compacted === "number" ? row.compacted !== 0 : null,
    apiContent: stringValue(row.api_content),
    displayKind: stringValue(row.display_kind),
    displayMetadata: row.display_metadata ?? null,
  };
}

function itemFromRow(row: JsonRecord, sessionId: string): HermesProductHistoryItem {
  const rowId = requireRowId(row);
  const rowSessionId = stringValue(row.session_id);
  if (rowSessionId !== sessionId) {
    throw new HermesProductHistoryError("scope_violation", "Hermes history helper returned a row from another session.");
  }
  const entry = typedEntry(row, rowId, sessionId);
  const text = textFrom(row.content);
  return {
    id: `hermes:db:${sessionId}:${rowId}`,
    sourceEntryId: String(rowId),
    rowId,
    sessionId,
    ordinal: rowId,
    kind: `hermes:db:${entry.role}`,
    ts: row.timestamp === null || row.timestamp === undefined ? "" : String(row.timestamp),
    payload: {
      provider: "hermes_gateway",
      transport: HERMES_PRODUCT_HISTORY_TRANSPORT,
      sessionId,
      rowId,
      row,
    },
    raw: row,
    entry,
    origin: "native",
    visibility: "visible",
    ...(text ? { text } : {}),
  };
}

function validateHelperResponse(value: unknown): HelperResponse {
  const response = asRecord(value);
  if (!response || typeof response.ok !== "boolean") {
    throw new HermesProductHistoryError("helper_failed", "Hermes history helper returned an invalid response.");
  }
  return response as HelperResponse;
}

async function runHelper(
  profile: HermesProductHistoryProfile,
  request: { sessionId: string; afterId: number | null; limit: number },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HelperResponse> {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      ["PATH", "HOME", "USER", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    HERMES_HOME: profile.hermesHome,
    RUDDER_HERMES_SOURCE: profile.sourcePath,
    PYTHONPATH: profile.sourcePath,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  return await new Promise<HelperResponse>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(profile.pythonCommand, ["-c", PYTHON_HELPER_SOURCE], {
        cwd: profile.sourcePath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new HermesProductHistoryError("helper_failed", `Hermes history helper could not start: ${boundedDiagnostic(error)}.`));
      return;
    }
    const stdoutDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const terminate = (error: HermesProductHistoryError) => {
      if (settled) return;
      child.kill("SIGTERM");
      finish(() => reject(error));
      killTimer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
    };
    function abort() {
      terminate(new HermesProductHistoryError("aborted", "Hermes history read was cancelled."));
    }
    const timeoutTimer = setTimeout(() => terminate(new HermesProductHistoryError("helper_failed", "Hermes history helper timed out.")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new HermesProductHistoryError("helper_failed", "Hermes history helper exceeded the bounded output limit."));
        return;
      }
      stdout += stdoutDecoder.write(buffer);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      finish(() => reject(new HermesProductHistoryError("helper_failed", `Hermes history helper failed: ${boundedDiagnostic(error)}.`)));
    });
    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (settled) return;
      stdout += stdoutDecoder.end();
      const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      if (code !== 0 || lines.length === 0) {
        finish(() => reject(new HermesProductHistoryError(
          "helper_failed",
          `Hermes history helper exited with code ${String(code)}${stderr ? `: ${boundedDiagnostic(stderr)}` : "."}`,
        )));
        return;
      }
      try {
        finish(() => resolve(validateHelperResponse(JSON.parse(lines.at(-1)!))));
      } catch (error) {
        finish(() => reject(error instanceof HermesProductHistoryError
          ? error
          : new HermesProductHistoryError("helper_failed", `Hermes history helper returned invalid JSON: ${boundedDiagnostic(error)}.`)));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(JSON.stringify({
      helperVersion: HERMES_PRODUCT_HISTORY_HELPER_VERSION,
      runtimeType: HERMES_RUNTIME_TYPE,
      sessionId: request.sessionId,
      afterId: request.afterId,
      limit: request.limit,
    }) + "\n");
  });
}

function unavailableLineage(sessionId: string): HermesProductHistoryLineage {
  return {
    requestedSessionId: sessionId,
    readSessionId: sessionId,
    compressionTipSessionId: null,
    resolvedResumeSessionId: null,
    successorSessionId: null,
    relation: "unknown",
    rebound: false,
  };
}

export async function readHermesProductHistory(input: HermesProductHistoryRequest): Promise<HermesProductHistoryResult> {
  const range = normalizeRange(input.range);
  if (input.runtimeType !== HERMES_RUNTIME_TYPE) {
    return errorResult("incompatible", range, unavailableLineage(input.sessionId), `runtime:${input.runtimeType}`);
  }
  const sessionId = stringValue(input.sessionId);
  if (!sessionId) throw new HermesProductHistoryError("invalid_range", "Hermes history session ID is missing.");
  const profile = validateProfile(input.profile);
  const limit = normalizedLimit(input.limit);
  const timeoutMs = normalizedTimeout(input.timeoutMs);
  const afterId = cursorFor({ ...input, sessionId }, profile, range);
  const response = await runHelper(profile, { sessionId, afterId, limit: limit + 1 }, timeoutMs, input.signal);
  if (response.helperVersion !== HERMES_PRODUCT_HISTORY_HELPER_VERSION) {
    throw new HermesProductHistoryError("helper_failed", "Hermes history helper version is not supported.");
  }
  if (!response.ok) {
    const code = response.error?.code ?? "helper_failed";
    if (code === "session_missing") {
      return errorResult("missing", range, unavailableLineage(sessionId), response.error?.message ?? code);
    }
    return errorResult("offline", range, unavailableLineage(sessionId), response.error?.message ?? code);
  }
  if (response.sessionId !== sessionId) {
    throw new HermesProductHistoryError("scope_violation", "Hermes history helper returned another session identity.");
  }
  if (response.rows !== undefined && !Array.isArray(response.rows)) {
    throw new HermesProductHistoryError("scope_violation", "Hermes history helper returned a non-array row set.");
  }
  const rows = (response.rows ?? []).map((row) => {
    const record = asRecord(row);
    if (!record) throw new HermesProductHistoryError("scope_violation", "Hermes history helper returned a non-object row.");
    const rowSessionId = stringValue(record.session_id);
    if (rowSessionId !== sessionId) {
      throw new HermesProductHistoryError("scope_violation", "Hermes history helper returned a row from another session.");
    }
    return record;
  });
  const selectedRows = rows.filter((row) => {
    const rowId = requireRowId(row);
    return (range.startExclusive === null || rowId > range.startExclusive)
      && (range.endInclusive === null || rowId <= range.endInclusive);
  });
  const hasMore = selectedRows.length > limit;
  const pageRows = selectedRows.slice(0, limit);
  const items = pageRows.map((row) => itemFromRow(row, sessionId));
  const tailRowId = typeof response.tailRowId === "number" && Number.isSafeInteger(response.tailRowId)
    ? response.tailRowId
    : null;
  const tipId = stringValue(response.compressionTipSessionId);
  const resolvedId = stringValue(response.resolvedResumeSessionId);
  const successorSession = projectSession(response.successorSession);
  const successorSessionId = tipId && tipId !== sessionId ? tipId : null;
  const lineage: HermesProductHistoryLineage = {
    requestedSessionId: sessionId,
    readSessionId: sessionId,
    compressionTipSessionId: tipId,
    resolvedResumeSessionId: resolvedId,
    successorSessionId,
    relation: successorSessionId ? "compression" : "none",
    rebound: false,
  };
  const nextCursor = hasMore && pageRows.length > 0
    ? encodeCursor({
        version: 1,
        runtimeType: HERMES_RUNTIME_TYPE,
        sessionId,
        profileScope: profileScope(profile),
        range,
        afterRowId: pageRows.at(-1)!.id as number,
      })
    : null;
  const session = projectSession(response.session);
  return {
    items,
    nextCursor,
    source: "native",
    transport: HERMES_PRODUCT_HISTORY_TRANSPORT,
    revision: stableRevision({
      helperVersion: HERMES_PRODUCT_HISTORY_HELPER_VERSION,
      sessionId,
      tailRowId,
      session,
      tipId,
      resolvedId,
    }),
    availability: "available",
    completeness: "complete",
    range,
    metadata: {
      helperVersion: HERMES_PRODUCT_HISTORY_HELPER_VERSION,
      tailRowId,
      session,
      successor: successorSession,
      lineage,
    },
  };
}
