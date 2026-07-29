import {
  MANAGED_EXTERNAL_MCP_ADMISSION_TIMEOUT_MS,
  resolveManagedExternalMcpBindings,
  type ResolvedManagedExternalMcpBinding,
} from "@rudderhq/agent-runtime-utils";

const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_DESCRIPTION_CHARS = 4_000;

export interface PiManagedExternalMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface PiManagedExternalMcpBinding
  extends ResolvedManagedExternalMcpBinding {
  tools: PiManagedExternalMcpTool[];
}

interface McpJsonRpcResponse {
  jsonrpc?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(response: Response): Promise<McpJsonRpcResponse> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_RESPONSE_BYTES) {
    throw new Error("Managed MCP response exceeded the size limit");
  }
  if (!response.body) throw new Error("Managed MCP returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MCP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Managed MCP response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Managed MCP returned invalid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Managed MCP returned an invalid response");
  return parsed;
}

function safeJsonRpcError(response: McpJsonRpcResponse): Error | null {
  if (!isRecord(response.error)) return null;
  const message = typeof response.error.message === "string"
    ? response.error.message.slice(0, 240)
    : "Managed MCP request failed";
  return new Error(message);
}

async function postManagedExternalMcpRequest(input: {
  proxyUrl: string;
  method: "tools/list" | "tools/call";
  params?: Record<string, unknown>;
  timeoutMs: number;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const runToken = input.env.RUDDER_API_KEY?.trim();
  if (!runToken) throw new Error("Managed MCP run authentication is unavailable");
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(input.proxyUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${runToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "pi-managed-mcp",
        method: input.method,
        ...(input.params ? { params: input.params } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (timeoutSignal.aborted && !input.signal?.aborted) {
      throw new Error("Managed MCP request timed out");
    }
    if (signal.aborted) throw new Error("Managed MCP request aborted");
    throw new Error("Managed MCP request failed", { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Managed MCP request failed with HTTP ${response.status}`);
  }
  const payload = await readBoundedJson(response);
  const rpcError = safeJsonRpcError(payload);
  if (rpcError) throw rpcError;
  if (!isRecord(payload.result)) {
    throw new Error("Managed MCP returned an invalid result");
  }
  return payload.result;
}

function parseDiscoveredTools(
  binding: ResolvedManagedExternalMcpBinding,
  result: Record<string, unknown>,
): PiManagedExternalMcpTool[] {
  if (!Array.isArray(result.tools)) {
    throw new Error(`Managed MCP schema discovery failed for "${binding.serverName}"`);
  }
  const allowedNames = new Set(binding.toolPolicy.allowedToolNames);
  const seenNames = new Set<string>();
  const tools = result.tools.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`Managed MCP schema ${index} is invalid`);
    }
    const name = value.name;
    const inputSchema = value.inputSchema;
    if (
      typeof name !== "string"
      || !allowedNames.has(name)
      || seenNames.has(name)
      || !isRecord(inputSchema)
    ) {
      throw new Error(`Managed MCP schema ${index} is invalid`);
    }
    seenNames.add(name);
    return {
      name,
      ...(typeof value.description === "string"
        ? { description: value.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS) }
        : {}),
      inputSchema,
    };
  });
  if (
    seenNames.size !== allowedNames.size
    || binding.toolPolicy.allowedToolNames.some((name) => !seenNames.has(name))
  ) {
    throw new Error(`Managed MCP schema allowlist changed for "${binding.serverName}"`);
  }
  return tools;
}

export async function discoverPiManagedExternalMcpBindings(
  runtimeConfig: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: {
    signal?: AbortSignal;
    onFailure?: (serverName: string | null, error: Error) => void | Promise<void>;
    onOptionalFailure?: (serverName: string, error: Error) => void | Promise<void>;
  } = {},
): Promise<PiManagedExternalMcpBinding[]> {
  const reportFailure = async (serverName: string | null, error: Error): Promise<void> => {
    try {
      await options.onFailure?.(serverName, error);
    } catch {
      // Diagnostics cannot regain runtime-admission authority.
    }
  };
  const resolutionFailures: Array<{ serverName: string | null; error: Error }> = [];
  const bindings = resolveManagedExternalMcpBindings(runtimeConfig, env, {
    onFailure: (serverName, error) => resolutionFailures.push({ serverName, error }),
  });
  for (const failure of resolutionFailures) {
    await reportFailure(failure.serverName, failure.error);
  }
  const discovered = await Promise.all(bindings.map(async (binding) => {
    try {
      const result = await postManagedExternalMcpRequest({
        proxyUrl: binding.proxyUrl,
        method: "tools/list",
        timeoutMs: Math.min(
          binding.startupTimeoutMs,
          MANAGED_EXTERNAL_MCP_ADMISSION_TIMEOUT_MS,
        ),
        env,
        signal: options.signal,
      });
      return {
        ...binding,
        tools: parseDiscoveredTools(binding, result),
      };
    } catch (error) {
      const safeError = error instanceof Error ? error : new Error("Managed MCP discovery failed");
      await reportFailure(binding.serverName, safeError);
      try {
        await options.onOptionalFailure?.(binding.serverName, safeError);
      } catch {
        // Legacy diagnostic sinks are non-authoritative too.
      }
      return null;
    }
  }));

  const active = discovered.filter(
    (binding): binding is PiManagedExternalMcpBinding => binding !== null,
  );
  const accepted: PiManagedExternalMcpBinding[] = [];
  const toolOwners = new Map<string, string>();
  for (const binding of active) {
    const conflict = binding.tools.find((tool) => toolOwners.has(tool.name));
    if (conflict) {
      await reportFailure(
        binding.serverName,
        new Error(
          `Managed MCP tool name "${conflict.name}" conflicts with another binding and was omitted`,
        ),
      );
      continue;
    }
    accepted.push(binding);
    for (const tool of binding.tools) toolOwners.set(tool.name, binding.serverName);
  }
  return accepted;
}

export async function callManagedExternalMcpProxy(input: {
  proxyUrl: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return postManagedExternalMcpRequest({
    proxyUrl: input.proxyUrl,
    method: "tools/call",
    params: {
      name: input.toolName,
      arguments: input.args,
    },
    timeoutMs: input.timeoutMs,
    env: input.env,
    signal: input.signal,
  });
}

function renderJsonForTs(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderPiManagedExternalMcpExtension(
  bindings: PiManagedExternalMcpBinding[],
): string {
  const bridgeDescriptors = bindings.map((binding) => ({
    serverName: binding.serverName,
    proxyUrl: binding.proxyUrl,
    toolTimeoutMs: binding.toolTimeoutMs,
    tools: binding.tools,
  }));
  return `import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;

const RUDDER_MANAGED_MCP_BINDINGS = ${renderJsonForTs(bridgeDescriptors)} as Array<{
  serverName: string;
  proxyUrl: string;
  toolTimeoutMs: number;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}>;

async function readBoundedMcpJson(response: Response): Promise<{
  result?: Record<string, unknown>;
  error?: { message?: unknown };
}> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Managed MCP response exceeded the size limit");
  }
  if (!response.body) throw new Error("Managed MCP returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MCP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Managed MCP response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Managed MCP returned invalid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Managed MCP returned an invalid response");
  }
  return payload as {
    result?: Record<string, unknown>;
    error?: { message?: unknown };
  };
}

export async function callManagedMcp(
  proxyUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const runToken = process.env.RUDDER_API_KEY?.trim();
  if (!runToken) throw new Error("Managed MCP run authentication is unavailable");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: \`Bearer \${runToken}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "pi-managed-mcp",
        method: "tools/call",
        params: { name: toolName, arguments: args ?? {} },
      }),
      signal: requestSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new Error("Managed MCP tool call timed out");
    }
    if (requestSignal.aborted) throw new Error("Managed MCP tool call aborted");
    throw new Error("Managed MCP tool call failed", { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(\`Managed MCP tool call failed with HTTP \${response.status}\`);
  }
  const payload = await readBoundedMcpJson(response);
  if (payload.error) {
    throw new Error(
      typeof payload.error.message === "string"
        ? payload.error.message.slice(0, 240)
        : "Managed MCP tool call failed",
    );
  }
  if (!payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
    throw new Error("Managed MCP returned an invalid tool result");
  }
  return payload.result;
}

export default function rudderManagedExternalMcpTools(pi: ExtensionAPI) {
  for (const binding of RUDDER_MANAGED_MCP_BINDINGS) {
    for (const tool of binding.tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description || \`Managed external MCP tool \${tool.name}.\`,
        promptSnippet: \`Call managed external MCP tool \${tool.name} with runtime-managed authentication.\`,
        promptGuidelines: [
          "Use only the exposed managed MCP tools. Authentication and provider credentials are managed by Rudder.",
        ],
        parameters: tool.inputSchema ?? Type.Object({}, { additionalProperties: true }),
        async execute(_toolCallId, params, signal) {
          const result = await callManagedMcp(
            binding.proxyUrl,
            tool.name,
            params as Record<string, unknown>,
            binding.toolTimeoutMs,
            signal,
          );
          const content = Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: JSON.stringify(result.structuredContent ?? result) }];
          return { content, details: result };
        },
      });
    }
  }
}
`;
}
