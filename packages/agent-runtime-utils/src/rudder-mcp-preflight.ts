import { spawn } from "node:child_process";
import { fingerprintRudderMcpToolManifest } from "./rudder-mcp-fingerprint.js";
import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_CONTRACT_VERSION,
  RUDDER_MCP_SERVER_NAME,
  isRudderBrowserMcpToolCandidate,
  type RudderMcpCliCommand,
  type RudderMcpPreflightDiagnosticCode,
  type RudderMcpPreflightResult,
} from "./rudder-mcp.js";

const PREFLIGHT_TIMEOUT_MS = 15_000;
const RUDDER_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "items",
  "additionalProperties",
  "required",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "oneOf",
  "anyOf",
]);
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

type JsonRpcResponse = {
  id?: string | number | null;
  error?: { message?: unknown };
  result?: unknown;
};

function boundedStderrDetail(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const detail = lines.slice(-5).join(" | ");
  return detail.length <= 2_000 ? detail : `…${detail.slice(-1_999)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asExactString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function schemaTypes(value: unknown): string[] | null {
  if (typeof value === "string") {
    return JSON_SCHEMA_TYPES.has(value) ? [value] : null;
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== "string" || !JSON_SCHEMA_TYPES.has(entry))
  ) {
    return null;
  }
  const types = value as string[];
  return new Set(types).size === types.length ? types : null;
}

function isValidRudderSchemaNode(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (Object.keys(schema).some((key) => !RUDDER_SCHEMA_KEYS.has(key))) return false;

  const types = schema.type === undefined ? [] : schemaTypes(schema.type);
  if (types === null) return false;
  if (schema.description !== undefined && typeof schema.description !== "string") return false;

  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return false;
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (
      schema[key] !== undefined
      && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]) || Number(schema[key]) < 0)
    ) {
      return false;
    }
  }
  if (
    schema.oneOf !== undefined
    && (
      !Array.isArray(schema.oneOf)
      || schema.oneOf.length === 0
      || !schema.oneOf.every(isValidRudderSchemaNode)
    )
  ) {
    return false;
  }
  if (
    schema.anyOf !== undefined
    && (
      !Array.isArray(schema.anyOf)
      || schema.anyOf.length === 0
      || !schema.anyOf.every(isValidRudderSchemaNode)
    )
  ) {
    return false;
  }

  const supportsObject = types.includes("object");
  const supportsArray = types.includes("array");
  if (schema.additionalProperties !== undefined) {
    if (!supportsObject || typeof schema.additionalProperties !== "boolean") return false;
  }
  if (schema.properties !== undefined) {
    if (!supportsObject || typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) {
      return false;
    }
    if (!Object.values(schema.properties).every(isValidRudderSchemaNode)) return false;
  }
  if (schema.items !== undefined && (!supportsArray || !isValidRudderSchemaNode(schema.items))) return false;
  if (schema.required !== undefined) {
    if ((!supportsObject && types.length > 0) || !Array.isArray(schema.required)) return false;
    const required = schema.required;
    if (required.some((key) => typeof key !== "string") || new Set(required).size !== required.length) return false;
    if (types.length === 0 && schema.properties === undefined) return true;
    if (
      typeof schema.properties !== "object"
      || schema.properties === null
      || Array.isArray(schema.properties)
      || required.some((key) => !Object.hasOwn(schema.properties as Record<string, unknown>, key))
    ) {
      return false;
    }
  }
  return true;
}

function hasCanonicalInputSchema(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return false;
  }
  const schema = value as Record<string, unknown>;
  if (!isValidRudderSchemaNode(schema)) return false;
  const properties = schema.properties;
  return schema.type === "object"
    && schema.additionalProperties === false
    && typeof properties === "object"
    && properties !== null
    && !Array.isArray(properties)
    && Object.values(properties).every(isValidRudderSchemaNode);
}

function hasExactNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
}

function semanticManifestHash(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>,
): string | null {
  if (tools.some((tool) => tool.description === undefined || tool.inputSchema === undefined)) return null;
  return fingerprintRudderMcpToolManifest(tools as Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>);
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
    coreContractHash: partial.coreContractHash ?? null,
    contractHash: partial.contractHash ?? null,
    diagnosticCode: code,
    diagnostic: message,
    tools: partial.tools ?? [],
  };
}

function failedCore(
  command: RudderMcpCliCommand,
  code: RudderMcpPreflightDiagnosticCode,
  message: string,
  partial: Partial<RudderMcpPreflightResult> = {},
): RudderMcpPreflightResult {
  return {
    available: false,
    provenance: command.provenance,
    version: partial.version ?? null,
    contractVersion: partial.contractVersion ?? null,
    coreContractHash: partial.coreContractHash ?? null,
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
      const detail = boundedStderrDetail(stderr);
      finish(new Error(detail ? `MCP handshake timed out: ${detail}` : "MCP handshake timed out"));
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      const exitDetail = `MCP server exited before handshake completed (code=${code ?? "null"}, signal=${signal ?? "none"})`;
      const detail = boundedStderrDetail(stderr);
      finish(new Error(detail ? `${exitDetail}: ${detail}` : exitDetail));
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

type RudderMcpPreflightInput = {
  command: RudderMcpCliCommand;
  runtimeEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  managedEnv?: Record<string, string>;
  /** @deprecated The isolated core server always ignores Browser capability state. */
  browserEnabled?: boolean;
  timeoutMs?: number;
};

async function preflightRudderMcpServerOnce(
  input: RudderMcpPreflightInput,
): Promise<RudderMcpPreflightResult> {
  const env = Object.fromEntries(
    Object.entries({ ...input.runtimeEnv, ...(input.command.env ?? {}), ...(input.managedEnv ?? {}) })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.RUDDER_DESKTOP_CLI_ENTRY;
  env.RUDDER_BROWSER_ENABLED = "false";

  let responses: Map<string | number, JsonRpcResponse>;
  try {
    responses = await exchange(input.command, env, input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failedCore(
      input.command,
      "core_bundle_handshake_failed",
      `Rudder MCP initialize/tools-list handshake failed: ${detail}; core Rudder tools are unavailable.`,
    );
  }

  const initialize = responses.get("initialize");
  const toolsList = responses.get("tools-list");
  if (initialize?.error || toolsList?.error) {
    return failedCore(
      input.command,
      "core_bundle_handshake_failed",
      "Rudder MCP initialize/tools-list returned a protocol error; core Rudder tools are unavailable.",
    );
  }

  const initializeResult = asRecord(initialize?.result);
  const serverInfo = asRecord(initializeResult.serverInfo);
  const capabilities = asRecord(initializeResult.capabilities);
  const rudder = asRecord(asRecord(capabilities.experimental).rudder);
  const version = asExactString(serverInfo.version);
  const contractVersion = asExactString(rudder.contractVersion);
  const coreContractHash = asExactString(rudder.coreContractHash);
  const listed = asRecord(toolsList?.result).tools;
  if (!Array.isArray(listed)) {
    return failedCore(
      input.command,
      "core_bundle_tools_mismatch",
      "Rudder MCP tools/list returned an invalid manifest; core Rudder tools are unavailable.",
      { version, contractVersion, coreContractHash },
    );
  }
  const parsedTools = listed.map((entry) => {
    const tool = asRecord(entry);
    const name = asExactString(tool.name);
    if (!name) return null;
    const description = asExactString(tool.description);
    const inputSchema = asRecord(tool.inputSchema);
    return {
      name,
      hasCanonicalInputSchema: hasCanonicalInputSchema(tool.inputSchema),
      ...(description ? { description } : {}),
      ...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
    };
  });
  const tools = parsedTools
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(({ hasCanonicalInputSchema: _hasCanonicalInputSchema, ...tool }) => tool);
  const partial = { version, contractVersion, coreContractHash, tools };

  if (asExactString(serverInfo.name) !== RUDDER_MCP_SERVER_NAME) {
    return failedCore(
      input.command,
      "core_bundle_server_mismatch",
      "Rudder MCP server identity did not match the managed bundle; core Rudder tools are unavailable.",
      partial,
    );
  }
  const coreTools = parsedTools.filter((tool) => tool && !isRudderBrowserMcpToolCandidate(tool.name));
  const coreToolNames = coreTools.map((tool) => tool!.name);
  const observedCoreContractHash = semanticManifestHash(coreTools.filter((tool) => tool !== null));
  if (
    contractVersion !== RUDDER_MCP_CONTRACT_VERSION
    || coreContractHash !== RUDDER_CORE_MCP_CONTRACT_HASH
  ) {
    return failedCore(
      input.command,
      "core_bundle_contract_mismatch",
      "Rudder MCP core contract hash did not match the runtime bundle; core MCP is unavailable.",
      partial,
    );
  }
  if (
    parsedTools.some((tool) => tool === null)
    || parsedTools.length !== coreTools.length
    || !hasExactNames(coreToolNames, RUDDER_CORE_MCP_TOOL_NAMES)
    || coreTools.some((tool) => !tool!.hasCanonicalInputSchema)
    || observedCoreContractHash !== RUDDER_CORE_MCP_CONTRACT_HASH
  ) {
    return failedCore(
      input.command,
      "core_bundle_tools_mismatch",
      "Rudder MCP tools/list did not match the canonical core Rudder manifest; core MCP is unavailable.",
      partial,
    );
  }
  if (input.command.expectedVersion && version !== input.command.expectedVersion) {
    return failedCore(
      input.command,
      "core_bundle_version_mismatch",
      `Rudder MCP bundle version mismatch (expected ${input.command.expectedVersion}, received ${version ?? "unknown"}); core Rudder tools are unavailable.`,
      partial,
    );
  }

  return {
    available: true,
    provenance: input.command.provenance,
    version,
    contractVersion,
    coreContractHash,
    diagnosticCode: null,
    diagnostic: null,
    tools,
  };
}

export async function preflightRudderMcpServer(
  input: RudderMcpPreflightInput,
): Promise<RudderMcpPreflightResult> {
  return preflightRudderMcpServerOnce(input);
}

type RudderBrowserMcpPreflightInput = Omit<RudderMcpPreflightInput, "browserEnabled">;

export async function preflightRudderBrowserMcpServer(
  input: RudderBrowserMcpPreflightInput,
): Promise<RudderMcpPreflightResult> {
  const env = Object.fromEntries(
    Object.entries({ ...input.runtimeEnv, ...(input.command.env ?? {}), ...(input.managedEnv ?? {}) })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.RUDDER_DESKTOP_CLI_ENTRY;
  env.RUDDER_BROWSER_ENABLED = "true";

  let responses: Map<string | number, JsonRpcResponse>;
  try {
    responses = await exchange(input.command, env, input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      `Rudder Browser MCP initialize/tools-list handshake failed: ${detail}; optional Browser capability was disabled.`,
      { available: true },
    );
  }

  const initialize = responses.get("initialize");
  const toolsList = responses.get("tools-list");
  if (initialize?.error || toolsList?.error) {
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      "Rudder Browser MCP initialize/tools-list returned a protocol error; optional Browser capability was disabled.",
      { available: true },
    );
  }

  const initializeResult = asRecord(initialize?.result);
  const serverInfo = asRecord(initializeResult.serverInfo);
  const rudder = asRecord(asRecord(asRecord(initializeResult.capabilities).experimental).rudder);
  const version = asExactString(serverInfo.version);
  const contractVersion = asExactString(rudder.contractVersion);
  const coreContractHash = asExactString(rudder.coreContractHash);
  const contractHash = asExactString(rudder.browserContractHash);
  const listed = asRecord(toolsList?.result).tools;
  const partialBase = { available: true, version, contractVersion, coreContractHash, contractHash };
  if (!Array.isArray(listed)) {
    return failed(
      input.command,
      "browser_bundle_handshake_failed",
      "Rudder Browser MCP tools/list returned an invalid manifest; optional Browser capability was disabled.",
      partialBase,
    );
  }

  const parsedTools = listed.map((entry) => {
    const tool = asRecord(entry);
    const name = asExactString(tool.name);
    if (!name) return null;
    const description = asExactString(tool.description);
    const inputSchema = asRecord(tool.inputSchema);
    return {
      name,
      hasCanonicalInputSchema: hasCanonicalInputSchema(tool.inputSchema),
      ...(description ? { description } : {}),
      ...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
    };
  });
  const tools = parsedTools
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(({ hasCanonicalInputSchema: _hasCanonicalInputSchema, ...tool }) => tool);
  const partial = { ...partialBase, tools };

  if (asExactString(serverInfo.name) !== RUDDER_BROWSER_MCP_SERVER_NAME) {
    return failed(
      input.command,
      "browser_bundle_server_mismatch",
      "Rudder Browser MCP server identity did not match the managed bundle; optional Browser capability was disabled.",
      partial,
    );
  }
  if (input.command.expectedVersion && version !== input.command.expectedVersion) {
    return failed(
      input.command,
      "browser_bundle_version_mismatch",
      `Rudder Browser MCP bundle version mismatch (expected ${input.command.expectedVersion}, received ${version ?? "unknown"}); optional Browser capability was disabled.`,
      partial,
    );
  }
  if (contractVersion !== RUDDER_MCP_CONTRACT_VERSION || contractHash !== RUDDER_BROWSER_MCP_CONTRACT_HASH) {
    return failed(
      input.command,
      "browser_bundle_contract_mismatch",
      "Rudder Browser MCP contract hash did not match the runtime bundle; optional Browser capability was disabled.",
      partial,
    );
  }

  const observedContractHash = semanticManifestHash(parsedTools.filter((tool) => tool !== null));
  if (
    parsedTools.some((tool) => tool === null)
    || !hasExactNames(tools.map((tool) => tool.name), RUDDER_BROWSER_MCP_TOOL_NAMES)
    || parsedTools.some((tool) => tool !== null && !tool.hasCanonicalInputSchema)
    || observedContractHash !== RUDDER_BROWSER_MCP_CONTRACT_HASH
  ) {
    return failed(
      input.command,
      "browser_bundle_tools_mismatch",
      "Rudder Browser MCP tools/list did not expose the exact canonical Browser manifest; optional Browser capability was disabled.",
      partial,
    );
  }

  return {
    available: true,
    browserAvailable: true,
    provenance: input.command.provenance,
    version,
    contractVersion,
    coreContractHash,
    contractHash,
    diagnosticCode: null,
    diagnostic: null,
    tools,
  };
}
