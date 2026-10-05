import fs from "node:fs/promises";

export const HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV = "RUDDER_HERMES_PRODUCT_RPC_READY_PATH";
export const HERMES_PRODUCT_RPC_MCP_READY_NONCE_ENV = "RUDDER_HERMES_PRODUCT_RPC_READY_NONCE";
export const HERMES_PRODUCT_RPC_MCP_ENV_KEYS_ENV = "RUDDER_HERMES_PRODUCT_RPC_ENV_KEYS";
export const HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH_ENV = "RUDDER_HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH";
export const HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH_ENV = "RUDDER_HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH";
export const HERMES_PRODUCT_RPC_SPAN_ROWS_PATH_ENV = "RUDDER_HERMES_PRODUCT_RPC_SPAN_ROWS_PATH";
export const HERMES_PRODUCT_RPC_SPAN_NONCE_ENV = "RUDDER_HERMES_PRODUCT_RPC_SPAN_NONCE";
export const HERMES_PRODUCT_RPC_SPAN_ROLE_ENV = "RUDDER_HERMES_PRODUCT_RPC_SPAN_ROLE";

export const HERMES_PRODUCT_RPC_SPAN_COMPUTE_HOST_SITE_CUSTOMIZE_SOURCE = String.raw`
import json
import os
import threading

ROLE = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_ROLE_ENV}", "")
if ROLE == "compute_host":
    CONFIG_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH_ENV}", "")
    BASELINE_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH_ENV}", "")
    ROWS_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_ROWS_PATH_ENV}", "")
    NONCE = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_NONCE_ENV}", "")
    LOCK = threading.Lock()

    def _record_span_rows(session_id, row_ids):
        if not (CONFIG_PATH and BASELINE_PATH and ROWS_PATH and NONCE):
            return
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as stream:
                config = json.load(stream)
            if (not isinstance(config, dict) or config.get("version") != 1
                    or config.get("nonce") != NONCE or config.get("sessionId") != session_id):
                return
            with open(BASELINE_PATH, "r", encoding="utf-8") as stream:
                lines = [line for line in stream.read().splitlines() if line]
            if len(lines) != 1:
                return
            baseline = json.loads(lines[0])
            if (not isinstance(baseline, dict) or baseline.get("status") != "ready"
                    or baseline.get("nonce") != NONCE or baseline.get("sessionId") != session_id):
                return
            tail = baseline.get("tailRowId")
            ids = sorted({row_id for row_id in row_ids
                          if isinstance(row_id, int) and not isinstance(row_id, bool)
                          and row_id > (tail if isinstance(tail, int) else 0)})
            if not ids:
                return
            receipt = {
                "version": 1, "kind": "rows", "nonce": NONCE,
                "sessionId": session_id, "pid": os.getpid(),
                "parentPid": os.getppid(), "processRole": "compute_host", "rowIds": ids,
            }
            payload = (json.dumps(receipt, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
            with LOCK:
                descriptor = os.open(ROWS_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    if os.write(descriptor, payload) != len(payload):
                        raise OSError("short Hermes compute-host span receipt write")
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        except Exception:
            # The Host fails closed when a committed row has no authenticated receipt.
            pass

    try:
        import hermes_bootstrap
        hermes_bootstrap.harden_import_path()
        from hermes_state import SessionDB

        _original_append_message = SessionDB.append_message
        _original_append_messages_batch = SessionDB.append_messages_batch

        def _captured_append_message(self, *args, **kwargs):
            session_id = kwargs.get("session_id", args[0] if args else "")
            result = _original_append_message(self, *args, **kwargs)
            _record_span_rows(str(session_id or ""), [result])
            return result

        def _captured_append_messages_batch(self, *args, **kwargs):
            session_id = kwargs.get("session_id", args[0] if args else "")
            messages = kwargs.get("messages", args[1] if len(args) > 1 else [])
            result = _original_append_messages_batch(self, *args, **kwargs)
            row_ids = [message.get("_row_id") for message in messages
                       if isinstance(message, dict) and isinstance(message.get("_row_id"), int)]
            _record_span_rows(str(session_id or ""), row_ids)
            return result

        SessionDB.append_message = _captured_append_message
        SessionDB.append_messages_batch = _captured_append_messages_batch
    except Exception:
        # Import or patch failure leaves this Run's transcript attribution unknown.
        pass
`;

const READY_RECEIPT_VERSION = 1;
const RUDDER_SERVER_NAME = "rudder-tools";
const RUDDER_TOOL_PREFIX = "mcp__rudder_tools__rudder_";
const REQUIRED_RUDDER_TOOL = "mcp__rudder_tools__rudder_agent_me";
const RUDDER_TOOL_NAME_PATTERN = /^mcp__rudder_tools__rudder_[A-Za-z0-9_]+$/u;

export type HermesProductRpcMcpReadyReceipt = {
  toolNames: string[];
  status: "ready";
};

export type HermesProductRpcMcpOverlay = {
  home: string;
  env: Record<string, string>;
  readyReceiptPath: string | null;
  readyNonce: string | null;
  spanCaptureConfigPath: string;
  spanCaptureBaselinePath: string;
  spanCaptureRowsPath: string;
  spanCaptureNonce: string;
  cleanup(): Promise<void>;
};

export const HERMES_PRODUCT_RPC_BOOTSTRAP_SOURCE = String.raw`
import json
import os
import re
import sqlite3
import threading
from pathlib import Path

READY_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV}", "")
READY_NONCE = os.environ.pop("${HERMES_PRODUCT_RPC_MCP_READY_NONCE_ENV}", "")
ENV_KEYS = json.loads(os.environ.pop("${HERMES_PRODUCT_RPC_MCP_ENV_KEYS_ENV}", "[]"))
SPAN_CONFIG_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH_ENV}", "")
SPAN_BASELINE_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH_ENV}", "")
SPAN_ROWS_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_ROWS_PATH_ENV}", "")
SPAN_NONCE = os.environ.pop("${HERMES_PRODUCT_RPC_SPAN_NONCE_ENV}", "")
# Match tui_gateway.entry's import hardening before importing Hermes modules here.
import hermes_bootstrap
hermes_bootstrap.harden_import_path()
SERVER_NAME = "rudder-tools"
TOOL_PREFIX = "mcp__rudder_tools__rudder_"
REQUIRED_TOOL = "mcp__rudder_tools__rudder_agent_me"
TOOL_PATTERN = re.compile(r"^mcp__rudder_tools__rudder_[A-Za-z0-9_]+$")
_SPAN_RECEIPT_LOCK = threading.Lock()

def _span_context():
    if not SPAN_CONFIG_PATH or not SPAN_NONCE:
        return None
    try:
        with open(SPAN_CONFIG_PATH, "r", encoding="utf-8") as stream:
            value = json.load(stream)
        if (not isinstance(value, dict) or value.get("version") != 1
                or value.get("nonce") != SPAN_NONCE
                or not isinstance(value.get("sessionId"), str) or not value["sessionId"]):
            return None
        return value
    except Exception:
        return None

def _append_span_receipt(target_path, value):
    if not target_path:
        return
    try:
        payload = (json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        with _SPAN_RECEIPT_LOCK:
            descriptor = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                if os.write(descriptor, payload) != len(payload):
                    raise OSError("short Hermes span receipt write")
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except Exception:
        # The Host fails closed when the baseline or any committed row is absent.
        pass

def _write_span_baseline(session):
    context = _span_context()
    session_id = str(session.get("session_key") or "") if isinstance(session, dict) else ""
    if not context or session_id != context["sessionId"]:
        return
    receipt = {
        "version": 1, "kind": "baseline", "nonce": SPAN_NONCE,
        "sessionId": session_id, "pid": os.getpid(), "processRole": "gateway", "status": "unknown",
    }
    try:
        home = Path(os.environ.get("HERMES_HOME") or "").resolve()
        database = home / "state.db"
        uri = database.as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=1.0) as connection:
            tail = connection.execute(
                "SELECT MAX(id) FROM messages WHERE session_id = ?", (session_id,)).fetchone()
            exists = connection.execute(
                "SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,)).fetchone()
        tail_row_id = tail[0] if tail else None
        if tail_row_id is not None and (isinstance(tail_row_id, bool) or not isinstance(tail_row_id, int) or tail_row_id < 1):
            raise RuntimeError("invalid Hermes SessionDB tail")
        receipt.update(status="ready", tailRowId=tail_row_id, sessionExists=exists is not None)
    except Exception as error:
        receipt["errorCode"] = type(error).__name__
    try:
        payload = (json.dumps(receipt, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        with _SPAN_RECEIPT_LOCK:
            descriptor = os.open(SPAN_BASELINE_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                if os.write(descriptor, payload) != len(payload):
                    raise OSError("short Hermes span baseline write")
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except FileExistsError:
        # One baseline per Run; inline fallback after a failed isolated dispatch reuses it.
        pass
    except Exception:
        pass

def _span_baseline(session_id):
    context = _span_context()
    if not context or context["sessionId"] != session_id or not SPAN_BASELINE_PATH:
        return None
    try:
        with open(SPAN_BASELINE_PATH, "r", encoding="utf-8") as stream:
            lines = [line for line in stream.read().splitlines() if line]
        if len(lines) != 1:
            return None
        value = json.loads(lines[0])
        if (not isinstance(value, dict) or value.get("version") != 1
                or value.get("kind") != "baseline" or value.get("status") != "ready"
                or value.get("nonce") != SPAN_NONCE or value.get("sessionId") != session_id
                or value.get("pid") != os.getpid()):
            return None
        return value
    except Exception:
        return None

def _record_span_rows(session_id, row_ids):
    baseline = _span_baseline(session_id)
    if baseline is None:
        return
    tail = baseline.get("tailRowId")
    ids = sorted({row_id for row_id in row_ids
                  if isinstance(row_id, int) and not isinstance(row_id, bool)
                  and row_id > (tail if isinstance(tail, int) else 0)})
    if ids:
        _append_span_receipt(SPAN_ROWS_PATH, {
            "version": 1, "kind": "rows", "nonce": SPAN_NONCE,
            "sessionId": session_id, "pid": os.getpid(), "parentPid": os.getppid(),
            "processRole": "gateway", "rowIds": ids,
        })

def _install_span_capture():
    if not SPAN_CONFIG_PATH or not SPAN_BASELINE_PATH or not SPAN_ROWS_PATH or not SPAN_NONCE:
        return
    try:
        from hermes_state import SessionDB
    except Exception:
        return
    original_append_message = SessionDB.append_message
    original_append_messages_batch = SessionDB.append_messages_batch

    def _captured_append_message(self, *args, **kwargs):
        session_id = kwargs.get("session_id", args[0] if args else "")
        result = original_append_message(self, *args, **kwargs)
        _record_span_rows(str(session_id or ""), [result])
        return result

    def _captured_append_messages_batch(self, *args, **kwargs):
        session_id = kwargs.get("session_id", args[0] if args else "")
        messages = kwargs.get("messages", args[1] if len(args) > 1 else [])
        result = original_append_messages_batch(self, *args, **kwargs)
        row_ids = [message.get("_row_id") for message in messages
                   if isinstance(message, dict) and isinstance(message.get("_row_id"), int)]
        _record_span_rows(str(session_id or ""), row_ids)
        return result

    SessionDB.append_message = _captured_append_message
    SessionDB.append_messages_batch = _captured_append_messages_batch

def _install_gateway_span_capture(server):
    if not SPAN_CONFIG_PATH or not SPAN_BASELINE_PATH or not SPAN_ROWS_PATH or not SPAN_NONCE:
        return
    original_persist_session_row = server._persist_session_row_for_submit

    def _captured_persist_session_row(rid, session):
        result = original_persist_session_row(rid, session)
        if result is None:
            _write_span_baseline(session)
        return result

    server._persist_session_row_for_submit = _captured_persist_session_row

    original_submit_to_compute_host = server._submit_prompt_to_compute_host

    def _captured_submit_to_compute_host(rid, session_id, session, *args, **kwargs):
        _write_span_baseline(session)
        return original_submit_to_compute_host(rid, session_id, session, *args, **kwargs)

    server._submit_prompt_to_compute_host = _captured_submit_to_compute_host

    from tui_gateway.host_supervisor import HostSupervisor
    original_spawn_compute_host = HostSupervisor._spawn_locked

    def _captured_spawn_compute_host(self, *args, **kwargs):
        original_env = self.env
        self.env = {
            **(original_env or {}),
            "${HERMES_PRODUCT_RPC_SPAN_ROLE_ENV}": "compute_host",
            "${HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH_ENV}": SPAN_CONFIG_PATH,
            "${HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH_ENV}": SPAN_BASELINE_PATH,
            "${HERMES_PRODUCT_RPC_SPAN_ROWS_PATH_ENV}": SPAN_ROWS_PATH,
            "${HERMES_PRODUCT_RPC_SPAN_NONCE_ENV}": SPAN_NONCE,
        }
        try:
            return original_spawn_compute_host(self, *args, **kwargs)
        finally:
            self.env = original_env

    HostSupervisor._spawn_locked = _captured_spawn_compute_host

def _write_receipt(status, tool_names=None, error_code=None):
    if not READY_PATH or not READY_NONCE:
        return
    target = Path(READY_PATH)
    temporary = target.with_name(target.name + "." + READY_NONCE + ".tmp")
    receipt = {
        "version": 1,
        "nonce": READY_NONCE,
        "serverName": SERVER_NAME,
        "status": status,
        "toolNames": tool_names or [],
    }
    if error_code:
        receipt["errorCode"] = error_code
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(receipt, stream, separators=(",", ":"), allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)

def _discover_rudder_tools(*args, **kwargs):
    try:
        returned_names = _original_discover_rudder_tools(*args, **kwargs)
        from tools.mcp_tool_common import _core

        returned = set(returned_names or [])
        with _core._lock:
            registered = sorted(
                name for name, server_name in _core._mcp_tool_server_names.items()
                if server_name == SERVER_NAME and name in returned
            )
        tool_names = [name for name in registered if TOOL_PATTERN.fullmatch(name)]
        if not tool_names:
            _write_receipt("failed", error_code="no_typed_rudder_tools_registered")
        elif REQUIRED_TOOL not in tool_names:
            _write_receipt("failed", tool_names, error_code="rudder_agent_me_not_registered")
        else:
            _write_receipt("ready", tool_names)
        return returned_names
    except BaseException:
        _write_receipt("failed", error_code="rudder_mcp_discovery_failed")
        raise
    finally:
        for key in ENV_KEYS:
            if isinstance(key, str):
                os.environ.pop(key, None)

import hermes_cli
if getattr(hermes_cli, "__version__", None) != "0.21.0":
    raise RuntimeError("Hermes Product RPC bootstrap is verified only for Hermes 0.21.0")

_install_span_capture()
if READY_PATH and READY_NONCE:
    from hermes_cli import mcp_startup
    from tools import mcp_tool_discovery
    _original_discover_rudder_tools = mcp_tool_discovery.discover_mcp_tools
    mcp_startup.set_mcp_server_filter([SERVER_NAME])
    mcp_tool_discovery.discover_mcp_tools = _discover_rudder_tools
from tui_gateway import entry
from tui_gateway import server
_install_gateway_span_capture(server)
entry.main()
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateReadyReceipt(value: unknown, expectedNonce: string): HermesProductRpcMcpReadyReceipt {
  if (!isRecord(value)
    || value.version !== READY_RECEIPT_VERSION
    || value.nonce !== expectedNonce
    || value.serverName !== RUDDER_SERVER_NAME
    || !Array.isArray(value.toolNames)
    || !value.toolNames.every((name) => typeof name === "string" && RUDDER_TOOL_NAME_PATTERN.test(name))) {
    throw new Error("Hermes Product Gateway returned an invalid Rudder MCP readiness receipt.");
  }
  if (value.status === "failed") {
    const errorCode = typeof value.errorCode === "string" ? value.errorCode : "unknown";
    throw new Error(`Hermes Product Gateway Rudder MCP discovery failed (${errorCode}).`);
  }
  const toolNames = [...new Set(value.toolNames as string[])];
  if (value.status !== "ready"
    || toolNames.length === 0
    || toolNames.length !== value.toolNames.length
    || !toolNames.includes(RUDDER_TOOL_PREFIX + "agent_me")) {
    throw new Error("Hermes Product Gateway did not register a non-empty typed Rudder MCP tool set including rudder_agent_me.");
  }
  return { status: "ready", toolNames };
}

export async function waitForHermesProductRpcMcpReady(input: {
  overlay: Pick<HermesProductRpcMcpOverlay, "readyReceiptPath" | "readyNonce">;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<HermesProductRpcMcpReadyReceipt> {
  const { readyReceiptPath, readyNonce } = input.overlay;
  if (!readyReceiptPath || !readyNonce) {
    throw new Error("Hermes Product Gateway Rudder MCP readiness requires a configured run overlay.");
  }
  const deadline = Date.now() + Math.max(1, input.timeoutMs);
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error("Hermes Product Gateway Rudder MCP readiness was cancelled before prompt submission.");
    const contents = await fs.readFile(readyReceiptPath, "utf8").catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (contents !== null) {
      let receipt: unknown;
      try {
        receipt = JSON.parse(contents);
      } catch {
        throw new Error("Hermes Product Gateway returned an invalid Rudder MCP readiness receipt.");
      }
      return validateReadyReceipt(receipt, readyNonce);
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Hermes Product Gateway did not register typed rudder-tools before the admission deadline; prompt was not submitted.");
}
