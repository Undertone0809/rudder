import { spawn } from "node:child_process";
import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_MCP_CONTRACT_VERSION,
  RUDDER_MCP_SERVER_NAME,
  type RudderMcpCliCommand,
  type RudderMcpPreflightDiagnosticCode,
  type RudderMcpPreflightResult,
} from "./rudder-mcp.js";

const PREFLIGHT_TIMEOUT_MS = 5_000;

type JsonRpcResponse = {
  id?: string | number | null;
  error?: { message?: unknown };
  result?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function failed(
  command: RudderMcpCliCommand,
  code: RudderMcpPreflightDiagnosticCode,
  message: string,
  partial: Partial<RudderMcpPreflightResult> = {},
): RudderMcpPreflightResult {
  const coreUnavailable = code === "browser_bundle_handshake_failed"
    || code === "browser_bundle_server_mismatch";
  return {
    available: partial.available ?? !coreUnavailable,
    browserAvailable: false,
    provenance: command.provenance,
    version: partial.version ?? null,
    contractVersion: partial.contractVersion ?? null,
    contractHash: partial.contractHash ?? null,
    diagnosticCode: code,
    diagnostic: message,
    tools: partial.tools ?? [],
  };
}

export function assertRudderMcpCoreAvailable(result: RudderMcpPreflightResult): void {
  if (result.available) return;
  throw new Error(result.diagnostic ?? "Rudder MCP initialize/tools-list handshake failed.");
}

async function exchange(
  command: RudderMcpCliCommand,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Map<string | number, JsonRpcResponse>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const responses = new Map<string | number, JsonRpcResponse>();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(responses);
    };
    const parseLines = () => {
      const lines = stdout.split(/\r?\n/u);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (typeof parsed.id === "string" || typeof parsed.id === "number") responses.set(parsed.id, parsed);
        } catch {
          // A bounded timeout turns non-protocol stdout into a stable diagnostic.
        }
      }
      if (responses.has("initialize") && responses.has("tools-list")) finish();
    };
    const timer = setTimeout(() => {
      const detail = stderr.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
      finish(new Error(detail ? `MCP handshake timed out: ${detail}` : "MCP handshake timed out"));
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
      finish(new Error(
        detail ?? `MCP server exited before handshake completed (code=${code ?? "null"}, signal=${signal ?? "none"})`,
      ));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      parseLines();
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rudder-browser-bundle-preflight", version: "1" },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} })}\n`);
  });
}

export async function preflightRudderMcpServer(input: {
  command: RudderMcpCliCommand;
  runtimeEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  managedEnv?: Record<string, string>;
  browserEnabled: boolean;
  timeoutMs?: number;
}): Promise<RudderMcpPreflightResult> {
  const env = Object.fromEntries(
    Object.entries({ ...input.runtimeEnv, ...(input.command.env ?? {}), ...(input.managedEnv ?? {}) })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.RUDDER_DESKTOP_CLI_ENTRY;
  env.RUDDER_BROWSER_ENABLED = input.browserEnabled ? "true" : "false";

  let responses: Map<string | number, JsonRpcResponse>;
  try {
    responses = await exchange(input.command, env, input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
  } catch {
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      "Rudder MCP initialize/tools-list handshake failed; core control-plane tools are unavailable.",
    );
  }

  const initialize = responses.get("initialize");
  const toolsList = responses.get("tools-list");
  if (initialize?.error || toolsList?.error) {
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      "Rudder MCP initialize/tools-list returned a protocol error; core control-plane tools are unavailable.",
    );
  }

  const initializeResult = asRecord(initialize?.result);
  const serverInfo = asRecord(initializeResult.serverInfo);
  const capabilities = asRecord(initializeResult.capabilities);
  const rudder = asRecord(asRecord(capabilities.experimental).rudder);
  const version = asString(serverInfo.version);
  const contractVersion = asString(rudder.contractVersion);
  const contractHash = asString(rudder.browserContractHash);
  const listed = asRecord(toolsList?.result).tools;
  if (!Array.isArray(listed)) {
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      "Rudder MCP tools/list returned an invalid manifest; core control-plane tools are unavailable.",
      { version, contractVersion, contractHash },
    );
  }
  const tools = Array.isArray(listed)
    ? listed.map((entry) => {
        const tool = asRecord(entry);
        const name = asString(tool.name);
        if (!name) return null;
        const description = asString(tool.description);
        const inputSchema = asRecord(tool.inputSchema);
        return {
          name,
          ...(description ? { description } : {}),
          ...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
        };
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];
  const partial = { version, contractVersion, contractHash, tools };

  if (asString(serverInfo.name) !== RUDDER_MCP_SERVER_NAME) {
    return failed(
      input.command,
      "browser_bundle_server_mismatch",
      "Rudder MCP server identity did not match the managed bundle; core control-plane tools are unavailable.",
      partial,
    );
  }
  if (!tools.some((tool) => tool.name.startsWith("rudder_") && !tool.name.startsWith("rudder_browser_"))) {
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      "Rudder MCP tools/list exposed no core control-plane tools; core MCP is unavailable.",
      partial,
    );
  }
  if (input.command.expectedVersion && version !== input.command.expectedVersion) {
    return failed(
      input.command,
      "browser_bundle_version_mismatch",
      `Rudder MCP bundle version mismatch (expected ${input.command.expectedVersion}, received ${version ?? "unknown"}); optional Browser capability was disabled.`,
      partial,
    );
  }
  if (contractVersion !== RUDDER_MCP_CONTRACT_VERSION || contractHash !== RUDDER_BROWSER_MCP_CONTRACT_HASH) {
    return failed(
      input.command,
      "browser_bundle_contract_mismatch",
      "Rudder MCP Browser contract hash did not match the runtime bundle; optional Browser capability was disabled.",
      partial,
    );
  }

  const browserTools = tools.map((tool) => tool.name).filter((name) => name.startsWith("rudder_browser_"));
  const expectedBrowserTools = input.browserEnabled ? [...RUDDER_BROWSER_MCP_TOOL_NAMES] : [];
  if (
    browserTools.length !== expectedBrowserTools.length
    || browserTools.some((name, index) => name !== expectedBrowserTools[index])
  ) {
    return failed(
      input.command,
      "browser_bundle_tools_mismatch",
      "Rudder MCP Browser tool manifest did not expose the exact managed tool set; optional Browser capability was disabled.",
      partial,
    );
  }

  return {
    available: true,
    browserAvailable: input.browserEnabled,
    provenance: input.command.provenance,
    version,
    contractVersion,
    contractHash,
    diagnosticCode: null,
    diagnostic: null,
    tools,
  };
}
