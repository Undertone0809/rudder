import fs from "node:fs/promises";

export const HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV = "RUDDER_HERMES_PRODUCT_RPC_READY_PATH";
export const HERMES_PRODUCT_RPC_MCP_READY_NONCE_ENV = "RUDDER_HERMES_PRODUCT_RPC_READY_NONCE";
export const HERMES_PRODUCT_RPC_MCP_ENV_KEYS_ENV = "RUDDER_HERMES_PRODUCT_RPC_ENV_KEYS";

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
  readyReceiptPath: string;
  readyNonce: string;
  cleanup(): Promise<void>;
};

export const HERMES_PRODUCT_RPC_BOOTSTRAP_SOURCE = String.raw`
import json
import os
import re
from pathlib import Path

READY_PATH = os.environ.pop("${HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV}", "")
READY_NONCE = os.environ.pop("${HERMES_PRODUCT_RPC_MCP_READY_NONCE_ENV}", "")
ENV_KEYS = json.loads(os.environ.pop("${HERMES_PRODUCT_RPC_MCP_ENV_KEYS_ENV}", "[]"))
SERVER_NAME = "rudder-tools"
TOOL_PREFIX = "mcp__rudder_tools__rudder_"
REQUIRED_TOOL = "mcp__rudder_tools__rudder_agent_me"
TOOL_PATTERN = re.compile(r"^mcp__rudder_tools__rudder_[A-Za-z0-9_]+$")

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

from hermes_cli import mcp_startup
from tools import mcp_tool_discovery
_original_discover_rudder_tools = mcp_tool_discovery.discover_mcp_tools
mcp_startup.set_mcp_server_filter([SERVER_NAME])
mcp_tool_discovery.discover_mcp_tools = _discover_rudder_tools
from tui_gateway import entry
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
  const deadline = Date.now() + Math.max(1, input.timeoutMs);
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error("Hermes Product Gateway Rudder MCP readiness was cancelled before prompt submission.");
    const contents = await fs.readFile(input.overlay.readyReceiptPath, "utf8").catch((error: unknown) => {
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
      return validateReadyReceipt(receipt, input.overlay.readyNonce);
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Hermes Product Gateway did not register typed rudder-tools before the admission deadline; prompt was not submitted.");
}
