import {
  chatAskUserRequestSchema,
  type AgentRuntimeApprovalDecision,
  type AgentRuntimeApprovalRequest,
  type AgentRuntimeControlAttemptLease,
  type AgentRuntimeControlHandleLease,
  type AgentRuntimeExecutionResult,
  type AgentRuntimeTransientInputKind,
  type AgentRuntimeTransientInputRequest,
  type AgentRuntimeTransientInputResult,
} from "@rudderhq/agent-runtime-utils";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HermesAcpBinding, HermesAcpForkResult, HermesAcpProfile, HermesAcpWorkspace } from "./native-protocol.js";
import { createHermesNativeRpcClient, hermesNativeRpcErrorCode } from "./native-protocol.js";
import {
  readHermesProductHistory,
  type HermesProductHistoryProfile,
  type HermesProductHistoryResult,
} from "./product-history.js";

/* Sensitive values use only the Host's one-shot transient input callback. */
export const HERMES_PRODUCT_RPC_TRANSPORT = "hermes-tui-gateway-stdio";
export const HERMES_PRODUCT_RPC_VERIFIED_VERSIONS = ["0.21.0"] as const;
export const HERMES_PRODUCT_RPC_FORK_HELPER_VERSION = "rudder-hermes-product-fork-v1";

const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENT_TOTAL_BYTES = 512 * 1024;
const GATEWAY_READY_TIMEOUT_MS = 10_000;
const STOP_RECONCILIATION_MS = 1_500;
const HISTORY_FENCE_MAX_HOLD_MS = 2_000;
const APPROVAL_OPTION_VALUES = new Set(["once", "session", "always", "deny"]);

type JsonRecord = Record<string, unknown>;
type HermesProductRpcHistoryTail = {
  availability: HermesProductHistoryResult["availability"];
  tailRowId: number | null;
  relation: HermesProductHistoryResult["metadata"]["lineage"]["relation"];
  successorSessionId: string | null;
};
type HermesProductRpcHistoryFence = {
  tailRowId: number | null;
  isHeld(): boolean;
  release(): Promise<void>;
};
type HermesProductRpcLeaseIdentity = {
  profile: HermesProductRpcProfile;
  sessionId: string;
  gatewaySessionId: string;
  gatewayPid: number;
  timeoutMs: number;
  signal?: AbortSignal;
};
type HermesProductRpcTranscriptBoundary = {
  status: "exact" | "unknown";
  sessionId: string;
  startExclusive: number | null;
  endInclusive: number | null;
  sourceRangeRef: string | null;
  reason?: string;
};
export type HermesProductRpcProfile = HermesAcpProfile & {
  hermesPythonCommand: string;
  hermesSourcePath: string;
  hermesHome: string;
};
type HermesProductRpcEvent = { type: string; payload: JsonRecord; sessionId: string | null };
export type HermesProductRpcClient = {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
};
export type HermesProductRpcClientFactory = (input: {
  profile: HermesAcpProfile;
  onNotification: (method: string, params: JsonRecord) => void;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}) => Promise<HermesProductRpcClient>;

const FORK_HELPER_TIMEOUT_MS = 30_000;
const FORK_HELPER_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FORK_HELPER_KILL_GRACE_MS = 5_000;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value: unknown, secrets: readonly string[], limit = MAX_EVENT_BYTES): string {
  let output = text(value);
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(/((?:["']?[A-Za-z0-9_-]*(?:api[-_]?key|authorization|bearer|credential|password|private[-_]?key|secret|token|value)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:bearer\s+)?)(?:"[^"]*"|'[^']*'|[^\s,;}'"]+)/gi, "$1[REDACTED]");
  return output.slice(0, limit);
}

function safeValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return safeText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => safeValue(entry, secrets, depth + 1));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).slice(0, 100).map(([key, child]) => [
    key,
    /(?:api.?key|authorization|bearer|credential|password|private.?key|secret|token|value)/i.test(key)
      ? "[REDACTED]"
      : safeValue(child, secrets, depth + 1),
  ]));
}

function safeEventPayload(value: unknown, secrets: readonly string[]): JsonRecord {
  const payload = record(value) ?? {};
  const safe = record(safeValue(payload, secrets)) ?? {};
  const usage = record(payload.usage);
  if (!usage) return safe;
  safe.usage = Object.fromEntries(Object.entries(usage).slice(0, 100).map(([key, child]) => {
    const countField = /^(?:inputTokens|input_tokens|input|outputTokens|output_tokens|output|cachedInputTokens|cached_input_tokens|cached_read_tokens)$/iu.test(key);
    const validCount = (typeof child === "number" && Number.isSafeInteger(child) && child >= 0)
      || (typeof child === "string" && /^\d+$/u.test(child));
    return [key, countField && validCount ? child : safeValue(child, secrets)];
  }));
  return safe;
}

function identityFields(binding: HermesAcpBinding): JsonRecord {
  return {
    profileHostId: binding.hostId,
    profileId: binding.profileId,
    ...(binding.id ? { profileBindingId: binding.id } : {}),
    ...(binding.orgId ? { profileOrgId: binding.orgId } : {}),
    ...(binding.workspaceBindingId ? { workspaceBindingId: binding.workspaceBindingId } : {}),
    ...(binding.capabilityRevision ? { capabilityRevision: binding.capabilityRevision } : {}),
  };
}

export function isHermesProductRpcProfile(value: Partial<HermesProductRpcProfile>): value is HermesProductRpcProfile {
  return Boolean(
    text(value.hermesPythonCommand)
    && text(value.hermesSourcePath)
    && text(value.hermesHome)
    && text(value.binding?.hostId)
    && text(value.binding?.profileId),
  );
}

export function hermesProductRpcProfileEvidence(profile: Partial<HermesProductRpcProfile>): {
  status: "supported" | "unknown";
  reason: string;
} {
  if (!isHermesProductRpcProfile(profile)) {
    return { status: "unknown", reason: "Hermes Product Gateway requires a host-authorized Python, source, HERMES_HOME, and host/profile binding." };
  }
  if (![profile.hermesPythonCommand, profile.hermesSourcePath, profile.hermesHome].every((value) => path.isAbsolute(value))) {
    return { status: "unknown", reason: "Hermes Product Gateway paths must be absolute host-authorized paths." };
  }
  if (!HERMES_PRODUCT_RPC_VERIFIED_VERSIONS.includes(profile.providerVersion as (typeof HERMES_PRODUCT_RPC_VERIFIED_VERSIONS)[number])) {
    return {
      status: "unknown",
      reason: `Hermes Product Gateway contracts are verified only for ${HERMES_PRODUCT_RPC_VERIFIED_VERSIONS.join(", ")}; profile version ${profile.providerVersion ?? "unknown"} is unverified.`,
    };
  }
  return {
    status: "supported",
    reason: `Hermes ${profile.providerVersion} uses the versioned host-authorized SessionDB Fork helper for exact parent-preserving history copies.`,
  };
}

export function buildHermesProductRpcSessionParams(input: {
  sessionId: string;
  profile: HermesProductRpcProfile;
  workspace?: HermesAcpWorkspace | null;
}): JsonRecord {
  return {
    sessionId: input.sessionId,
    hermesSessionId: input.sessionId,
    transport: HERMES_PRODUCT_RPC_TRANSPORT,
    hermesProviderVersion: input.profile.providerVersion ?? null,
    hermesPythonCommand: path.resolve(input.profile.hermesPythonCommand),
    hermesSourcePath: path.resolve(input.profile.hermesSourcePath),
    hermesHome: path.resolve(input.profile.hermesHome),
    cwd: path.resolve(input.profile.cwd),
    ...identityFields(input.profile.binding),
    ...(input.workspace?.workspaceId ? { workspaceId: input.workspace.workspaceId } : {}),
    ...(input.workspace?.repoUrl ? { repoUrl: input.workspace.repoUrl } : {}),
    ...(input.workspace?.repoRef ? { repoRef: input.workspace.repoRef } : {}),
    ...(input.workspace?.workspaceBindingId ? { workspaceBindingId: input.workspace.workspaceBindingId } : {}),
  };
}

export function validateHermesProductRpcSession(input: {
  sessionId: string;
  sessionParams: JsonRecord;
  profile: HermesProductRpcProfile;
  workspace?: HermesAcpWorkspace | null;
}): string | null {
  const params = input.sessionParams;
  if (text(params.transport) !== HERMES_PRODUCT_RPC_TRANSPORT) return "Hermes persisted session transport is not the Product Gateway.";
  if (text(params.hermesSessionId ?? params.sessionId) !== input.sessionId) return "Hermes Product Gateway session identity does not match the requested session.";
  const identities: Array<[string, unknown, unknown]> = [
    ["host", params.profileHostId, input.profile.binding.hostId],
    ["profile", params.profileId, input.profile.binding.profileId],
    ["profile binding", params.profileBindingId, input.profile.binding.id],
    ["organization", params.profileOrgId, input.profile.binding.orgId],
    ["workspace binding", params.workspaceBindingId, input.profile.binding.workspaceBindingId],
    ["capability revision", params.capabilityRevision, input.profile.binding.capabilityRevision],
    ["provider version", params.hermesProviderVersion, input.profile.providerVersion],
    ["Python interpreter", params.hermesPythonCommand, path.resolve(input.profile.hermesPythonCommand)],
    ["source path", params.hermesSourcePath, path.resolve(input.profile.hermesSourcePath)],
    ["HERMES_HOME", params.hermesHome, path.resolve(input.profile.hermesHome)],
    ["cwd", params.cwd, path.resolve(input.profile.cwd)],
  ];
  for (const [label, stored, expected] of identities) {
    if (expected !== null && expected !== undefined && text(stored) !== String(expected)) return `Hermes Product Gateway session ${label} does not match the authorized provider profile.`;
    if ((expected === null || expected === undefined) && text(stored)) return `Hermes Product Gateway profile is missing the persisted ${label} identity.`;
  }
  if (input.workspace) {
    for (const key of ["workspaceId", "repoUrl", "repoRef", "workspaceBindingId"] as const) {
      const expected = text(input.workspace[key]);
      const stored = text(params[key]);
      if (expected && stored !== expected) return `Hermes Product Gateway session ${key} does not match the current workspace.`;
      if (!expected && stored) return `Hermes Product Gateway current workspace is missing persisted ${key}.`;
    }
  }
  return null;
}

function rpcProfile(profile: HermesProductRpcProfile): HermesAcpProfile {
  return {
    ...profile,
    command: profile.hermesPythonCommand,
    args: ["-m", "tui_gateway.entry"],
    env: {
      ...(profile.env ?? {}),
      HERMES_HOME: path.resolve(profile.hermesHome),
      PYTHONPATH: [path.resolve(profile.hermesSourcePath), profile.env?.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  };
}

export class HermesProductRpcForkError extends Error {
  override readonly name = "HermesProductRpcForkError";

  constructor(
    readonly status: "unsupported" | "unknown",
    message: string,
    readonly details: { sessionId?: string; childSessionId?: string; rolledBack?: boolean } = {},
  ) {
    super(message);
  }
}

const PYTHON_FORK_HELPER_SOURCE = String.raw`
import json
import os
import signal
import sys
import uuid
from pathlib import Path

HELPER_VERSION = "${HERMES_PRODUCT_RPC_FORK_HELPER_VERSION}"
SUPPORTED_VERSION = "0.21.0"
BRANCH_COPY_FIELDS = (
    "reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items", "codex_message_items",
    "display_kind", "display_metadata", "timestamp",
)

class HelperFailure(Exception):
    def __init__(self, code, message, status="unknown"):
        super().__init__(message)
        self.code = code
        self.status = status

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str) + "\n")
    sys.stdout.flush()

def visible_text(content):
    text_kinds = {"text", "input_text", "output_text"}
    image_kinds = {"image_url", "input_image", "image"}
    audio_kinds = {"input_audio", "audio"}
    def image_url(value):
        url = value.get("image_url") if isinstance(value, dict) else None
        return url.get("url") if isinstance(url, dict) else url
    def part_text(part):
        if isinstance(part, list):
            return "\n".join(value for value in (part_text(item).strip() for item in part) if value)
        if isinstance(part, dict):
            kind = part.get("type")
            if kind in text_kinds:
                return str(part.get("text") or part.get("content") or "")
            if kind in image_kinds:
                return str(image_url(part) or "[image]")
            if kind in audio_kinds:
                return "[audio]"
            if kind:
                return "[" + str(kind) + "]"
            if "text" in part:
                return str(part.get("text") or "")
            return "[structured content]"
        return "" if part is None else str(part)
    if isinstance(content, list):
        chunks = []
        for part in content:
            if isinstance(part, str) or (isinstance(part, dict) and isinstance(part.get("text"), str)):
                chunks.append(part if isinstance(part, str) else part["text"])
            elif isinstance(part, dict) and part.get("type"):
                rendered = part_text(part)
                chunks.append(rendered if part["type"] in text_kinds else "\n" + rendered)
        return "".join(chunks)
    if isinstance(content, dict):
        return part_text(content)
    return "" if content is None else str(content)

def visible_branch_history(rows):
    result = []
    seen = set()
    prior = 0
    for row in rows:
        if not isinstance(row, dict):
            raise HelperFailure("malformed_history", "Hermes display history contains a non-object row.")
        row_id = row.get("_row_id")
        if isinstance(row_id, bool) or not isinstance(row_id, int) or row_id < 1 or row_id in seen or row_id <= prior:
            raise HelperFailure("malformed_history", "Hermes display history has a missing, duplicate, or unordered global _row_id.")
        seen.add(row_id)
        prior = row_id
        try:
            json.dumps(row, ensure_ascii=False, allow_nan=False, default=str)
        except Exception as exc:
            raise HelperFailure("malformed_history", "Hermes display history contains unserializable message data.") from exc
        if not isinstance(row.get("role"), str) or not row["role"].strip():
            raise HelperFailure("malformed_history", "Hermes display history contains a row without a valid role.")
        if row.get("role") not in ("user", "assistant"):
            continue
        if visible_text(row.get("content")).strip():
            result.append(row)
    return result

def session_model_config(session):
    config = session.get("model_config")
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except Exception:
            return {}
    return config if isinstance(config, dict) else {}

def session_record(db, session_id):
    session = db.get_session(session_id)
    if not isinstance(session, dict) or session.get("id") != session_id:
        raise HelperFailure("session_missing", "Hermes session was not found.", "unsupported")
    return session

def stable_session_snapshot(session):
    return json.dumps(session, ensure_ascii=False, sort_keys=True, allow_nan=False, default=str)

def display_rows(db, session_id):
    value = db.get_resume_conversations(session_id)
    if not isinstance(value, (tuple, list)) or len(value) != 2 or not isinstance(value[1], list):
        raise HelperFailure("malformed_history", "Hermes SessionDB returned an invalid resume/display projection.")
    return value[1]

def copied_message(row):
    message = {"role": row["role"], "content": row.get("content")}
    for field in BRANCH_COPY_FIELDS:
        if field in row:
            message[field] = row[field]
    return message

def main():
    request = json.loads(sys.stdin.read() or "{}")
    if request.get("helperVersion") != HELPER_VERSION:
        raise HelperFailure("helper_version_mismatch", "Hermes Fork helper version mismatch.")
    if request.get("runtimeType") != "hermes_gateway":
        raise HelperFailure("runtime_mismatch", "Hermes Fork helper received a different runtime type.", "unsupported")
    if request.get("providerVersion") != SUPPORTED_VERSION:
        raise HelperFailure("provider_version_unverified", "Hermes Fork helper only verifies Hermes 0.21.0.")
    parent_id = request.get("parentSessionId")
    child_id = request.get("childSessionId")
    boundary_id = request.get("boundaryRowId")
    if not isinstance(parent_id, str) or not parent_id.strip() or not isinstance(child_id, str) or not child_id.strip():
        raise HelperFailure("invalid_session", "Hermes parent or child session identity is missing.", "unsupported")
    if isinstance(boundary_id, bool) or not isinstance(boundary_id, int) or boundary_id < 1:
        raise HelperFailure("invalid_boundary", "Hermes Fork requires a positive exact global message row ID.", "unsupported")
    source_path = Path(os.environ.get("RUDDER_HERMES_SOURCE", "")).resolve()
    home = Path(os.environ.get("HERMES_HOME", "")).expanduser().resolve()
    if not source_path.is_absolute() or not (source_path / "hermes_state.py").is_file() or not home.is_absolute():
        raise HelperFailure("invalid_profile", "Hermes Fork requires host-authorized source and HERMES_HOME paths.")
    import hermes_cli
    if getattr(hermes_cli, "__version__", None) != SUPPORTED_VERSION:
        raise HelperFailure("provider_version_unverified", "Installed Hermes source version does not match verified 0.21.0.")
    if not Path(hermes_cli.__file__).resolve().is_relative_to(source_path):
        raise HelperFailure("source_mismatch", "Hermes version module did not resolve from the authorized source path.")
    import hermes_state
    if not Path(hermes_state.__file__).resolve().is_relative_to(source_path):
        raise HelperFailure("source_mismatch", "Hermes SessionDB did not resolve from the authorized source path.")
    from hermes_state import SessionDB
    if not (home / "state.db").is_file():
        raise HelperFailure("database_missing", "The authorized Hermes HERMES_HOME has no state.db.")
    reader = SessionDB(db_path=home / "state.db", read_only=True)
    db = None
    child_created = False
    failure = None
    try:
        read_methods = ("get_session", "get_resume_conversations")
        if any(not callable(getattr(reader, name, None)) for name in read_methods):
            raise HelperFailure("sessiondb_contract_mismatch", "Installed Hermes SessionDB does not implement the verified read contract.")
        parent_before = stable_session_snapshot(session_record(reader, parent_id))
        parent_rows_before = display_rows(reader, parent_id)
        visible_rows = visible_branch_history(parent_rows_before)
        matches = [index for index, row in enumerate(visible_rows) if row.get("_row_id") == boundary_id]
        if len(matches) != 1:
            raise HelperFailure("boundary_not_found", "Exact Hermes Fork boundary is absent from the parent display history.", "unsupported")
        boundary_index = matches[0]
        boundary_row = visible_rows[boundary_index]
        if boundary_row.get("role") != "assistant" or not visible_text(boundary_row.get("content")).strip():
            raise HelperFailure("boundary_not_completed_assistant", "Hermes Fork boundary must be a completed visible assistant message.", "unsupported")
        finish_reason = boundary_row.get("finish_reason")
        if (not isinstance(finish_reason, str) or not finish_reason.strip()
                or finish_reason.strip().lower() in ("error", "agent_error", "content_filter", "tool_calls", "function_call")
                or boundary_row.get("status") in ("in_progress", "streaming", "running")
                or boundary_row.get("in_progress") is True):
            raise HelperFailure("boundary_not_completed_assistant", "Hermes Fork boundary is not a completed assistant message.", "unsupported")
        prefix = visible_rows[:boundary_index + 1]
        parent = session_record(reader, parent_id)
        source = parent.get("source") or "acp"
        cwd = parent.get("cwd")
        profile_name = parent.get("profile_name") or home.name
        model = parent.get("model")
        reader.close()
        reader = None
        db = SessionDB(db_path=home / "state.db")
        write_methods = ("get_session", "create_session", "append_messages_batch", "delete_session")
        if any(not callable(getattr(db, name, None)) for name in write_methods):
            raise HelperFailure("sessiondb_contract_mismatch", "Installed Hermes SessionDB does not implement the verified Fork write contract.")
        if db.get_session(child_id) is not None:
            raise HelperFailure("child_collision", "Hermes child session identity already exists.")
        db.create_session(
            child_id,
            source=source,
            model=model,
            model_config={"_branched_from": parent_id},
            parent_session_id=parent_id,
            cwd=cwd,
            profile_name=profile_name,
        )
        child_created = True
        inserted = db.append_messages_batch(child_id, [copied_message(row) for row in prefix], chunk_rows=500)
        if isinstance(inserted, bool) or inserted != len(prefix):
            raise HelperFailure("copy_count_mismatch", "Hermes SessionDB did not confirm the complete visible prefix copy.")
        if callable(getattr(db, "get_session_title", None)) and callable(getattr(db, "set_session_title", None)):
            current_title = db.get_session_title(parent_id) or "branch"
            if callable(getattr(db, "get_next_title_in_lineage", None)):
                child_title = db.get_next_title_in_lineage(current_title)
            else:
                child_title = current_title + " (branch)"
            db.set_session_title(child_id, child_title)
        reader = SessionDB(db_path=home / "state.db", read_only=True)
        if any(not callable(getattr(reader, name, None)) for name in read_methods):
            raise HelperFailure("sessiondb_contract_mismatch", "Installed Hermes SessionDB does not implement the verified read contract.")
        child_rows = display_rows(reader, child_id)
        child_visible_rows = visible_branch_history(child_rows)
        if len(child_visible_rows) != len(prefix):
            raise HelperFailure("copy_mismatch", "Hermes child display projection does not contain exactly the copied visible prefix.")
        identity_map = {}
        for source_row, child_row in zip(prefix, child_visible_rows):
            if source_row.get("role") != child_row.get("role") or source_row.get("content") != child_row.get("content"):
                raise HelperFailure("copy_mismatch", "Hermes child message role/content differs from the selected parent prefix.")
            for field in BRANCH_COPY_FIELDS:
                if source_row.get(field) != child_row.get(field):
                    raise HelperFailure("copy_mismatch", "Hermes child message metadata differs from the selected parent prefix.")
            source_row_id = source_row["_row_id"]
            child_row_id = child_row.get("_row_id")
            if isinstance(child_row_id, bool) or not isinstance(child_row_id, int) or child_row_id < 1:
                raise HelperFailure("copy_mismatch", "Hermes child history has no valid global _row_id.")
            identity_map[str(source_row_id)] = str(child_row_id)
        child_session = session_record(reader, child_id)
        if child_session.get("parent_session_id") != parent_id or session_model_config(child_session).get("_branched_from") != parent_id:
            raise HelperFailure("lineage_mismatch", "Hermes child session does not preserve native parent lineage.")
        if child_visible_rows[-1].get("role") != "assistant" or not visible_text(child_visible_rows[-1].get("content")).strip():
            raise HelperFailure("copy_mismatch", "Hermes child boundary is not the copied visible assistant row.")
        if (stable_session_snapshot(session_record(reader, parent_id)) != parent_before
                or display_rows(reader, parent_id) != parent_rows_before):
            raise HelperFailure("parent_changed", "Hermes parent changed during the Fork; the child copy was not accepted.")
        child_boundary_id = child_visible_rows[-1]["_row_id"]
        return {
            "ok": True,
            "helperVersion": HELPER_VERSION,
            "parentSessionId": parent_id,
            "childSessionId": child_id,
            "sourceBoundaryRowId": boundary_id,
            "childBoundaryRowId": child_boundary_id,
            "identityMap": identity_map,
            "copiedCount": len(prefix),
        }
    except BaseException as exc:
        failure = exc
        rolled_back = not child_created
        if child_created:
            try:
                rolled_back = bool(db and db.delete_session(child_id))
                if not rolled_back:
                    failure = HelperFailure("rollback_failed", "Hermes Fork failed and SessionDB did not confirm child compensation.")
            except BaseException as rollback_exc:
                rolled_back = False
                failure = HelperFailure("rollback_failed", "Hermes Fork failed and child compensation raised: " + str(rollback_exc)[:500])
        if isinstance(failure, HelperFailure):
            failure.rolled_back = rolled_back
            raise failure
        wrapped = HelperFailure("fork_failed", str(failure)[:1000])
        wrapped.rolled_back = rolled_back
        raise wrapped from failure
    finally:
        if reader is not None:
            reader.close()
        if db is not None:
            db.close()

try:
    def interrupt(signum, _frame):
        raise InterruptedError("Hermes Fork helper interrupted.")
    signal.signal(signal.SIGTERM, interrupt)
    try:
        emit(main())
    except HelperFailure as exc:
        emit({"ok": False, "status": exc.status, "rolledBack": getattr(exc, "rolled_back", True), "error": {"code": exc.code, "message": str(exc)}})
    except Exception as exc:
        emit({"ok": False, "status": "unknown", "rolledBack": True, "error": {"code": "fork_failed", "message": str(exc)[:1000]}})
except Exception:
    pass
`;

type HermesProductRpcForkHelperResponse = {
  ok: boolean;
  status?: "unsupported" | "unknown";
  rolledBack?: boolean;
  helperVersion?: string;
  parentSessionId?: string;
  childSessionId?: string;
  sourceBoundaryRowId?: number;
  childBoundaryRowId?: number;
  identityMap?: Record<string, string>;
  copiedCount?: number;
  error?: { code?: string; message?: string };
};

function forkHelperEnvironment(profile: HermesProductRpcProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    ["PATH", "HOME", "USER", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  env.HERMES_HOME = path.resolve(profile.hermesHome);
  env.RUDDER_HERMES_SOURCE = path.resolve(profile.hermesSourcePath);
  env.PYTHONPATH = path.resolve(profile.hermesSourcePath);
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

async function runHermesProductRpcForkHelper(input: {
  profile: HermesProductRpcProfile;
  parentSessionId: string;
  childSessionId: string;
  boundaryRowId: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HermesProductRpcForkHelperResponse> {
  const timeoutMs = input.timeoutMs ?? FORK_HELPER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new HermesProductRpcForkError("unsupported", "Hermes Fork helper timeout must be between 1 and 60000ms.", {
      sessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
    });
  }
  if (input.signal?.aborted) {
    throw new HermesProductRpcForkError("unknown", "Hermes Fork was cancelled before the SessionDB helper started.", {
      sessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      rolledBack: true,
    });
  }
  return await new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(input.profile.hermesPythonCommand, ["-c", PYTHON_FORK_HELPER_SOURCE], {
        cwd: path.resolve(input.profile.hermesSourcePath),
        env: forkHelperEnvironment(input.profile),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new HermesProductRpcForkError("unknown", `Hermes Fork helper could not start: ${String(error).slice(0, 500)}`, {
        sessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
      }));
      return;
    }
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let terminationMessage: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let helperTimer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (helperTimer) clearTimeout(helperTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const request = {
      helperVersion: HERMES_PRODUCT_RPC_FORK_HELPER_VERSION,
      runtimeType: "hermes_gateway",
      providerVersion: input.profile.providerVersion,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      boundaryRowId: input.boundaryRowId,
    };
    const terminate = (message: string) => {
      if (settled || terminationMessage) return;
      terminationMessage = message;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), FORK_HELPER_KILL_GRACE_MS);
    };
    const onAbort = () => terminate("Hermes Fork was cancelled; the helper was asked to roll back its child session.");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    helperTimer = setTimeout(() => terminate("Hermes Fork helper timed out; child rollback could not be confirmed."), timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > FORK_HELPER_MAX_OUTPUT_BYTES) {
        terminate("Hermes Fork helper exceeded the response size limit; child rollback could not be confirmed.");
        return;
      }
      stdout += decoder.write(buffer);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4_000) stderr += String(chunk).slice(0, 4_000 - stderr.length);
    });
    child.on("error", (error) => finish(() => reject(new HermesProductRpcForkError(
      "unknown",
      `Hermes Fork helper failed: ${String(error).slice(0, 500)}`,
      { sessionId: input.parentSessionId, childSessionId: input.childSessionId, rolledBack: true },
    ))));
    child.on("close", (code) => {
      stdout += decoder.end();
      if (settled) return;
      if (code !== 0) {
        finish(() => reject(new HermesProductRpcForkError("unknown", `Hermes Fork helper exited with status ${String(code)}: ${stderr.trim().slice(0, 500)}`, {
          sessionId: input.parentSessionId,
          childSessionId: input.childSessionId,
          rolledBack: false,
        })));
        return;
      }
      let response: HermesProductRpcForkHelperResponse;
      try {
        response = JSON.parse(stdout.trim()) as HermesProductRpcForkHelperResponse;
      } catch {
        finish(() => reject(new HermesProductRpcForkError("unknown", `Hermes Fork helper returned invalid JSON: ${stderr.trim().slice(0, 500)}`, {
          sessionId: input.parentSessionId,
          childSessionId: input.childSessionId,
        })));
        return;
      }
      if (terminationMessage) {
        finish(() => reject(new HermesProductRpcForkError("unknown", terminationMessage!, {
          sessionId: input.parentSessionId,
          childSessionId: input.childSessionId,
          rolledBack: response.rolledBack === true,
        })));
        return;
      }
      finish(() => resolve(response));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function forkHermesProductRpcNativeSession(input: {
  runtimeType: string;
  profile: HermesProductRpcProfile;
  session: { sessionId: string; sessionParams: JsonRecord; sessionDisplayId: string };
  boundary: string;
  binding?: HermesAcpBinding | null;
  workspace?: HermesAcpWorkspace | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HermesAcpForkResult> {
  const sessionId = text(input.session.sessionId);
  const profile = input.profile;
  const fail = (status: "unsupported" | "unknown", message: string): never => {
    throw new HermesProductRpcForkError(status, message, { sessionId });
  };
  if (input.runtimeType !== "hermes_gateway") fail("unsupported", "Hermes Product Fork received a different runtime type.");
  if (!isHermesProductRpcProfile(profile) || hermesProductRpcProfileEvidence(profile).status !== "supported") {
    fail("unknown", hermesProductRpcProfileEvidence(profile).reason);
  }
  if (!sessionId || input.session.sessionDisplayId !== sessionId) {
    fail("unsupported", "Hermes Product Fork session identity does not match its provider display identity.");
  }
  const boundProfile = profile.binding;
  const requestedBinding = input.binding;
  if (!requestedBinding
    || requestedBinding.hostId !== boundProfile.hostId
    || requestedBinding.profileId !== boundProfile.profileId
    || text(requestedBinding.id) !== text(boundProfile.id)
    || text(requestedBinding.orgId) !== text(boundProfile.orgId)
    || text(requestedBinding.workspaceBindingId) !== text(boundProfile.workspaceBindingId)
    || text(requestedBinding.capabilityRevision) !== text(boundProfile.capabilityRevision)) {
    fail("unsupported", "Hermes Product Fork host/profile binding does not match the authorized runtime profile.");
  }
  const sessionRejection = validateHermesProductRpcSession({
    sessionId,
    sessionParams: input.session.sessionParams,
    profile,
    workspace: input.workspace,
  });
  if (sessionRejection) fail("unsupported", sessionRejection);
  const match = /^hermes:db:([^:]+):([1-9][0-9]*)$/.exec(input.boundary);
  const boundaryValue = match?.[2];
  if (!boundaryValue || match?.[1] !== sessionId) {
    fail("unsupported", "Hermes Product Fork requires an exact global row boundary from the selected parent session.");
  }
  const boundaryRowId = Number(boundaryValue);
  if (!Number.isSafeInteger(boundaryRowId) || boundaryRowId < 1) {
    fail("unsupported", "Hermes Product Fork boundary row ID is not a safe positive integer.");
  }
  await validateLaunchProfile(profile).catch((error) => fail("unknown", `Hermes Product Fork profile is unavailable: ${String(error).slice(0, 500)}`));
  const childSessionId = randomUUID();
  const helper = await runHermesProductRpcForkHelper({
    profile,
    parentSessionId: sessionId,
    childSessionId,
    boundaryRowId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!helper.ok) {
    const status = helper.status === "unsupported" ? "unsupported" : "unknown";
    throw new HermesProductRpcForkError(status, helper.error?.message ?? "Hermes Product Fork failed without a diagnostic.", {
      sessionId,
      childSessionId,
      rolledBack: helper.rolledBack === true,
    });
  }
  if (helper.helperVersion !== HERMES_PRODUCT_RPC_FORK_HELPER_VERSION
    || helper.parentSessionId !== sessionId
    || helper.childSessionId !== childSessionId
    || helper.sourceBoundaryRowId !== boundaryRowId
    || typeof helper.childBoundaryRowId !== "number"
    || !Number.isSafeInteger(helper.childBoundaryRowId)
    || !helper.identityMap
    || helper.identityMap[String(boundaryRowId)] !== String(helper.childBoundaryRowId)
    || typeof helper.copiedCount !== "number"
    || !Number.isSafeInteger(helper.copiedCount)
    || helper.copiedCount < 1
    || Object.keys(helper.identityMap).length !== helper.copiedCount
    || !Object.entries(helper.identityMap).every(([sourceRowId, childRowId]) => (
      /^[1-9][0-9]*$/.test(sourceRowId)
      && /^[1-9][0-9]*$/.test(childRowId)
      && Number.isSafeInteger(Number(sourceRowId))
      && Number.isSafeInteger(Number(childRowId))
    ))
    || new Set(Object.values(helper.identityMap)).size !== Object.keys(helper.identityMap).length) {
    throw new HermesProductRpcForkError("unknown", "Hermes Product Fork helper returned an incomplete or mismatched source-to-child row map.", {
      sessionId,
      childSessionId,
      rolledBack: false,
    });
  }
  const identityMap = Object.fromEntries(Object.entries(helper.identityMap).map(([sourceRowId, childRowId]) => [
    `hermes:db:${sessionId}:${sourceRowId}`,
    `hermes:db:${childSessionId}:${childRowId}`,
  ]));
  const childBoundary = `hermes:db:${childSessionId}:${helper.childBoundaryRowId}`;
  return {
    session: {
      sessionId: childSessionId,
      sessionParams: buildHermesProductRpcSessionParams({ sessionId: childSessionId, profile, workspace: input.workspace }),
      sessionDisplayId: childSessionId,
    },
    boundary: childBoundary,
    sourceBoundary: input.boundary,
    identityMap,
    continuity: "native",
  };
}

async function validateLaunchProfile(profile: HermesProductRpcProfile): Promise<void> {
  for (const [label, value] of [
    ["Hermes Python interpreter", profile.hermesPythonCommand],
    ["Hermes source path", profile.hermesSourcePath],
    ["Hermes HERMES_HOME", profile.hermesHome],
    ["Hermes Product Gateway cwd", profile.cwd],
  ] as const) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute host-authorized path.`);
  }
  const [python, source, entry] = await Promise.all([
    fs.stat(profile.hermesPythonCommand),
    fs.stat(profile.hermesSourcePath),
    fs.stat(path.join(profile.hermesSourcePath, "tui_gateway", "entry.py")),
  ]);
  if (!python.isFile() || !source.isDirectory() || !entry.isFile()) {
    throw new Error("The authorized Hermes installation does not contain the Python interpreter and tui_gateway.entry module.");
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForApprovalOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | "aborted"> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const HERMES_PRODUCT_RPC_HISTORY_FENCE_HELPER = String.raw`
import json
from pathlib import Path
import sqlite3
import sys

connection = None
try:
    connection = sqlite3.connect(
        Path(sys.argv[1]).resolve().as_uri() + "?mode=rw",
        timeout=max(0.001, int(sys.argv[3]) / 1000), isolation_level=None, uri=True)
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute(
        "SELECT MAX(id) FROM messages WHERE session_id = ?", (sys.argv[2],)).fetchone()
    tail = row[0] if row else None
    if tail is not None and (isinstance(tail, bool) or not isinstance(tail, int) or tail < 1):
        raise RuntimeError("Hermes SessionDB returned an invalid message row ID")
    print(json.dumps({"locked": True, "tailRowId": tail}), flush=True)
    for line in sys.stdin:
        if line.strip() == "release":
            break
    connection.rollback()
except Exception as error:
    print(json.dumps({"locked": False, "error": str(error)[:500]}), flush=True)
finally:
    if connection is not None:
        connection.close()
`;

async function acquireHermesProductRpcHistoryFence(input: {
  profile: HermesProductRpcProfile;
  sessionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<HermesProductRpcHistoryFence | null> {
  if (input.signal?.aborted) return null;
  const timeoutMs = Math.max(100, Math.min(input.timeoutMs, 5_000));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.profile.hermesPythonCommand, [
      "-c",
      HERMES_PRODUCT_RPC_HISTORY_FENCE_HELPER,
      path.join(input.profile.hermesHome, "state.db"),
      input.sessionId,
      String(timeoutMs),
    ], {
      cwd: input.profile.hermesSourcePath,
      env: {
        ...process.env,
        HERMES_HOME: path.resolve(input.profile.hermesHome),
        PYTHONPATH: [path.resolve(input.profile.hermesSourcePath), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: "pipe",
    });
  } catch {
    return null;
  }

  let closed = false;
  let stdout = "";
  let releasePromise: Promise<void> | null = null;
  let releaseTimer: NodeJS.Timeout | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      if (releaseTimer) clearTimeout(releaseTimer);
      resolve();
    });
  });
  const stopChild = async () => {
    if (!closed) child.kill("SIGTERM");
    try {
      await withTimeout(closedPromise, 750, "Hermes history fence helper did not stop.");
    } catch {
      if (!closed) child.kill("SIGKILL");
      await closedPromise;
    }
  };
  const ready = new Promise<{ tailRowId: number | null }>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const line = stdout.slice(0, newline);
      try {
        const result = record(JSON.parse(line));
        if (result?.locked !== true) throw new Error("Hermes SessionDB could not grant a history writer fence.");
        const tailRowId = result.tailRowId;
        if (tailRowId !== null && (!Number.isSafeInteger(tailRowId) || (tailRowId as number) < 1)) {
          throw new Error("Hermes SessionDB returned an invalid message row ID.");
        }
        resolve({ tailRowId: tailRowId as number | null });
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`Hermes history fence helper exited before locking (${code ?? "signal"}).`)));
  });

  let locked: { tailRowId: number | null };
  try {
    locked = await withTimeout(ready, timeoutMs, "Hermes SessionDB history writer fence timed out.");
  } catch {
    child.stdin.end();
    await stopChild();
    return null;
  }

  const release = () => {
    if (!releasePromise) {
      if (releaseTimer) clearTimeout(releaseTimer);
      releasePromise = (async () => {
        if (!closed) child.stdin.end("release\n");
        try {
          await withTimeout(closedPromise, 1_000, "Hermes history fence did not release.");
        } catch {
          await stopChild();
        }
      })();
    }
    return releasePromise;
  };
  releaseTimer = setTimeout(() => { void release(); }, HISTORY_FENCE_MAX_HOLD_MS);
  releaseTimer.unref();

  return {
    tailRowId: locked.tailRowId,
    isHeld: () => !closed,
    release,
  };
}

async function hermesProductRpcLeaseMatches(input: HermesProductRpcLeaseIdentity): Promise<boolean> {
  try {
    const source = await fs.readFile(path.join(input.profile.hermesHome, "runtime", "active_sessions.json"), "utf8");
    const registry = record(JSON.parse(source));
    if (!registry || !Array.isArray(registry.entries)) return false;
    const matchingSession = registry.entries.filter((entry) => record(entry)?.session_id === input.sessionId);
    if (matchingSession.length !== 1) return false;
    const entry = record(matchingSession[0]);
    const metadata = record(entry?.metadata);
    return entry?.pid === input.gatewayPid && metadata?.live_session_id === input.gatewaySessionId;
  } catch {
    return false;
  }
}

async function waitForHermesProductRpcLease(input: HermesProductRpcLeaseIdentity): Promise<boolean> {
  const deadline = Date.now() + Math.max(100, Math.min(input.timeoutMs, 5_000));
  while (!input.signal?.aborted && Date.now() < deadline) {
    if (await hermesProductRpcLeaseMatches(input)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function providerVersionSupported(profile: HermesProductRpcProfile): boolean {
  return HERMES_PRODUCT_RPC_VERIFIED_VERSIONS.includes(profile.providerVersion as (typeof HERMES_PRODUCT_RPC_VERIFIED_VERSIONS)[number]);
}

function historyProfile(profile: HermesProductRpcProfile): HermesProductHistoryProfile | null {
  const pythonCommand = text(profile.hermesPythonCommand);
  const sourcePath = text(profile.hermesSourcePath);
  const hermesHome = text(profile.hermesHome);
  if (![pythonCommand, sourcePath, hermesHome].every((value) => value && path.isAbsolute(value))) return null;
  return {
    pythonCommand,
    sourcePath,
    hermesHome,
    providerVersion: profile.providerVersion ?? null,
    hostId: profile.binding.hostId,
    profileId: profile.binding.profileId,
  };
}

async function readProductRpcHistoryTail(
  profile: HermesProductRpcProfile,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HermesProductRpcHistoryTail | null> {
  const authorizedProfile = historyProfile(profile);
  if (!authorizedProfile) return null;
  try {
    const result = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId,
      profile: authorizedProfile,
      limit: 1,
      timeoutMs: Math.min(timeoutMs, 60_000),
      signal,
    });
    return {
      availability: result.availability,
      tailRowId: result.metadata.tailRowId,
      relation: result.metadata.lineage.relation,
      successorSessionId: result.metadata.lineage.successorSessionId,
    };
  } catch {
    return { availability: "offline", tailRowId: null, relation: "unknown", successorSessionId: null };
  }
}

function unknownTranscriptBoundary(sessionId: string, reason: string): HermesProductRpcTranscriptBoundary {
  return { status: "unknown", sessionId, startExclusive: null, endInclusive: null, sourceRangeRef: null, reason };
}

function runTranscriptSupplement(input: {
  settled: boolean;
  eventCount: number;
  truncated: boolean;
  writeFailed: boolean;
}): JsonRecord {
  return {
    source: "rudder_run_log",
    completeness: input.settled && !input.truncated && !input.writeFailed ? "complete" : "partial",
    eventCount: input.eventCount,
    truncated: input.truncated,
    writeFailed: input.writeFailed,
  };
}

export function deriveHermesProductRpcTranscriptBoundary(input: {
  sessionId: string;
  historyProfileAvailable: boolean;
  before: HermesProductRpcHistoryTail | null;
  after: HermesProductRpcHistoryTail | null;
  lockedTailRowId: number | null;
  historyFenceHeldThroughLease: boolean;
  promptAcceptanceProven: boolean;
}): HermesProductRpcTranscriptBoundary {
  if (!input.historyProfileAvailable) return unknownTranscriptBoundary(input.sessionId, "Hermes host history profile is unavailable.");
  if (!input.before || input.before.availability !== "available") {
    return unknownTranscriptBoundary(input.sessionId, "Hermes persisted history tail could not be read before the Product Gateway prompt.");
  }
  if (!input.after || input.after.availability !== "available") {
    return unknownTranscriptBoundary(input.sessionId, "Hermes persisted history tail could not be read after the Product Gateway prompt.");
  }
  if (!input.promptAcceptanceProven) {
    return unknownTranscriptBoundary(input.sessionId, "Hermes Product Gateway did not positively acknowledge this prompt as an active streaming turn.");
  }
  if (!input.historyFenceHeldThroughLease) {
    return unknownTranscriptBoundary(input.sessionId, "Rudder could not hold a SessionDB writer fence from the exact pre-prompt row tail until this Gateway process acquired its per-session lease.");
  }
  if (input.before.tailRowId !== input.lockedTailRowId) {
    return unknownTranscriptBoundary(input.sessionId, "Hermes history reader tail did not match the row ID captured under the SessionDB writer fence.");
  }
  if (input.before.relation !== "none" || input.after.relation !== "none") {
    return unknownTranscriptBoundary(
      input.sessionId,
      `Hermes compression/session successor prevents proving one Run range (${input.after.successorSessionId ?? "unknown successor"}).`,
    );
  }
  const startExclusive = input.before.tailRowId;
  const endInclusive = input.after.tailRowId;
  if (endInclusive === null || (startExclusive !== null && endInclusive <= startExclusive)) {
    return unknownTranscriptBoundary(input.sessionId, "Hermes Product Gateway prompt produced no provable persisted message interval.");
  }
  return {
    status: "exact",
    sessionId: input.sessionId,
    startExclusive,
    endInclusive,
    sourceRangeRef: JSON.stringify({ version: 1, status: "exact", sessionId: input.sessionId, startExclusive, endInclusive }),
  };
}

function parseGatewayEvent(method: string, params: JsonRecord): HermesProductRpcEvent | null {
  if (method !== "event") return null;
  const type = text(params.type);
  if (!type) return null;
  return {
    type,
    payload: record(params.payload) ?? {},
    sessionId: text(params.session_id ?? params.sessionId) || null,
  };
}

function finiteTokenCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function usageFrom(value: unknown): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = finiteTokenCount(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const outputTokens = finiteTokenCount(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  if (inputTokens === null && outputTokens === null) return undefined;
  const cachedInputTokens = finiteTokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens ?? usage.cached_read_tokens);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

type InteractionStatus = "not_requested" | "resolved" | "denied" | "cancelled" | "unavailable" | "unresolved";
type SensitiveInputStatus = AgentRuntimeTransientInputResult["status"] | "unavailable" | "failed";
type SensitiveInputInterrupt = { status: "provider_expired" } | { status: "timed_out" | "aborted" };

function sensitiveInputMessage(input: {
  kind: AgentRuntimeTransientInputKind;
  status: SensitiveInputStatus;
  reason: string;
  cancellationFailed: boolean;
  responseFailed: boolean;
}): string | null {
  const label = input.kind === "sudo" ? "Hermes sudo password" : "Hermes secret input";
  if (input.reason === "provider_expired") {
    return `${label} request expired before the response was delivered; any late value was discarded.`;
  }
  if (input.responseFailed) {
    return input.cancellationFailed
      ? `${label} response was not acknowledged, and Rudder could not confirm cancellation of the native request.`
      : `${label} response was not acknowledged; Rudder cancelled the native request.`;
  }
  if (input.cancellationFailed) {
    return `${label} was not provided, and Rudder could not confirm cancellation of the native request.`;
  }
  if (input.reason === "empty_transient_value") {
    return `No value was provided for ${label}; the native request was cancelled.`;
  }
  switch (input.status) {
    case "provided":
      return null;
    case "cancelled":
      return `${label} was cancelled; no value was sent.`;
    case "timed_out":
      return `${label} timed out; no value was sent and the native request was cancelled.`;
    case "aborted":
      return `${label} was interrupted; no value was sent and the native request was cancelled.`;
    case "unavailable":
      return `${label} cannot be collected without the authorized transient input channel; the native request was cancelled.`;
    case "failed":
      return `${label} could not be resolved; the native request was cancelled.`;
  }
}

function selectedAnswer(
  decision: AgentRuntimeApprovalDecision,
  questionId: string,
  options: Map<string, string>,
  allowMultiple: boolean,
): string | null {
  const answer = decision.inputResponse?.answers.find((entry) => entry.questionId === questionId);
  if (!answer) return null;
  if (!allowMultiple && answer.optionIds.length > 1) return null;
  const values = answer.optionIds.map((id) => options.get(id));
  if (values.some((value) => value === undefined)) return null;
  const freeformText = text(answer.freeformText);
  if (freeformText && values.length > 0) return `${values.join(", ")}\n${freeformText}`;
  if (freeformText) return freeformText;
  return values.length > 0 ? values.join(", ") : null;
}

function selectedApprovalChoice(
  decision: AgentRuntimeApprovalDecision,
  questionId: string,
  options: Map<string, string>,
): string | null {
  const answer = decision.inputResponse?.answers.find((entry) => entry.questionId === questionId);
  if (!answer || answer.freeformText !== undefined || answer.optionIds.length !== 1) return null;
  return options.get(answer.optionIds[0]) ?? null;
}

type ExecuteInput = {
  profile: HermesProductRpcProfile;
  sessionId: string | null;
  sessionParams: JsonRecord | null;
  workspace?: HermesAcpWorkspace | null;
  prompt: string;
  model?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  controlAttempt?: AgentRuntimeControlAttemptLease;
  requestApproval?: (request: AgentRuntimeApprovalRequest) => Promise<{ id: string; status: string }>;
  waitForApproval?: (id: string, timeoutMs: number) => Promise<AgentRuntimeApprovalDecision>;
  requestTransientInput?: (request: AgentRuntimeTransientInputRequest) => Promise<AgentRuntimeTransientInputResult>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  secrets?: readonly string[];
  createClient?: HermesProductRpcClientFactory;
  readHistoryTail?: typeof readProductRpcHistoryTail;
  acquireHistoryFence?: (input: {
    profile: HermesProductRpcProfile;
    sessionId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<HermesProductRpcHistoryFence | null>;
  waitForSessionLease?: typeof waitForHermesProductRpcLease;
};

export async function executeHermesProductRpcChat(input: ExecuteInput): Promise<AgentRuntimeExecutionResult> {
  const profile = input.profile;
  const secrets = [...(input.secrets ?? [])];
  const configuredSecretCount = secrets.length;
  let sessionId = input.sessionId;
  let sessionParams = input.sessionParams;
  let historyBefore: HermesProductRpcHistoryTail | null = null;
  let historyFence: HermesProductRpcHistoryFence | null = null;
  let historyFenceTailRowId: number | null = null;
  let historyFenceTailMatches = false;
  let historyFenceLeaseProven = false;
  let gatewayPid: number | null = null;
  let client: HermesProductRpcClient | null = null;
  let controlLease: AgentRuntimeControlHandleLease | null = null;
  let promptSubmissionStarted = false;
  let stopRequested = false;
  let stopConfirmed = false;
  let interruptAttempted = false;
  let interruptRequest: Promise<JsonRecord | null> | null = null;
  let interactionError: string | null = null;
  let secretRequestObserved = false;
  let sensitiveInputError: string | null = null;
  let sensitiveInputCancellationFailed = false;
  let sensitiveInputResponseFailed = false;
  let approvalError: string | null = null;
  let approvalStatus: InteractionStatus = "not_requested";
  let clarificationStatus: InteractionStatus = "not_requested";
  const sensitiveInputKinds = new Set<"secret" | "sudo">();
  const sensitiveInputOutcomes: Array<{ kind: AgentRuntimeTransientInputKind; status: SensitiveInputStatus }> = [];
  const pendingSensitiveInputs = new Map<string, {
    responding: boolean;
    interrupt: (reason: SensitiveInputInterrupt) => void;
  }>();
  let eventBytes = 0;
  let eventsTruncated = false;
  let recordedEventCount = 0;
  let runLogWriteFailed = false;
  let runLogTail = Promise.resolve();
  const pendingRunLogWrites = new Set<Promise<void>>();
  const eventSequence: HermesProductRpcEvent[] = [];
  const interactionTasks = new Set<Promise<void>>();
  const sensitiveInputTasks = new Set<Promise<void>>();
  const gatewayReady = deferred<void>();
  const turnSettled = deferred<{ payload: JsonRecord; status: string }>();
  let selectedSessionId: string | null = null;
  let gatewaySessionId: string | null = null;
  let submittedAtSequence = 0;
  let queuedSubmit = false;
  let promptAccepted = false;
  let promptAcceptanceProven = false;
  let turnSettledObserved = false;
  let lastComplete: JsonRecord | null = null;
  let modelFromSession: string | null = null;

  const sensitiveInputFailureCode = (): string | null => {
    if (!sensitiveInputError) return null;
    if (sensitiveInputCancellationFailed) return "hermes_product_rpc_sensitive_input_cancel_unverified";
    if (sensitiveInputResponseFailed) return "hermes_product_rpc_sensitive_input_response_failed";
    const outcome = sensitiveInputOutcomes.find((entry) => entry.status !== "provided");
    return `hermes_product_rpc_sensitive_input_${outcome?.status ?? "failed"}`;
  };

  const logEvent = async (kind: string, payload: JsonRecord) => {
    const safe = record(safeValue(payload, secrets)) ?? {};
    const serialized = JSON.stringify({ type: "hermes_product_rpc_event", event: kind, payload: safe });
    if (serialized.length > MAX_EVENT_BYTES || recordedEventCount >= MAX_EVENTS || eventBytes + serialized.length > MAX_EVENT_TOTAL_BYTES) {
      eventsTruncated = true;
      return;
    }
    eventBytes += serialized.length;
    recordedEventCount += 1;
    await input.onLog("stdout", `${serialized}\n`);
  };

  const writeRunLogEvent = (kind: string, payload: JsonRecord): Promise<void> => {
    let pending!: Promise<void>;
    pending = runLogTail.then(() => logEvent(kind, payload))
      .catch((error) => {
        runLogWriteFailed = true;
        throw error;
      })
      .finally(() => pendingRunLogWrites.delete(pending));
    runLogTail = pending.catch(() => {});
    pendingRunLogWrites.add(pending);
    return pending;
  };

  const queueRunLogEvent = (kind: string, payload: JsonRecord) => {
    void writeRunLogEvent(kind, payload).catch(() => {});
  };

  const flushRunLogWrites = async () => {
    while (pendingRunLogWrites.size > 0) {
      await Promise.allSettled([...pendingRunLogWrites]);
    }
  };

  const request = async (method: string, params: JsonRecord, requestTimeout = input.timeoutMs) => {
    if (!client) throw new Error("Hermes Product Gateway is not connected.");
    return client.request(method, params, Math.max(1, requestTimeout));
  };

  const requestInteractionResponse = async (method: string, params: JsonRecord) => {
    const response = record(await request(method, params, Math.min(input.timeoutMs, 5_000)));
    if (text(response?.status) !== "ok") {
      throw new Error(`Hermes Product Gateway ${method} response was not acknowledged.`);
    }
  };

  const requestSensitiveInputResponse = async (method: string, params: JsonRecord): Promise<"ok" | "expired"> => {
    const response = record(await request(method, params, Math.min(input.timeoutMs, 5_000)));
    const status = text(response?.status);
    if (status === "ok" || status === "expired") return status;
    throw new Error(`Hermes Product Gateway ${method} response was not acknowledged.`);
  };

  const interruptSession = (): Promise<JsonRecord | null> => {
    interruptAttempted = true;
    stopRequested = true;
    if (!interruptRequest) {
      interruptRequest = request("session.interrupt", { session_id: gatewaySessionId }, Math.min(input.timeoutMs, 10_000))
        .then((value) => record(value))
        .catch(() => null);
    }
    return interruptRequest;
  };

  const cancelPendingSensitiveInputs = (status: "timed_out" | "aborted") => {
    for (const pending of pendingSensitiveInputs.values()) {
      if (!pending.responding) pending.interrupt({ status });
    }
  };

  const respondSensitiveInput = async (kind: AgentRuntimeTransientInputKind, requestId: string) => {
    secretRequestObserved = true;
    sensitiveInputKinds.add(kind);
    const eventType = `${kind}.request`;
    const method = kind === "secret" ? "secret.respond" : "sudo.respond";
    const responseField = kind === "secret" ? "value" : "password";
    let status: SensitiveInputStatus = "failed";
    let reason = "transient_input_failed";
    let cancellationFailed = false;
    let responseFailed = false;
    if (!requestId) {
      reason = "request_id_missing";
      sensitiveInputError ??= `Hermes ${kind} input request omitted its request ID and could not be answered.`;
      sensitiveInputOutcomes.push({ kind, status });
      queueRunLogEvent(eventType, { requestId: null, status, reason });
      return;
    }
    const pendingKey = `${kind}:${requestId}`;
    const interrupted = deferred<SensitiveInputInterrupt>();
    let interruptionReason: SensitiveInputInterrupt | null = null;
    const pending = {
      responding: false,
      interrupt(reason: SensitiveInputInterrupt) {
        if (pending.responding || interruptionReason) return;
        interruptionReason = reason;
        interrupted.resolve(reason);
      },
    };
    pendingSensitiveInputs.set(pendingKey, pending);
    try {
      const transientResult = input.requestTransientInput
        ? Promise.resolve()
          .then(() => input.requestTransientInput!({ kind }))
          .catch(() => ({ status: "failed" as const }))
        : Promise.resolve({ status: "unavailable" as const });
      const racedOutcome = await Promise.race([transientResult, interrupted.promise]);
      const outcome = interruptionReason ?? (input.signal?.aborted
        ? { status: "aborted" as const }
        : turnSettledObserved
          ? { status: "timed_out" as const }
          : racedOutcome);
      if (outcome.status === "provider_expired") {
        status = "timed_out";
        reason = "provider_expired";
        pending.responding = true;
      } else if (outcome.status === "provided" && typeof outcome.value === "string" && outcome.value.length > 0) {
        pending.responding = true;
        secrets.push(outcome.value);
        try {
          const responseStatus = await requestSensitiveInputResponse(method, {
            request_id: requestId,
            [responseField]: outcome.value,
          });
          if (responseStatus === "expired") {
            status = "timed_out";
            reason = "provider_expired";
          } else {
            status = "provided";
            reason = "transient_input_provided";
          }
        } catch {
          responseFailed = true;
          sensitiveInputResponseFailed = true;
          status = "failed";
          reason = "response_not_acknowledged";
          try {
            await requestSensitiveInputResponse(method, { request_id: requestId, [responseField]: "" });
          } catch {
            cancellationFailed = true;
          }
        }
      } else {
        status = outcome.status === "provided" ? "cancelled" : outcome.status;
        reason = outcome.status === "provided" ? "empty_transient_value" : `transient_input_${outcome.status}`;
        pending.responding = true;
        try {
          await requestSensitiveInputResponse(method, { request_id: requestId, [responseField]: "" });
        } catch {
          cancellationFailed = true;
          status = "failed";
          reason = "cancellation_not_acknowledged";
        }
      }
      sensitiveInputCancellationFailed ||= cancellationFailed;
      sensitiveInputError ??= sensitiveInputMessage({ kind, status, reason, cancellationFailed, responseFailed });
    } finally {
      pendingSensitiveInputs.delete(pendingKey);
      sensitiveInputOutcomes.push({ kind, status });
      queueRunLogEvent(eventType, { requestId, status, reason });
    }
  };

  const respondApproval = async (event: HermesProductRpcEvent) => {
    approvalStatus = "unresolved";
    const requestId = text(event.payload.request_id ?? event.payload.requestId);
    if (!requestId) {
      approvalError ??= "Hermes approval event omitted its request ID.";
      return;
    }
    const rawChoices = Array.isArray(event.payload.choices) ? event.payload.choices : ["once", "session", "always", "deny"];
    const choices = rawChoices.map(text).filter((choice) => APPROVAL_OPTION_VALUES.has(choice));
    const choiceOptions = choices.map((choice, index) => ({ id: `hermes_choice_${index + 1}`, label: choice === "once" ? "Allow once" : choice === "session" ? "Allow this session" : choice === "always" ? "Always allow" : "Deny" }));
    const optionValues = new Map(choiceOptions.map((option, index) => [option.id, choices[index]! ]));
    const safeDescription = safeText(event.payload.description ?? "Hermes requests permission.", secrets, 500);
    const safeCommand = safeText(event.payload.command, secrets, 1_000);
    await writeRunLogEvent(event.type, { requestId, status: "requested", description: safeDescription, command: safeCommand || null, choices });
    let selected = "deny";
    try {
      if (input.requestApproval && input.waitForApproval && choiceOptions.length >= 2 && !input.signal?.aborted) {
        const questionId = "hermes_product_approval";
        const approval = await input.requestApproval({
          type: "agent_runtime",
          payload: {
            provider: "hermes",
            runtimeType: "hermes_gateway",
            protocol: "native_product_rpc",
            sessionId: selectedSessionId,
            requestId,
            interactionKind: "permission",
            description: safeDescription,
            command: safeCommand || null,
            choices,
          },
          inputRequest: {
            questions: [{
              id: questionId,
              header: "Hermes",
              question: safeDescription,
              options: choiceOptions,
              selectionMode: "single",
            }],
          },
        });
        if (approval.status === "rejected" || approval.status === "cancelled") {
          approvalStatus = "denied";
        } else {
          const decision = await waitForApprovalOrAbort(input.waitForApproval(approval.id, Math.max(1, input.timeoutMs)), input.signal);
          if (decision === "aborted") {
            approvalStatus = "cancelled";
          } else if (decision.id !== approval.id) {
            approvalError ??= "Hermes approval response did not match the pending request.";
          } else if (decision.status === "approved") {
            const choice = selectedApprovalChoice(decision, questionId, optionValues);
            if (choice && choices.includes(choice)) {
              selected = choice;
              approvalStatus = choice === "deny" ? "denied" : "resolved";
            } else {
              approvalError ??= "Hermes approval response did not contain one of the offered choices.";
            }
          } else if (decision.status === "rejected" || decision.status === "cancelled") {
            approvalStatus = "denied";
          } else {
            approvalError ??= "Hermes approval response was not resolved before the request expired.";
          }
        }
      } else if (input.signal?.aborted) {
        approvalStatus = "cancelled";
      } else {
        approvalStatus = "unavailable";
        approvalError ??= "Hermes approval cannot be collected through the available Rudder interaction contract.";
      }
    } catch {
      approvalError ??= "Hermes approval could not be resolved through Rudder.";
      approvalStatus = "unresolved";
    }
    try {
      await requestInteractionResponse("approval.respond", { session_id: selectedSessionId, request_id: requestId, choice: selected });
    } catch {
      approvalStatus = "unresolved";
      throw new Error("Hermes approval response was not acknowledged.");
    }
    if (selected === "deny" && approvalStatus === "unresolved") approvalStatus = "denied";
    await writeRunLogEvent(event.type, { requestId, status: approvalStatus, choice: selected });
  };

  const respondClarify = async (event: HermesProductRpcEvent) => {
    clarificationStatus = "unresolved";
    const requestId = text(event.payload.request_id ?? event.payload.requestId);
    if (!requestId) {
      interactionError ??= "Hermes clarification event omitted its request ID.";
      return;
    }
    const rawQuestions = Array.isArray(event.payload.questions) ? event.payload.questions : null;
    const questions = rawQuestions
      ? rawQuestions.map(record).filter((value): value is JsonRecord => Boolean(value))
      : [];
    const hasExplicitQuestions = Boolean(rawQuestions?.length);
    const questionRows = questions.length > 0
      ? questions
      : [{ qid: "hermes_question", question: event.payload.question, choices: event.payload.choices }];
    const cancelClarification = async () => {
      await requestInteractionResponse("clarify.respond", { session_id: selectedSessionId, request_id: requestId, answer: "" });
      await writeRunLogEvent(event.type, { requestId, status: clarificationStatus });
    };
    if ((rawQuestions && questions.length !== rawQuestions.length) || questionRows.length > 4) {
      clarificationStatus = "unavailable";
      interactionError ??= "Hermes clarification cannot be represented by Rudder's structured input contract.";
      await cancelClarification();
      return;
    }
    const choiceMaps = new Map<string, Map<string, string>>();
    const providerQuestionIds = new Set<string>();
    let providerQuestionIdentityInvalid = false;
    const inputQuestions = questionRows.map((question, index) => {
      const questionId = `hermes_clarify_${index + 1}`;
      const choices = Array.isArray(question.choices) ? question.choices.map(text).filter(Boolean) : [];
      const options = choices.map((label, optionIndex) => ({ id: `${questionId}_option_${optionIndex + 1}`, label: safeText(label, secrets) }));
      choiceMaps.set(questionId, new Map(options.map((option, optionIndex) => [option.id, choices[optionIndex]!])));
      const providerQuestionId = text(question.qid ?? question.id) || (questionRows.length === 1 ? "hermes_question" : "");
      if (!providerQuestionId || providerQuestionIds.has(providerQuestionId)) providerQuestionIdentityInvalid = true;
      providerQuestionIds.add(providerQuestionId);
      return {
        id: questionId,
        providerQuestionId,
        question: safeText(question.question, secrets, 500),
        options,
        multiSelect: question.multi_select === true,
      };
    });
    const parsedInputRequest = chatAskUserRequestSchema.safeParse({
      questions: inputQuestions.map(({ id, question, options, multiSelect }) => ({
        id,
        header: "Hermes",
        question,
        options,
        selectionMode: multiSelect ? "multiple" : "single",
        allowFreeform: true,
      })),
    });
    if (providerQuestionIdentityInvalid || !parsedInputRequest.success) {
      clarificationStatus = "unavailable";
      interactionError ??= "Hermes clarification cannot be represented by Rudder's structured input contract.";
      await cancelClarification();
      return;
    }
    await writeRunLogEvent(event.type, {
      requestId,
      status: "requested",
      questions: inputQuestions.map(({ id, question, options }) => ({ id, question, optionCount: options.length })),
    });
    let answers: Array<{ questionId: string; value: string }> = [];
    try {
      if (input.requestApproval && input.waitForApproval && !input.signal?.aborted) {
        const approval = await input.requestApproval({
          type: "agent_runtime",
          payload: {
            provider: "hermes",
            runtimeType: "hermes_gateway",
            protocol: "native_product_rpc",
            sessionId: selectedSessionId,
            requestId,
            interactionKind: "clarify",
          },
          inputRequest: parsedInputRequest.data,
        });
        if (approval.status === "rejected" || approval.status === "cancelled") {
          clarificationStatus = "cancelled";
          interactionError ??= "Hermes clarification was cancelled before an answer was submitted.";
        } else {
          const decision = await waitForApprovalOrAbort(input.waitForApproval(approval.id, Math.max(1, input.timeoutMs)), input.signal);
          if (decision === "aborted") {
            clarificationStatus = "cancelled";
            interactionError ??= "Hermes clarification was cancelled before an answer was submitted.";
          } else if (decision.id !== approval.id) {
            interactionError ??= "Hermes clarification response did not match the pending request.";
          } else if (decision.status === "approved") {
            const responseAnswers = decision.inputResponse?.answers ?? [];
            const expectedIds = new Set(inputQuestions.map(({ id }) => id));
            const responseIds = responseAnswers.map(({ questionId }) => questionId);
            if (new Set(responseIds).size !== responseIds.length || responseIds.some((id) => !expectedIds.has(id))) {
              interactionError ??= "Hermes clarification response contained duplicate or unknown questions.";
            } else {
              answers = inputQuestions.flatMap(({ id, providerQuestionId, multiSelect }) => {
                const value = selectedAnswer(decision, id, choiceMaps.get(id) ?? new Map(), multiSelect);
                return value === null ? [] : [{ questionId: providerQuestionId, value: safeText(value, secrets, 2_000) }];
              });
            }
          } else if (decision.status === "rejected" || decision.status === "cancelled") {
            clarificationStatus = "cancelled";
            interactionError ??= "Hermes clarification was cancelled before an answer was submitted.";
          } else {
            interactionError ??= "Hermes clarification was not resolved before the request expired.";
          }
        }
      } else if (input.signal?.aborted) {
        clarificationStatus = "cancelled";
        interactionError ??= "Hermes clarification was cancelled before an answer was submitted.";
      } else {
        clarificationStatus = "unavailable";
        interactionError ??= "Hermes clarification cannot be collected through the available Rudder interaction contract.";
      }
    } catch {
      interactionError ??= "Hermes clarification could not be resolved through Rudder.";
      clarificationStatus = "unresolved";
    }
    if (answers.length === 0 || (hasExplicitQuestions && answers.length !== inputQuestions.length)) {
      if (!interactionError && clarificationStatus === "unresolved") {
        interactionError = "Hermes clarification response did not answer every required question.";
      }
      await cancelClarification();
      return;
    }
    if (hasExplicitQuestions) {
      for (const answer of answers) {
        await requestInteractionResponse("clarify.respond", {
          session_id: selectedSessionId,
          request_id: requestId,
          question_id: answer.questionId,
          answer: answer.value,
        });
      }
    } else {
      await requestInteractionResponse("clarify.respond", { session_id: selectedSessionId, request_id: requestId, answer: answers[0]!.value });
    }
    clarificationStatus = "resolved";
    await writeRunLogEvent(event.type, { requestId, status: "resolved", answerCount: answers.length });
  };

  const handleEvent = (event: HermesProductRpcEvent) => {
    if (event.type === "gateway.ready") {
      gatewayReady.resolve(undefined);
      return;
    }
    if (!selectedSessionId || event.sessionId !== selectedSessionId) return;
    const safeEvent: HermesProductRpcEvent = {
      ...event,
      payload: safeEventPayload(event.payload, secrets),
    };
    if (["message.start", "message.complete", "session.info"].includes(event.type) && eventSequence.length < 1_000) eventSequence.push(safeEvent);
    if (event.type === "secret.request" || event.type === "sudo.request") {
      const kind: AgentRuntimeTransientInputKind = event.type === "secret.request" ? "secret" : "sudo";
      const eventType = event.type;
      const requestId = text(event.payload.request_id ?? event.payload.requestId) || null;
      const task = respondSensitiveInput(kind, requestId ?? "").catch(() => {
        sensitiveInputError ??= `Hermes ${kind} input could not be resolved; Rudder could not confirm cancellation of the native request.`;
        sensitiveInputCancellationFailed = true;
        sensitiveInputOutcomes.push({ kind, status: "failed" });
        queueRunLogEvent(eventType, {
          requestId,
          status: "failed",
          reason: "transient_input_failed",
        });
      });
      interactionTasks.add(task);
      sensitiveInputTasks.add(task);
      void task.finally(() => {
        interactionTasks.delete(task);
        sensitiveInputTasks.delete(task);
      });
      return;
    }
    if (event.type === "secret.expire" || event.type === "sudo.expire") {
      const kind: AgentRuntimeTransientInputKind = event.type === "secret.expire" ? "secret" : "sudo";
      const requestId = text(event.payload.request_id ?? event.payload.requestId);
      if (requestId) pendingSensitiveInputs.get(`${kind}:${requestId}`)?.interrupt({ status: "provider_expired" });
      queueRunLogEvent(event.type, { requestId: requestId || null, status: "expired" });
      return;
    }
    if (event.type === "approval.request") {
      const task = respondApproval(event).catch(() => {
        approvalError ??= "Hermes approval response failed.";
      });
      interactionTasks.add(task);
      void task.finally(() => interactionTasks.delete(task));
      return;
    }
    if (event.type === "clarify.request") {
      const task = respondClarify(event).catch(() => {
        interactionError ??= "Hermes clarification response failed.";
      });
      interactionTasks.add(task);
      void task.finally(() => interactionTasks.delete(task));
      return;
    }
    if (event.type.endsWith(".expire")) {
      queueRunLogEvent(event.type, { requestId: text(event.payload.request_id) || null, status: "expired" });
      return;
    }
    if (event.type === "message.complete") {
      lastComplete = safeEvent.payload;
      maybeSettleTurn();
      queueRunLogEvent(event.type, safeEvent.payload);
    } else if (event.type === "session.info" && safeEvent.payload.running === false) {
      modelFromSession = text(safeEvent.payload.model) || modelFromSession;
      maybeSettleTurn();
      queueRunLogEvent(event.type, { running: false, model: safeText(safeEvent.payload.model, secrets, 120), provider: safeText(safeEvent.payload.provider, secrets, 120) });
    } else if (event.type === "error") {
      interactionError ??= safeText(safeEvent.payload.message, secrets, 1_000) || "Hermes Product Gateway reported an error.";
      queueRunLogEvent(event.type, { message: interactionError });
    } else {
      queueRunLogEvent(event.type, safeEvent.payload);
    }
  };

  function maybeSettleTurn() {
    if (!promptAccepted || !lastComplete) return;
    const relevant = eventSequence.slice(submittedAtSequence);
    let startAfter = -1;
    if (queuedSubmit) {
      const priorComplete = relevant.findIndex((event) => event.type === "message.complete");
      if (priorComplete < 0) return;
      const nextStart = relevant.findIndex((event, index) => index > priorComplete && event.type === "message.start");
      if (nextStart < 0) return;
      startAfter = nextStart;
    } else {
      startAfter = relevant.findIndex((event) => event.type === "message.start");
      if (startAfter < 0) return;
    }
    const completeIndex = relevant.findIndex((event, index) => index > startAfter && event.type === "message.complete");
    if (completeIndex < 0) return;
    const idleAfter = relevant.slice(completeIndex + 1).some((event) => event.type === "session.info" && event.payload.running === false);
    if (idleAfter) {
      cancelPendingSensitiveInputs("timed_out");
      turnSettledObserved = true;
      const status = text(lastComplete.status) || "unknown";
      stopConfirmed = stopRequested && status === "interrupted";
      turnSettled.resolve({ payload: lastComplete, status });
    }
  }

  const createClient = input.createClient ?? (async (args) => createHermesNativeRpcClient(
    args.profile,
    args.onNotification,
    async () => ({}),
    args.onSpawn,
  ));
  const readHistoryTail = input.readHistoryTail ?? readProductRpcHistoryTail;
  const readBoundary = async (): Promise<HermesProductRpcTranscriptBoundary> => {
    if (!sessionId) return unknownTranscriptBoundary("", "Hermes Product Gateway did not establish a native session.");
    const after = await readHistoryTail(profile, sessionId, input.timeoutMs, input.signal).catch(() => null);
    return deriveHermesProductRpcTranscriptBoundary({
      sessionId,
      historyProfileAvailable: historyProfile(profile) !== null,
      before: historyBefore,
      after,
      lockedTailRowId: historyFenceTailRowId,
      historyFenceHeldThroughLease: historyFenceTailMatches && historyFenceLeaseProven,
      promptAcceptanceProven,
    });
  };

  try {
    if (!providerVersionSupported(profile)) {
      throw new Error(hermesProductRpcProfileEvidence(profile).reason);
    }
    await validateLaunchProfile(profile);
    if (sessionId) {
      if (!sessionParams) throw new Error("Hermes Product Gateway resume requires persisted native session identity.");
      const rejection = validateHermesProductRpcSession({ sessionId, sessionParams, profile, workspace: input.workspace });
      if (rejection) throw new Error(rejection);
    }
    if (input.signal?.aborted) throw new Error("Hermes Product Gateway execution was cancelled before session submission.");

    const launchProfile = rpcProfile(profile);
    const activeClient = await createClient({
      profile: launchProfile,
      onNotification: (method, params) => {
        const event = parseGatewayEvent(method, params);
        if (event) handleEvent(event);
      },
      onSpawn: async (meta) => {
        gatewayPid = meta.pid;
        await input.onSpawn?.(meta);
      },
    });
    client = activeClient;
    await withTimeout(gatewayReady.promise, Math.min(input.timeoutMs, GATEWAY_READY_TIMEOUT_MS), "Hermes Product Gateway did not emit gateway.ready.");
    const ping = record(await activeClient.request("ping", {}, Math.min(input.timeoutMs, 5_000)));
    if (ping?.pong !== true) throw new Error("Hermes Product Gateway ping did not confirm the installed RPC service.");
    const capabilities = record(await activeClient.request("gateway.capabilities", {}, Math.min(input.timeoutMs, 5_000)));
    if (capabilities?.per_session_exclusive_submit !== true) {
      throw new Error("Hermes Product Gateway must confirm per_session_exclusive_submit=true before accepting session ownership.");
    }

    if (sessionId) {
      const resumed = record(await activeClient.request("session.resume", { session_id: sessionId, lazy: true }, input.timeoutMs));
      gatewaySessionId = text(resumed?.session_id);
      const resumedSessionKey = text(resumed?.session_key ?? resumed?.stored_session_id);
      if (!resumed || !gatewaySessionId || resumedSessionKey !== sessionId || resumed.error) {
        throw new Error("Hermes Product Gateway did not resume the explicitly bound native session.");
      }
      if (resumed.auto_continue) {
        stopRequested = true;
        await activeClient.request("session.interrupt", { session_id: gatewaySessionId }, Math.min(input.timeoutMs, 5_000)).catch(() => {});
        throw new Error("Hermes Product Gateway scheduled an automatic continuation while resuming; the session was interrupted and no new input was submitted.");
      }
      if (typeof resumed.running !== "boolean") {
        throw new Error("Hermes Product Gateway session.resume did not report the session running state.");
      }
      if (resumed.running) throw new Error("Hermes Product Gateway session is already running; refusing to attach a second input owner.");
    } else {
      const created = record(await activeClient.request("session.create", {
        cwd: profile.cwd,
        ...(text(input.model) ? { model: text(input.model) } : {}),
      }, input.timeoutMs));
      gatewaySessionId = text(created?.session_id ?? created?.sessionId);
      const storedSessionId = text(created?.stored_session_id ?? created?.session_key);
      if (!gatewaySessionId) throw new Error("Hermes Product Gateway session.create returned no native session_id.");
      if (!storedSessionId) throw new Error("Hermes Product Gateway session.create returned no persisted stored_session_id.");
      sessionId = storedSessionId;
      sessionParams = buildHermesProductRpcSessionParams({ sessionId, profile, workspace: input.workspace });
    }
    selectedSessionId = gatewaySessionId;
    if (!sessionId) throw new Error("Hermes Product Gateway has no persisted session ID for this turn.");
    const controlSessionId = sessionId;
    sessionParams ??= buildHermesProductRpcSessionParams({ sessionId, profile, workspace: input.workspace });
    historyFence = await (input.acquireHistoryFence ?? acquireHermesProductRpcHistoryFence)({
      profile,
      sessionId,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    }).catch(() => null);
    historyFenceTailRowId = historyFence?.tailRowId ?? null;
    historyBefore = await readHistoryTail(
      profile,
      sessionId,
      Math.min(input.timeoutMs, HISTORY_FENCE_MAX_HOLD_MS),
      input.signal,
    ).catch(() => null);
    historyFenceTailMatches = Boolean(
      historyFence?.isHeld()
      && historyBefore?.availability === "available"
      && historyBefore.tailRowId === historyFence.tailRowId,
    );
    if (historyFence && !historyFenceTailMatches) {
      await historyFence.release().catch(() => {});
      historyFence = null;
    }

    const turnId = randomUUID();
    let controlActive = true;
    if (input.controlAttempt) {
      controlLease = await input.controlAttempt.register({
        runtimeType: "hermes_gateway",
        providerThreadId: controlSessionId,
        providerTurnId: turnId,
        capabilities: { steer: "native", interrupt: "native" },
        async steer(controlInput) {
          if (!controlActive || !client || !gatewaySessionId) return { disposition: "closing", reason: "Hermes Product Gateway turn is closed." };
          if (controlInput.media?.length) return { disposition: "unsupported", reason: "Hermes Product Gateway session.redirect does not accept media attachments." };
          try {
            const response = record(await activeClient.request("session.redirect", { session_id: gatewaySessionId, text: controlInput.text }, Math.min(input.timeoutMs, 10_000)));
            if (response?.status === "redirected") {
              return { disposition: "accepted_current", providerThreadId: controlSessionId, providerTurnId: turnId };
            }
            return { disposition: "unsupported", reason: "Hermes Product Gateway did not confirm session.redirect for the active turn." };
          } catch (error) {
            const rpcCode = hermesNativeRpcErrorCode(error);
            return rpcCode === 4010 || rpcCode === -32601
              ? { disposition: "unsupported", reason: "The installed Hermes Product Gateway does not support active-turn redirect for this model/session." }
              : { disposition: "acceptance_unknown", providerThreadId: controlSessionId, providerTurnId: turnId, reason: "Hermes Product Gateway session.redirect acknowledgement was not received." };
          }
        },
        async interrupt() {
          if (!controlActive || !client || !gatewaySessionId) return "unverified";
          const response = await interruptSession();
          if (text(response?.status) === "interrupted") return "waiting_safe_boundary";
          if (text(response?.status) === "not_interrupted") return "acknowledged";
          return "unverified";
        },
        async dispose() { controlActive = false; },
      });
    }

    const abortHandler = () => {
      cancelPendingSensitiveInputs("aborted");
      if (!client || !gatewaySessionId || !promptSubmissionStarted) return;
      void Promise.allSettled([...sensitiveInputTasks]).then(() => interruptSession());
    };
    if (input.signal?.aborted) throw new Error("Hermes Product Gateway execution was cancelled before prompt submission.");
    input.signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      submittedAtSequence = eventSequence.length;
      promptSubmissionStarted = true;
      const submissionPromise = Promise.resolve().then(() => activeClient.request("prompt.submit", {
        session_id: gatewaySessionId,
        text: input.prompt,
        queued: true,
      }, input.timeoutMs)).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const leaseWaitController = new AbortController();
      let submission = await Promise.race([
        submissionPromise.then((outcome) => ({ kind: "response" as const, outcome })),
        (async () => {
          if (!historyFence || !historyFenceTailMatches || gatewayPid === null || !sessionId || !gatewaySessionId) {
            return { kind: "lease" as const, proven: false };
          }
          const abortWait = () => leaseWaitController.abort();
          if (input.signal?.aborted) leaseWaitController.abort();
          else input.signal?.addEventListener("abort", abortWait, { once: true });
          try {
            const proven = await (input.waitForSessionLease ?? waitForHermesProductRpcLease)({
              profile,
              sessionId,
              gatewaySessionId,
              gatewayPid,
              timeoutMs: Math.min(input.timeoutMs, HISTORY_FENCE_MAX_HOLD_MS),
              signal: leaseWaitController.signal,
            });
            return { kind: "lease" as const, proven };
          } finally {
            input.signal?.removeEventListener("abort", abortWait);
          }
        })(),
      ]);
      if (submission.kind === "response") leaseWaitController.abort();
      if (submission.kind === "lease" && submission.proven && historyFence?.isHeld()) {
        historyFenceLeaseProven = true;
        await historyFence.release();
        historyFence = null;
        submission = await submissionPromise.then((outcome) => ({ kind: "response" as const, outcome }));
      } else if (submission.kind === "response") {
        if (
          submission.outcome.ok
          && historyFence?.isHeld()
          && historyFenceTailMatches
          && gatewayPid !== null
          && sessionId
          && gatewaySessionId
        ) {
          const response = record(submission.outcome.value);
          historyFenceLeaseProven = Boolean(
            ["streaming", "queued"].includes(text(response?.status))
            && await hermesProductRpcLeaseMatches({
              profile,
              sessionId,
              gatewaySessionId,
              gatewayPid,
              timeoutMs: Math.min(input.timeoutMs, 100),
              signal: input.signal,
            })
            && historyFence.isHeld(),
          );
        }
        await historyFence?.release().catch(() => {});
        historyFence = null;
      } else {
        await historyFence?.release().catch(() => {});
        historyFence = null;
        submission = await submissionPromise.then((outcome) => ({ kind: "response" as const, outcome }));
      }
      if (submission.kind !== "response") throw new Error("Hermes Product Gateway submission state was not reconciled.");
      if (!submission.outcome.ok) throw submission.outcome.error;
      const accepted = record(submission.outcome.value);
      if (!accepted || !["streaming", "queued"].includes(text(accepted.status))) {
        throw new Error(`Hermes Product Gateway prompt.submit returned unexpected status ${text(accepted?.status) || "unknown"}.`);
      }
      queuedSubmit = accepted.status === "queued";
      promptAccepted = true;
      promptAcceptanceProven = accepted.status === "streaming";
      maybeSettleTurn();
      const terminalResult = await withTimeout(
        waitForApprovalOrAbort(turnSettled.promise, input.signal),
        input.timeoutMs,
        "Hermes Product Gateway turn timed out before terminal message.complete and settled session.info.",
      );
      let terminal: { payload: JsonRecord; status: string };
      if (terminalResult === "aborted") {
        cancelPendingSensitiveInputs("aborted");
        await Promise.allSettled([...sensitiveInputTasks]);
        await interruptSession();
        const settledAfterInterrupt = await Promise.race([
          turnSettled.promise.then((value) => ({ value, settled: true as const })),
          new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), STOP_RECONCILIATION_MS)),
        ]);
        if (!settledAfterInterrupt.settled) {
          await flushRunLogWrites();
          const transcriptBoundary = unknownTranscriptBoundary(sessionId, "Hermes Product Gateway stop did not reach a settled terminal turn.");
          return {
            exitCode: 1,
            signal: "SIGTERM",
            timedOut: false,
            errorCode: sensitiveInputFailureCode() ?? "hermes_product_rpc_cancel_unverified",
            errorMessage: sensitiveInputError ?? "Hermes stop was requested but terminal state was not verified.",
            ...(sessionId ? { sessionId, sessionDisplayId: sessionId } : {}),
            ...(sessionParams ? { sessionParams } : {}),
            resultJson: {
              nativeSession: true,
              transport: HERMES_PRODUCT_RPC_TRANSPORT,
              sessionId,
              transcriptBoundary,
              transcriptSupplement: runTranscriptSupplement({
                settled: false,
                eventCount: recordedEventCount,
                truncated: eventsTruncated,
                writeFailed: runLogWriteFailed,
              }),
              backend: "native_product_rpc",
              control: { interruptRequested: interruptAttempted, stopConfirmed },
              eventCount: recordedEventCount,
              interactions: {
                sensitiveInputCancelled: sensitiveInputOutcomes.length > 0
                  && sensitiveInputOutcomes.every((entry) => entry.status !== "provided")
                  && !sensitiveInputCancellationFailed,
                sensitiveInputCancellationFailed,
                sensitiveInputKinds: [...sensitiveInputKinds],
                sensitiveInputStatuses: sensitiveInputOutcomes,
                sensitiveInputError,
              },
            },
          };
        }
        terminal = settledAfterInterrupt.value;
      } else {
        terminal = terminalResult;
      }
      if (interactionTasks.size > 0) await Promise.allSettled([...interactionTasks]);
      await flushRunLogWrites();
      const transcriptBoundary = await readBoundary();
      const output = safeText(terminal.payload.text, secrets, MAX_EVENT_TOTAL_BYTES);
      const providerStatus = text(terminal.payload.status) || terminal.status;
      const terminalError = safeText(terminal.payload.error ?? terminal.payload.failure_reason, secrets, 1_000);
      const providerCompleted = providerStatus === "complete" || providerStatus === "settled";
      const outputPresent = Boolean(output.trim());
      const completed = providerCompleted && outputPresent;
      const cancelled = providerStatus === "interrupted" || interruptAttempted || input.signal?.aborted;
      const inputFailureCode = sensitiveInputFailureCode();
      const resultJson: JsonRecord = {
        nativeSession: true,
        transport: HERMES_PRODUCT_RPC_TRANSPORT,
        sessionId,
        transcriptBoundary,
        transcriptSupplement: runTranscriptSupplement({
          settled: turnSettledObserved,
          eventCount: recordedEventCount,
          truncated: eventsTruncated,
          writeFailed: runLogWriteFailed,
        }),
        backend: "native_product_rpc",
        providerStatus,
        eventCount: recordedEventCount,
        control: { interruptRequested: interruptAttempted, stopConfirmed },
        interactions: {
          sensitiveInputCancelled: sensitiveInputOutcomes.length > 0
            && sensitiveInputOutcomes.every((entry) => entry.status !== "provided")
            && !sensitiveInputCancellationFailed,
          sensitiveInputCancellationFailed,
          sensitiveInputKinds: [...sensitiveInputKinds],
          sensitiveInputStatuses: sensitiveInputOutcomes,
          sensitiveInputError,
          clarificationStatus,
          approvalStatus,
          clarificationError: interactionError,
          approvalError,
        },
      };
      await controlLease?.release();
      controlLease = null;
      return {
        exitCode: completed && !cancelled && !interactionError && !approvalError && !sensitiveInputError ? 0 : 1,
        signal: cancelled ? "SIGTERM" : null,
        timedOut: false,
        sessionId,
        sessionParams,
        sessionDisplayId: sessionId,
        provider: "hermes",
        model: text(terminal.payload.model) || modelFromSession || text(input.model) || null,
        ...(usageFrom(terminal.payload.usage) ? { usage: usageFrom(terminal.payload.usage) } : {}),
        ...(output ? { summary: output } : {}),
        resultJson,
        ...(!completed || cancelled || interactionError || approvalError || sensitiveInputError ? {
          errorCode: inputFailureCode
            ?? (approvalError
              ? "hermes_product_rpc_approval_unresolved"
              : interactionError
                ? "hermes_product_rpc_interaction_unresolved"
                : cancelled
                  ? providerStatus === "interrupted"
                    ? "hermes_product_rpc_interrupted"
                    : "hermes_product_rpc_cancel_unverified"
                  : !providerCompleted
                    ? "hermes_product_rpc_turn_failed"
                    : !outputPresent
                      ? "hermes_product_rpc_empty_output"
                      : "hermes_product_rpc_turn_failed"),
          errorMessage: sensitiveInputError
            ?? approvalError ?? interactionError ?? (terminalError || (cancelled
              ? providerStatus === "interrupted"
                ? "Hermes Product Gateway turn ended with interrupted status."
                : stopRequested
                  ? `Hermes Product Gateway stop was requested but not confirmed (provider status: ${providerStatus}).`
                  : "Hermes Product Gateway execution was cancelled."
                    : !providerCompleted
                      ? `Hermes Product Gateway turn ended with ${providerStatus}.`
                      : !outputPresent
                        ? "Hermes Product Gateway completed without assistant text."
                      : "Hermes Product Gateway turn did not complete successfully.")),
        } : {}),
      };
    } finally {
      input.signal?.removeEventListener("abort", abortHandler);
      controlLease?.release().catch(() => {});
      controlLease = null;
    }
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : String(error), secrets, 2_000);
    const timedOut = /timed out|timeout/iu.test(message);
    const observedTurnStart = eventSequence.slice(submittedAtSequence).some((event) => event.type === "message.start");
    if (secretRequestObserved) {
      cancelPendingSensitiveInputs(timedOut ? "timed_out" : "aborted");
      await Promise.allSettled([...sensitiveInputTasks]);
    }
    if (promptSubmissionStarted && (observedTurnStart || secretRequestObserved) && sessionId && client && !interruptAttempted) {
      await interruptSession();
      await Promise.race([turnSettled.promise, new Promise((resolve) => setTimeout(resolve, STOP_RECONCILIATION_MS))]);
    }
    const cancelUnverified = interruptAttempted && !turnSettledObserved;
    await controlLease?.release().catch(() => {});
    await flushRunLogWrites();
    const transcriptBoundary = promptSubmissionStarted && turnSettledObserved
      ? await readBoundary()
      : unknownTranscriptBoundary(sessionId ?? "", "Hermes Product Gateway turn did not produce settled terminal evidence.");
    const inputFailureCode = sensitiveInputFailureCode();
    return {
      exitCode: 1,
      signal: stopRequested ? "SIGTERM" : null,
      timedOut,
      submissionPhase: promptAccepted ? "accepted" : promptSubmissionStarted ? "indeterminate" : "pre_submission",
      errorMessage: sensitiveInputError ?? (cancelUnverified ? "Hermes stop was requested but terminal state was not verified." : message),
      errorCode: inputFailureCode ?? (cancelUnverified ? "hermes_product_rpc_cancel_unverified" : timedOut ? "hermes_product_rpc_timeout" : "hermes_product_rpc_failed"),
      ...(sessionId ? { sessionId, sessionDisplayId: sessionId } : {}),
      ...(sessionParams ? { sessionParams } : {}),
      resultJson: {
        nativeSession: true,
        transport: HERMES_PRODUCT_RPC_TRANSPORT,
        sessionId,
        transcriptBoundary,
        transcriptSupplement: runTranscriptSupplement({
          settled: turnSettledObserved,
          eventCount: recordedEventCount,
          truncated: eventsTruncated,
          writeFailed: runLogWriteFailed,
        }),
        backend: "native_product_rpc",
        control: { interruptRequested: interruptAttempted, stopConfirmed },
        eventCount: recordedEventCount,
        interactions: {
          sensitiveInputCancelled: sensitiveInputOutcomes.length > 0
            && sensitiveInputOutcomes.every((entry) => entry.status !== "provided")
            && !sensitiveInputCancellationFailed,
          sensitiveInputCancellationFailed,
          sensitiveInputKinds: [...sensitiveInputKinds],
          sensitiveInputStatuses: sensitiveInputOutcomes,
          sensitiveInputError,
        },
      },
    };
  } finally {
    secrets.splice(configuredSecretCount);
    await historyFence?.release().catch(() => {});
    await client?.close().catch(() => {});
  }
}
