import {
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_MCP_CONTRACT_VERSION,
  RUDDER_MCP_SERVER_NAME,
  rudderMcpSemanticToolContract,
} from "@rudderhq/agent-runtime-utils";
import { fingerprintRudderMcpToolManifest } from "@rudderhq/agent-runtime-utils/rudder-mcp-fingerprint";
import { addIssueCommentSchema, checkoutIssueSchema } from "@rudderhq/shared";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentV1McpToolsManifest,
  getAgentCliCapabilityById,
  type AgentV1McpToolManifestEntry
} from "./agent-v1-registry.js";
import { ApiRequestError, RudderApiClient } from "./client/http.js";
import { resolveCliVersion } from "./version.js";

export { RUDDER_BROWSER_MCP_SERVER_NAME, RUDDER_MCP_SERVER_NAME };
const RUDDER_MCP_MAX_TOOL_RESULT_BYTES = 1_000_000;
const RUDDER_BROWSER_MCP_MAX_TOOL_RESULT_BYTES = 16_000_000;
const RUDDER_MCP_MAX_INLINE_TEXT_BYTES = 32_000;
const RUDDER_BROWSER_LIVENESS_INTERVAL_MS = 1_000;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpServerEnv {
  RUDDER_API_URL?: string;
  RUDDER_API_KEY?: string;
  RUDDER_ORG_ID?: string;
  RUDDER_AGENT_ID?: string;
  RUDDER_RUN_ID?: string;
  RUDDER_BROWSER_ENABLED?: string;
  RUDDER_PROJECT_LIBRARY_PATH?: string;
  RUDDER_MCP_RUDDER_BIN?: string;
  [key: string]: string | undefined;
}

type McpStdioMode = "framed" | "newline";
export type RudderMcpServerSurface = "core" | "browser";
type McpStdioInput = NodeJS.ReadableStream
  & AsyncIterable<string | Buffer>
  & { destroy(error?: Error): void };
type McpStdioOutput = { write(chunk: string): unknown };
type McpStdioServerOptions = {
  input?: McpStdioInput;
  output?: McpStdioOutput;
  startLivenessMonitor?: typeof startBrowserMcpLivenessMonitor;
};

const RESERVED_MODEL_ARGUMENTS = new Set([
  "orgId",
  "org_id",
  "companyId",
  "company_id",
  "agentId",
  "agent_id",
  "runId",
  "run_id",
  "apiBase",
  "api_base",
  "apiKey",
  "api_key",
  "authorization",
]);
const NORMALIZED_RESERVED_MODEL_ARGUMENTS = new Set([
  "orgid",
  "companyid",
  "agentid",
  "runid",
  "apibase",
  "apikey",
  "authorization",
]);

const LEGACY_ARGUMENT_ALIASES: Record<string, Record<string, string>> = {
  "agent.skills.enable": {
    selections: "selectionRefs",
    skills: "selectionRefs",
  },
  "issue.get": { issueId: "issue" },
  "issue.context": { issueId: "issue" },
  "issue.checkout": { issueId: "issue" },
  "issue.comment": { issueId: "issue" },
  "issue.comments.list": { issueId: "issue" },
  "issue.comments.get": { issueId: "issue", commentId: "comment" },
  "issue.update": { issueId: "issue" },
  "issue.review": { issueId: "issue" },
  "issue.commit": { issueId: "issue" },
  "issue.done": { issueId: "issue" },
  "issue.block": { issueId: "issue" },
  "project.get": { projectId: "project" },
  "project.update": { projectId: "project" },
  "approval.get": { approvalId: "approval" },
  "approval.issues": { approvalId: "approval" },
  "approval.comment": { approvalId: "approval" },
  "skill.get": { skillId: "skill" },
  "skill.file": { skillId: "skill" },
  "automation.get": { automationId: "automation" },
  "automation.runs": { automationId: "automation" },
  "automation.triggers.list": { automationId: "automation" },
  "automation.triggers.create": { automationId: "automation" },
  "automation.triggers.update": { triggerId: "trigger" },
  "automation.triggers.delete": { triggerId: "trigger" },
  "automation.triggers.rotate-secret": { triggerId: "trigger" },
  "automation.update": { automationId: "automation" },
  "automation.enable": { automationId: "automation" },
  "automation.disable": { automationId: "automation" },
  "automation.run": { automationId: "automation" },
  "runs.transcript": { maxOutputChars: "maxChars" },
  "chat.get": { chatId: "chat" },
  "chat.messages": { chatId: "chat" },
  "chat.transcript": { chatId: "chat" },
  "chat.read": { chatId: "chat" },
  "chat.send": { chatId: "chat" },
  "chat.archive": { chatId: "chat" },
};

export interface TempFilePlan {
  flag: string;
  contents: string;
}

export interface AgentV1ToolCallPlan {
  args: string[];
  env: McpServerEnv;
  tempFiles: TempFilePlan[];
}

export function buildMcpServerEnv(env: NodeJS.ProcessEnv = process.env): McpServerEnv {
  return {
    ...process.env,
    ...env,
    RUDDER_API_URL: env.RUDDER_API_URL,
    RUDDER_API_KEY: env.RUDDER_API_KEY,
    RUDDER_ORG_ID: env.RUDDER_ORG_ID,
    RUDDER_AGENT_ID: env.RUDDER_AGENT_ID,
    RUDDER_RUN_ID: env.RUDDER_RUN_ID,
    RUDDER_BROWSER_ENABLED: env.RUDDER_BROWSER_ENABLED,
    RUDDER_PROJECT_LIBRARY_PATH: env.RUDDER_PROJECT_LIBRARY_PATH,
    RUDDER_MCP_RUDDER_BIN: env.RUDDER_MCP_RUDDER_BIN,
  };
}

export function buildAgentV1ToolCallPlan(
  toolName: string,
  rawArgs: unknown,
  env: McpServerEnv = buildMcpServerEnv(),
): AgentV1ToolCallPlan {
  const capabilityId = toolNameToCapabilityId(toolName);
  if (!capabilityId) {
    throw new Error(`Unknown Rudder MCP tool: ${toolName}`);
  }
  if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
    throwInvalidMcpArgument(toolName, "arguments", "must be object");
  }
  const input = normalizeLegacyToolArguments(capabilityId, isRecord(rawArgs) ? rawArgs : {});
  const capability = getAgentCliCapabilityById(capabilityId);
  rejectModelProvidedRuntimeIdentity(input);
  rejectUnsupportedToolArguments(toolName, input);
  validateMcpToolArguments(toolName, input);
  rejectUnsupportedBrowserLocatorAction(toolName, input);
  assertBrowserCapabilityEnabled(capabilityId, env);
  assertRuntimeMcpContext(capability, env);

  const tempFiles: TempFilePlan[] = [];
  const args = cliArgsForCapability(capabilityId, input, tempFiles, env);
  args.push("--json");

  return {
    args,
    env: {
      ...process.env,
      ...env,
      RUDDER_API_URL: env.RUDDER_API_URL,
      RUDDER_API_KEY: env.RUDDER_API_KEY,
      RUDDER_ORG_ID: env.RUDDER_ORG_ID,
      RUDDER_AGENT_ID: env.RUDDER_AGENT_ID,
      RUDDER_RUN_ID: env.RUDDER_RUN_ID,
      RUDDER_BROWSER_ENABLED: env.RUDDER_BROWSER_ENABLED,
      RUDDER_PROJECT_LIBRARY_PATH: env.RUDDER_PROJECT_LIBRARY_PATH,
    },
    tempFiles,
  };
}

export async function runAgentV1McpJsonRpcMessage(
  message: JsonRpcRequest,
  env: McpServerEnv = buildMcpServerEnv(),
  surface: RudderMcpServerSurface = "core",
  options: { signal?: AbortSignal } = {},

): Promise<Record<string, unknown> | null> {
  const isNotification = message.id === undefined;
  const id = message.id ?? null;
  try {
    switch (message.method) {
      case "notifications/initialized":
        return isNotification ? null : rpcResult(id, {});
      case "initialize":
        const coreContractManifest = buildAgentV1McpToolsManifest("agent-v1").tools

          .map(rudderMcpSemanticToolContract);
        const browserContractManifest = buildAgentV1McpToolsManifest("agent-v1", { surface: "browser" }).tools
          .map(rudderMcpSemanticToolContract);
        const coreContractHash = fingerprintRudderMcpToolManifest(coreContractManifest);
        const browserContractHash = fingerprintRudderMcpToolManifest(browserContractManifest);
        return rpcResult(id, {
          protocolVersion: requestedProtocolVersion(message.params) ?? "2024-11-05",
          capabilities: {
            tools: {},
            experimental: {
              rudder: {
                contractVersion: RUDDER_MCP_CONTRACT_VERSION,
                coreContractHash,
                browserContractHash,
              },
            },
          },
          serverInfo: {
            name: surface === "browser" ? RUDDER_BROWSER_MCP_SERVER_NAME : RUDDER_MCP_SERVER_NAME,
            version: resolveCliVersion(),
          },
        });
      case "tools/list":
        return rpcResult(id, {
          tools: surface === "browser" && !browserCapabilityEnabled(env)
            ? []
            : buildAgentV1McpToolsManifest("agent-v1", { surface }).tools.map(toMcpToolListEntry),
        });
      case "tools/call":
        return boundedToolCallRpcResponse(
          id,
          await callToolSafely(message.params, env, surface, options.signal),
          surface,
        );

      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Unsupported JSON-RPC method: ${String(message.method ?? "")}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, -32000, errorMessage(err), errorDetails(err));
  }
}

export async function runMcpStdioServer(
  env: McpServerEnv = buildMcpServerEnv(),
  surface: RudderMcpServerSurface = "core",
  options: McpStdioServerOptions = {},
): Promise<void> {
  const stdin = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let revoked = false;
  let activeRequest: AbortController | null = null;
  const revoke = () => {
    revoked = true;
    activeRequest?.abort();
    stdin.destroy();
  };
  const stopLivenessMonitor = surface === "browser"
    ? (options.startLivenessMonitor ?? startBrowserMcpLivenessMonitor)(env, revoke)
    : () => undefined;
  let buffer = "";
  let mode: McpStdioMode | null = null;
  stdin.setEncoding("utf8");
  try {
    for await (const chunk of stdin) {
      if (revoked) break;
      buffer += chunk;
      const parsed = parseMcpStdioMessages(buffer, mode);
      mode = parsed.mode ?? mode;
      buffer = parsed.remainder;
      for (const message of parsed.messages) {
        if (revoked) break;
        activeRequest = new AbortController();
        const response = await runAgentV1McpJsonRpcMessage(
          message,
          env,
          surface,
          { signal: activeRequest.signal },
        );
        activeRequest = null;
        if (revoked) break;
        if (!response) continue;
        const payload = JSON.stringify(response);
        output.write(parsed.mode === "framed"
          ? `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`
          : `${payload}\n`);
      }

    }
  } catch (error) {
    if (!revoked) throw error;
  } finally {
    activeRequest?.abort();
    stopLivenessMonitor();
  }
}

export function startBrowserMcpLivenessMonitor(
  env: McpServerEnv,
  onRevoked: (code: string) => void,
  options: { intervalMs?: number; probe?: () => Promise<void> } = {},
): () => void {
  const intervalMs = Math.max(100, options.intervalMs ?? RUDDER_BROWSER_LIVENESS_INTERVAL_MS);
  const probe = options.probe ?? (async () => {
    await mcpApiClient(env).post("/api/browser/liveness", {});
  });
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };
  const tick = async () => {
    try {
      await probe();
    } catch (error) {
      if (error instanceof ApiRequestError
        && ["browser_disabled", "browser_runtime_unsupported", "browser_run_inactive", "browser_run_forbidden"].includes(error.code ?? "")) {
        stopped = true;
        onRevoked(error.code ?? "browser_disabled");
        return;
      }
    }
    schedule();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

export function parseMcpStdioMessages(buffer: string, mode: McpStdioMode | null = null): {
  messages: JsonRpcRequest[];
  remainder: string;
  mode: McpStdioMode | null;
} {
  const messages: JsonRpcRequest[] = [];
  const detectedMode = mode ?? detectMcpStdioMode(buffer);
  if (!detectedMode) {
    return { messages, remainder: buffer, mode: null };
  }
  if (detectedMode === "framed") {
    let restBuffer = Buffer.from(buffer, "utf8");
    while (true) {
      const restText = restBuffer.toString("utf8");
      const headerEnd = restText.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = restText.slice(0, headerEnd);
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!match) break;
      const length = Number(match[1]);
      const bodyStart = Buffer.byteLength(restText.slice(0, headerEnd + 4), "utf8");
      const bodyEnd = bodyStart + length;
      if (restBuffer.byteLength < bodyEnd) break;
      const body = restBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      messages.push(JSON.parse(body) as JsonRpcRequest);
      restBuffer = restBuffer.subarray(bodyEnd);
    }
    return { messages, remainder: restBuffer.toString("utf8"), mode: "framed" };
  }

  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    messages.push(JSON.parse(line) as JsonRpcRequest);
  }
  return { messages, remainder, mode: "newline" };
}

function detectMcpStdioMode(buffer: string): McpStdioMode | null {
  const trimmed = buffer.trimStart();
  if (!trimmed) return null;
  const contentLength = "Content-Length:";
  if (contentLength.toLowerCase().startsWith(trimmed.toLowerCase())) return null;
  if (/^Content-Length:/iu.test(trimmed)) return "framed";
  return "newline";
}

async function callToolSafely(
  params: unknown,
  env: McpServerEnv,
  surface: RudderMcpServerSurface,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    return await callTool(params, env, surface, signal);

  } catch (err) {
    const details = errorDetails(err);
    const payload = {
      status: "error",
      code: isRecord(details) && typeof details.code === "string" ? details.code : "rudder_mcp_tool_error",
      message: errorMessage(err),
      details: details ?? null,
    };
    return {
      content: [{
        type: "text",
        text: JSON.stringify(payload),
      }],
      structuredContent: payload,
      isError: true,
    };
  }
}

async function callTool(
  params: unknown,
  env: McpServerEnv,
  surface: RudderMcpServerSurface,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {

  const record = isRecord(params) ? params : {};
  const toolName = typeof record.name === "string" ? record.name : "";
  const exposed = buildAgentV1McpToolsManifest("agent-v1", { surface }).tools
    .some((tool) => tool.name === toolName);
  if (!exposed) {
    const err = new Error(`Rudder MCP tool is not exposed by the ${surface} server: ${toolName || "(missing)"}`);
    (err as Error & { code?: string }).code = "rudder_mcp_tool_not_available";
    throw err;
  }
  const rawArgs = record.arguments;
  const args = isRecord(rawArgs)
    ? normalizeLegacyToolArguments(toolNameToCapabilityId(toolName) ?? "", rawArgs)
    : rawArgs;
  const plan = buildAgentV1ToolCallPlan(toolName, args, env);
  const directResult = await callToolDirectlyIfSupported(toolName, args, env, signal);
  if (directResult) return directResult;
  const tempDir = plan.tempFiles.length > 0 ? await fs.mkdtemp(path.join(os.tmpdir(), "rudder-mcp-")) : null;
  const materializedArgs = [...plan.args];
  try {
    if (tempDir) {
      for (const tempFile of plan.tempFiles) {
        const tempPath = path.join(tempDir, `${tempFile.flag.replace(/^-+/, "")}.md`);
        await fs.writeFile(tempPath, tempFile.contents, "utf8");
        const index = materializedArgs.indexOf(tempFile.flag);
        if (index >= 0) materializedArgs[index + 1] = tempPath;
      }
    }

    const result = await runRudderCli(materializedArgs, plan.env);
    if (result.exitCode === 0) {
      const text = result.stdout.trim() || "{}";
      return mcpSuccessFromJsonText(
        text,
        surface === "browser" ? RUDDER_BROWSER_MCP_MAX_TOOL_RESULT_BYTES : RUDDER_MCP_MAX_TOOL_RESULT_BYTES,
      );
    }
    const payload = {
      status: "error",
      code: "rudder_cli_command_failed",
      message: result.stderr.trim() || result.stdout.trim() || "Rudder CLI command failed",
      details: { exitCode: result.exitCode },
    };
    return {
      content: [{
        type: "text",
        text: JSON.stringify(payload),
      }],
      structuredContent: payload,
      isError: true,
    };
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function callToolDirectlyIfSupported(
  toolName: string,
  rawArgs: unknown,
  env: McpServerEnv,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const capabilityId = toolNameToCapabilityId(toolName);
  if (!capabilityId) return null;
  const input = isRecord(rawArgs) ? rawArgs : {};
  if (hasLocalImageInputs(input.images)) return null;
  const api = mcpApiClient(env, signal);
  const success = (data: unknown) => mcpSuccess(
    data,
    capabilityId.startsWith("browser.")
      ? RUDDER_BROWSER_MCP_MAX_TOOL_RESULT_BYTES
      : RUDDER_MCP_MAX_TOOL_RESULT_BYTES,
  );

  switch (capabilityId) {
    case "agent.me":
      return success(await api.get("/api/agents/me"));
    case "agent.inbox":
      return success(await api.get("/api/agents/me/inbox-lite"));
    case "issue.get":
      return success(await api.get(`/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}`));
    case "issue.context": {
      const params = new URLSearchParams();
      const wakeCommentId = optionalString(input.wakeCommentId);
      if (wakeCommentId) params.set("wakeCommentId", wakeCommentId);
      const query = params.toString();
      return success(await api.get(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}/heartbeat-context${query ? `?${query}` : ""}`,
      ));
    }
    case "issue.checkout": {
      const expectedStatuses = parseCsvInput(input.expectedStatuses, "todo,backlog,blocked");
      const payload = checkoutIssueSchema.parse({
        agentId: optionalString(env.RUDDER_AGENT_ID),
        expectedStatuses,
      });
      return success(await api.post(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}/checkout`,
        payload,
      ));
    }
    case "issue.comment": {
      const payload = addIssueCommentSchema.parse({
        body: requiredAnyString(input, ["body", "comment"]),
        reopen: input.reopen === true ? true : undefined,
      });
      return success(await api.post(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}/comments`,
        payload,
      ));
    }
    case "issue.done": {
      const comment = requiredAnyString(input, ["comment", "body"]);
      return success(await api.patch(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}`,
        { status: "done", comment },
      ));
    }
    case "runs.list":
      return success(await api.get(
        `/api/run-intelligence/orgs/${encodeURIComponent(requiredRuntimeString(env, "RUDDER_ORG_ID"))}/runs?${buildDirectRunsListQuery(input)}`,
      ));
    case "runs.get":
      return success(await api.get(
        `/api/run-intelligence/runs/${encodeURIComponent(requiredString(input, "run"))}?projection=summary`,
      ));
    case "runs.events":
      return success(await api.get(
        `/api/run-intelligence/runs/${encodeURIComponent(requiredString(input, "run"))}/events?${buildDirectRunEventsQuery(input)}`,
      ));
    case "runs.log":
      return success(await api.get(
        `/api/run-intelligence/runs/${encodeURIComponent(requiredString(input, "run"))}/log?${buildDirectRunLogQuery(input)}`,
      ));
    case "runs.transcript":
      return success(await api.get(
        `/api/run-intelligence/runs/${encodeURIComponent(requiredString(input, "run"))}/transcript?${buildDirectRunTranscriptQuery(input)}`,
      ));
    case "runs.errors":
      return success(await api.get(
        `/api/run-intelligence/runs/${encodeURIComponent(requiredString(input, "run"))}/errors?${buildDirectRunErrorsQuery(input)}`,
      ));
    case "browser.tabs":
      return success(await api.post("/api/browser/tabs", {}));
    case "browser.user-tabs":
      return success(await api.post("/api/browser/user_tabs", {}));
    case "browser.open":
      return success(await api.post("/api/browser/open", {
        url: requiredString(input, "url"),
      }));
    case "browser.navigate":
      return success(await api.post("/api/browser/navigate", {
        tabId: requiredString(input, "tabId"),
        url: requiredString(input, "url"),
      }));
    case "browser.back":
    case "browser.forward":
    case "browser.reload":
      return success(await api.post(`/api/browser/${capabilityId.slice("browser.".length)}`, {
        tabId: requiredString(input, "tabId"),
      }));
    case "browser.viewport":
      return success(await api.post("/api/browser/viewport", {
        action: requiredString(input, "action"),
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
      }));
    case "browser.visibility":
      return success(await api.post("/api/browser/visibility", {
        ...(typeof input.visible === "boolean" ? { visible: input.visible } : {}),
      }));
    case "browser.snapshot":
    case "browser.locator":
    case "browser.cua":
    case "browser.dialog":
    case "browser.clipboard":
    case "browser.logs":
    case "browser.download":
    case "browser.assets":
    case "browser.content":
    case "browser.wait":
      return success(await api.post(`/api/browser/${capabilityId.slice("browser.".length)}`, input));
    case "browser.dom-cua":
      return success(await api.post("/api/browser/dom_cua", input));
    case "browser.read":
      return success(await api.post("/api/browser/read", {
        tabId: requiredString(input, "tabId"),
      }));
    case "browser.click":
      return success(await api.post("/api/browser/click", {
        tabId: requiredString(input, "tabId"),
        ref: requiredString(input, "ref"),
      }));
    case "browser.type":
      return success(await api.post("/api/browser/type", {
        tabId: requiredString(input, "tabId"),
        ref: requiredString(input, "ref"),
        text: requiredString(input, "text"),
        ...(input.submit === true ? { submit: true } : {}),
      }));
    case "browser.screenshot":
      return success(await api.post("/api/browser/screenshot", input));
    case "browser.close":
      return success(await api.post("/api/browser/close", {
        tabId: requiredString(input, "tabId"),
      }));
    default:
      return null;
  }
}

function buildDirectRunsListQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams({ projection: "summary" });
  appendOptionalQuery(params, "updatedAfter", input.updatedAfter);
  appendOptionalQuery(params, "runIdPrefix", input.runIdPrefix);
  appendOptionalQuery(params, "agentId", input.relatedAgentId);
  appendOptionalQuery(params, "status", input.status);
  appendOptionalQuery(params, "runtime", input.runtime);
  appendOptionalQuery(params, "issueId", input.issueId);
  appendOptionalQuery(params, "usedSkill", input.usedSkill);
  appendOptionalQuery(params, "loadedSkill", input.loadedSkill);
  appendOptionalQuery(params, "createdBefore", input.createdBefore);
  appendOptionalQuery(params, "cursor", input.cursor);
  params.set("limit", String(parsePositiveInteger(input.limit, 50)));
  return params.toString();
}

function buildDirectRunEventsQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams({
    afterSeq: String(parseNonNegativeInteger(input.afterSeq, 0)),
    limit: String(parsePositiveInteger(input.limit, 200)),
    maxChars: String(parsePositiveInteger(input.maxChars, 1200)),
    projection: "compact",
  });
  appendOptionalQuery(params, "cursor", input.cursor);
  return params.toString();
}

function buildDirectRunLogQuery(input: Record<string, unknown>): string {
  return new URLSearchParams({
    offset: String(parseNonNegativeInteger(input.offset, 0)),
    limitBytes: String(parsePositiveInteger(input.limitBytes, 256_000)),
  }).toString();
}

function buildDirectRunTranscriptQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams({
    contextTurns: String(parsePositiveInteger(input.contextTurns, 1)),
    order: input.chronological === true || input.narrative === true ? "oldest" : "newest",
    output: "compact",
    includeOutputs: input.includeOutput === true || input.narrative === true ? "true" : "false",
    maxChars: String(parsePositiveInteger(input.maxChars ?? input.maxOutputChars, 1200)),
  });
  if (input.errorsOnly === true) params.set("errorsOnly", "true");
  appendOptionalQuery(params, "aroundError", input.aroundError);
  appendOptionalQuery(params, "cursor", input.cursor);
  if (input.turnLimit !== undefined) {
    params.set("turnLimit", String(parsePositiveInteger(input.turnLimit, 20)));
  }
  return params.toString();
}

function buildDirectRunErrorsQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams({
    maxChars: String(parsePositiveInteger(input.maxChars, 1200)),
  });
  appendOptionalQuery(params, "cursor", input.cursor);
  return params.toString();
}

function appendOptionalQuery(params: URLSearchParams, key: string, value: unknown): void {
  const rendered = optionalString(value);
  if (rendered) params.set(key, rendered);
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function requiredRuntimeString(env: McpServerEnv, key: keyof McpServerEnv): string {
  const value = optionalString(env[key]);
  if (value) return value;
  const err = new Error(`Rudder MCP runtime context is incomplete. Missing ${String(key)}.`);
  (err as Error & { code?: string }).code = "rudder_mcp_missing_runtime_context";
  throw err;
}

function hasLocalImageInputs(value: unknown): boolean {
  return Array.isArray(value)
    && value.some((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function mcpApiClient(env: McpServerEnv, signal?: AbortSignal): RudderApiClient {
  const apiBase = optionalString(env.RUDDER_API_URL);
  if (!apiBase) {
    const err = new Error("Rudder MCP runtime context is incomplete. Missing RUDDER_API_URL.");
    (err as Error & { code?: string }).code = "rudder_mcp_missing_runtime_context";
    throw err;
  }
  return new RudderApiClient({
    apiBase,
    apiKey: optionalString(env.RUDDER_API_KEY) ?? undefined,
    agentId: optionalString(env.RUDDER_AGENT_ID) ?? undefined,
    runId: optionalString(env.RUDDER_RUN_ID) ?? undefined,
    signal,
  });
}

function mcpSuccess(
  data: unknown,
  maxResultBytes = RUDDER_MCP_MAX_TOOL_RESULT_BYTES,
): Record<string, unknown> {
  if (isRecord(data)
    && (data.mimeType === "image/png" || data.mimeType === "image/jpeg")
    && typeof data.base64 === "string"
    && data.base64.length > 0) {
    const { base64, ...metadata } = data;
    return {
      content: [{ type: "image", data: base64, mimeType: data.mimeType }],
      structuredContent: metadata,
      isError: false,
    };
  }
  return mcpSuccessFromJsonText(JSON.stringify(data ?? {}), maxResultBytes);
}

function mcpSuccessFromJsonText(
  text: string,
  maxResultBytes = RUDDER_MCP_MAX_TOOL_RESULT_BYTES,
): Record<string, unknown> {
  const structured = structuredContentFromJsonText(text);
  const textBytes = Buffer.byteLength(text, "utf8");
  const inlineText = textBytes <= RUDDER_MCP_MAX_INLINE_TEXT_BYTES
    ? text
    : JSON.stringify({
      status: "ok",
      output: "structuredContent",
      originalLength: text.length,
      originalBytes: textBytes,
    });
  const result = {
    content: [{ type: "text", text: inlineText }],
    ...structured,
    isError: false,
  };
  const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (resultBytes <= maxResultBytes) return result;
  return mcpResponseTooLarge(resultBytes, maxResultBytes);
}

function boundedToolCallRpcResponse(
  id: JsonRpcId,
  result: Record<string, unknown>,
  surface: RudderMcpServerSurface,
): Record<string, unknown> {
  const response = rpcResult(id, result);
  const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  const maxBytes = surface === "browser"
    ? RUDDER_BROWSER_MCP_MAX_TOOL_RESULT_BYTES
    : RUDDER_MCP_MAX_TOOL_RESULT_BYTES;
  if (responseBytes <= maxBytes) return response;
  return rpcResult(id, mcpResponseTooLarge(responseBytes, maxBytes));
}

function mcpResponseTooLarge(responseBytes: number, maxBytes = RUDDER_MCP_MAX_TOOL_RESULT_BYTES): Record<string, unknown> {
  const payload = {
    status: "error",
    code: "rudder_mcp_response_too_large",
    message: "Rudder MCP response exceeded the bounded tool-result budget. Use pagination or a ranged log read.",
    details: {
      maxBytes,
      responseBytes,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function parseCsvInput(value: unknown, fallback: string): string[] {
  const source = Array.isArray(value)
    ? value.map((entry) => optionalString(entry)).filter(Boolean).join(",")
    : optionalString(value) || fallback;
  return source
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function cliArgsForCapability(
  capabilityId: string,
  input: Record<string, unknown>,
  tempFiles: TempFilePlan[],
  env: McpServerEnv,
): string[] {
  getAgentCliCapabilityById(capabilityId);

  switch (capabilityId) {
    case "agent.me":
      return ["agent", "me"];
    case "agent.inbox":
      return ["agent", "inbox"];
    case "agent.capabilities":
      return ["agent", "capabilities"];
    case "agent.update": {
      const args = ["agent", "update"];
      pushRuntimeAgentArg(args, input, env, false);
      pushOptional(args, "--name", input.name);
      pushOptional(args, "--role", input.role);
      pushOptional(args, "--title", input.title);
      pushOptional(args, "--capabilities", input.capabilities ?? input.description);
      pushBoolean(args, "--clear-title", input.clearTitle);
      pushBoolean(args, "--clear-capabilities", input.clearCapabilities ?? input.clearDescription);
      return args;
    }
    case "agent.skills.create": {
      const args = ["agent", "skills", "create"];
      pushRuntimeAgentArg(args, input, env, false);
      pushOptional(args, "--name", input.name);
      pushOptional(args, "--slug", input.slug);
      pushOptional(args, "--description", input.description);
      pushOptional(args, "--markdown", input.markdown ?? input.body);
      pushBoolean(args, "--enable", input.enable);
      return args;
    }
    case "agent.skills.enable": {
      const args = ["agent", "skills", "enable"];
      pushRuntimeAgentArg(args, input, env, true);
      pushStringListArgs(args, input.selectionRefs ?? input.selections ?? input.skills, "selectionRefs");
      return args;
    }
    case "agent.skills.sync": {
      const args = ["agent", "skills", "sync"];
      pushRuntimeAgentArg(args, input, env, true);
      pushOptional(args, "--desired-skills", input.desiredSkills);
      return args;
    }
    case "issue.get":
      return ["issue", "get", requiredAnyString(input, ["issue", "issueId"])];
    case "issue.list": {
      const args = ["issue", "list"];
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--assignee-agent-id", input.assigneeAgentId);
      pushOptional(args, "--project-id", input.projectId);
      return args;
    }
    case "issue.search": {
      const args = ["issue", "search", requiredString(input, "query")];
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--assignee-agent-id", input.assigneeAgentId);
      pushOptional(args, "--project-id", input.projectId);
      return args;
    }
    case "issue.context": {
      const args = ["issue", "context", requiredAnyString(input, ["issue", "issueId"])];
      pushOptional(args, "--wake-comment-id", input.wakeCommentId);
      return args;
    }
    case "issue.checkout": {
      const args = ["issue", "checkout", requiredAnyString(input, ["issue", "issueId"])];
      pushOptional(args, "--expected-statuses", input.expectedStatuses);
      return args;
    }
    case "issue.comment": {
      const args = ["issue", "comment", requiredAnyString(input, ["issue", "issueId"])];
      pushBodyFile(args, "--body-file", input.body ?? input.comment, tempFiles);
      pushImages(args, input.images);
      if (input.reopen === true) args.push("--reopen");
      return args;
    }
    case "issue.comments.list": {
      const args = ["issue", "comments", "list", requiredAnyString(input, ["issue", "issueId"])];
      pushOptional(args, "--after", input.after);
      pushOptional(args, "--order", input.order);
      return args;
    }
    case "issue.comments.get":
      return ["issue", "comments", "get", requiredAnyString(input, ["issue", "issueId"]), requiredAnyString(input, ["comment", "commentId"])];
    case "issue.update": {
      const args = ["issue", "update", requiredAnyString(input, ["issue", "issueId"])];
      pushOptional(args, "--title", input.title);
      pushOptional(args, "--description", input.description);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--priority", input.priority);
      pushOptional(args, "--assignee-agent-id", input.assigneeAgentId);
      pushOptional(args, "--project-id", input.projectId);
      pushOptional(args, "--goal-id", input.goalId);
      pushOptional(args, "--parent-id", input.parentId);
      pushOptional(args, "--request-depth", input.requestDepth);
      pushOptional(args, "--billing-code", input.billingCode);
      pushOptional(args, "--hidden-at", input.hiddenAt);
      if (typeof (input.comment ?? input.body) === "string") {
        pushBodyFile(args, "--comment-file", input.comment ?? input.body, tempFiles);
      }
      pushImages(args, input.images);
      return args;
    }
    case "issue.review": {
      const args = ["issue", "review", requiredAnyString(input, ["issue", "issueId"]), "--decision", requiredString(input, "decision")];
      pushBodyFile(args, "--comment-file", input.comment ?? input.body, tempFiles);
      return args;
    }
    case "issue.commit": {
      const args = ["issue", "commit", requiredAnyString(input, ["issue", "issueId"]), "--sha", requiredString(input, "sha"), "--message", requiredString(input, "message")];
      pushOptional(args, "--branch", input.branch);
      pushOptional(args, "--repo-path", input.repoPath);
      pushOptional(args, "--workspace-path", input.workspacePath);
      pushOptional(args, "--count", input.count);
      return args;
    }
    case "issue.done": {
      const args = ["issue", "done", requiredAnyString(input, ["issue", "issueId"])];
      pushBodyFile(args, "--comment-file", input.comment ?? input.body, tempFiles);
      pushImages(args, input.images);
      return args;
    }
    case "issue.block": {
      const args = ["issue", "block", requiredAnyString(input, ["issue", "issueId"])];
      pushBodyFile(args, "--comment-file", input.comment ?? input.body, tempFiles);
      pushImages(args, input.images);
      return args;
    }
    case "project.list":
      return ["project", "list"];
    case "project.get":
      return ["project", "get", requiredAnyString(input, ["project", "projectId"])];
    case "project.create": {
      const args = ["project", "create", "--name", requiredString(input, "name")];
      pushOptional(args, "--description", input.description);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--goal-id", input.goalId);
      pushOptional(args, "--goal-ids", input.goalIds);
      pushOptional(args, "--lead-agent-id", input.leadAgentId);
      pushOptional(args, "--target-date", input.targetDate);
      pushOptional(args, "--color", input.color);
      return args;
    }
    case "project.update": {
      const args = ["project", "update", requiredAnyString(input, ["project", "projectId"])];
      pushOptional(args, "--name", input.name);
      pushOptional(args, "--description", input.description);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--goal-id", input.goalId);
      pushOptional(args, "--goal-ids", input.goalIds);
      pushOptional(args, "--lead-agent-id", input.leadAgentId);
      pushOptional(args, "--target-date", input.targetDate);
      pushOptional(args, "--color", input.color);
      pushOptional(args, "--archived-at", input.archivedAt);
      return args;
    }
    case "user.activity": {
      const args = ["user", "activity"];
      pushOptional(args, "--user", input.user);
      pushOptional(args, "--since", input.since);
      pushOptional(args, "--until", input.until);
      pushOptional(args, "--include", input.include);
      pushOptional(args, "--agent-id", input.relatedAgentId);
      pushOptional(args, "--project-id", input.projectId);
      pushOptional(args, "--issue-id", input.issueId);
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--cursor", input.cursor);
      return args;
    }
    case "library.file.list":
      return ["library", "file", "list", optionalString(input.directory ?? input.path) ?? optionalString(env.RUDDER_PROJECT_LIBRARY_PATH) ?? "projects"];
    case "library.file.get":
      return ["library", "file", "get", requiredString(input, "path")];
    case "library.file.ref":
      return ["library", "file", "ref", requiredString(input, "path")];
    case "library.file.link":
      return ["library", "file", "link", requiredString(input, "path")];
    case "library.file.put": {
      const args = ["library", "file", "put", requiredString(input, "path")];
      pushBodyFile(args, "--body-file", input.body ?? input.content, tempFiles);
      return args;
    }
    case "approval.get":
      return ["approval", "get", requiredAnyString(input, ["approval", "approvalId"])];
    case "approval.issues":
      return ["approval", "issues", requiredAnyString(input, ["approval", "approvalId"])];
    case "approval.comment": {
      const args = ["approval", "comment", requiredAnyString(input, ["approval", "approvalId"])];
      pushBodyFile(args, "--body-file", input.body ?? input.comment, tempFiles);
      return args;
    }
    case "skill.list":
      return ["skill", "list"];
    case "skill.get":
      return ["skill", "get", requiredAnyString(input, ["skill", "skillId"])];
    case "skill.file": {
      const args = ["skill", "file", requiredAnyString(input, ["skill", "skillId"])];
      pushOptional(args, "--path", input.path);
      return args;
    }
    case "skill.import": {
      const args = ["skill", "import", "--source", requiredString(input, "source")];
      return args;
    }
    case "skill.scan-local": {
      const args = ["skill", "scan-local"];
      pushOptional(args, "--roots", input.roots);
      return args;
    }
    case "skill.scan-projects": {
      const args = ["skill", "scan-projects"];
      pushOptional(args, "--project-ids", input.projectIds);
      pushOptional(args, "--workspace-ids", input.workspaceIds);
      return args;
    }
    case "browser.tabs":
      return ["browser", "tabs"];
    case "browser.user-tabs":
      return ["browser", "user-tabs"];
    case "browser.open":
      return ["browser", "open", requiredString(input, "url")];
    case "browser.navigate":
      return ["browser", "navigate", requiredString(input, "tabId"), requiredString(input, "url")];
    case "browser.back":
      return ["browser", "back", requiredString(input, "tabId")];
    case "browser.forward":
      return ["browser", "forward", requiredString(input, "tabId")];
    case "browser.reload":
      return ["browser", "reload", requiredString(input, "tabId")];
    case "browser.viewport": {
      const args = ["browser", "viewport", "--action", requiredString(input, "action")];
      pushOptional(args, "--width", input.width);
      pushOptional(args, "--height", input.height);
      return args;
    }
    case "browser.visibility": {
      const args = ["browser", "visibility"];
      if (typeof input.visible === "boolean") args.push("--visible", String(input.visible));
      return args;
    }
    case "browser.snapshot":
    case "browser.locator":
    case "browser.cua":
    case "browser.dom-cua":
    case "browser.dialog":
    case "browser.logs":
    case "browser.download":
    case "browser.assets":
    case "browser.content":
    case "browser.wait": {
      const tabId = requiredString(input, "tabId");
      const payload = { ...input };
      delete payload.tabId;
      return ["browser", capabilityId.slice("browser.".length), tabId, "--input", JSON.stringify(payload)];
    }
    case "browser.clipboard":
      return ["browser", "clipboard", "--input", JSON.stringify(input)];
    case "browser.read":
      return ["browser", "read", requiredString(input, "tabId")];
    case "browser.click":
      return ["browser", "click", requiredString(input, "tabId"), requiredString(input, "ref")];
    case "browser.type": {
      const args = ["browser", "type", requiredString(input, "tabId"), requiredString(input, "ref"), "--text", requiredString(input, "text")];
      pushBoolean(args, "--submit", input.submit);
      return args;
    }
    case "browser.screenshot": {
      const tabId = requiredString(input, "tabId");
      const payload = { ...input };
      delete payload.tabId;
      return Object.keys(payload).length > 0
        ? ["browser", "screenshot", tabId, "--input", JSON.stringify(payload)]
        : ["browser", "screenshot", tabId];
    }
    case "browser.close":
      return ["browser", "close", requiredString(input, "tabId")];
    case "automation.list": {
      const args = ["automation", "list"];
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--assignee-agent-id", input.assigneeAgentId);
      pushOptional(args, "--project-id", input.projectId);
      pushOptional(args, "--output-mode", input.outputMode);
      return args;
    }
    case "automation.get":
      return ["automation", "get", requiredAnyString(input, ["automation", "automationId"])];
    case "automation.runs": {
      const args = ["automation", "runs", requiredAnyString(input, ["automation", "automationId"])];
      pushOptional(args, "--limit", input.limit);
      return args;
    }
    case "automation.triggers.list":
      return ["automation", "triggers", "list", requiredAnyString(input, ["automation", "automationId"])];
    case "automation.triggers.create": {
      const args = ["automation", "triggers", "create", requiredAnyString(input, ["automation", "automationId"])];
      pushJson(args, "--payload", input.payload);
      pushOptional(args, "--kind", input.kind);
      pushOptional(args, "--label", input.label);
      pushBoolean(args, "--enabled", input.enabled);
      pushBoolean(args, "--disabled", input.disabled);
      pushOptional(args, "--cron-expression", input.cronExpression);
      pushOptional(args, "--timezone", input.timezone);
      pushOptional(args, "--signing-mode", input.signingMode);
      pushOptional(args, "--replay-window-sec", input.replayWindowSec);
      return args;
    }
    case "automation.triggers.update": {
      const args = ["automation", "triggers", "update", requiredAnyString(input, ["trigger", "triggerId"])];
      pushJson(args, "--payload", input.payload);
      pushOptional(args, "--label", input.label);
      pushBoolean(args, "--enabled", input.enabled);
      pushBoolean(args, "--disabled", input.disabled);
      pushOptional(args, "--cron-expression", input.cronExpression);
      pushOptional(args, "--timezone", input.timezone);
      pushOptional(args, "--signing-mode", input.signingMode);
      pushOptional(args, "--replay-window-sec", input.replayWindowSec);
      return args;
    }
    case "automation.triggers.delete":
      return ["automation", "triggers", "delete", requiredAnyString(input, ["trigger", "triggerId"])];
    case "automation.triggers.rotate-secret":
      return ["automation", "triggers", "rotate-secret", requiredAnyString(input, ["trigger", "triggerId"])];
    case "automation.create": {
      const args = ["automation", "create"];
      pushJson(args, "--payload", input.payload);
      pushOptional(args, "--title", input.title);
      pushOptional(args, "--instructions", input.instructions ?? input.description);
      pushOptional(args, "--assignee-agent-id", input.assigneeAgentId);
      pushOptional(args, "--project-id", input.projectId);
      pushOptional(args, "--goal-id", input.goalId);
      pushOptional(args, "--parent-issue-id", input.parentIssueId);
      pushOptional(args, "--priority", input.priority);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--output-mode", input.outputMode);
      pushOptional(args, "--concurrency-policy", input.concurrencyPolicy);
      pushOptional(args, "--catch-up-policy", input.catchUpPolicy);
      pushBoolean(args, "--notify-on-issue-created", input.notifyOnIssueCreated);
      return args;
    }
    case "automation.update": {
      const args = ["automation", "update", requiredAnyString(input, ["automation", "automationId"])];
      pushJson(args, "--payload", input.payload);
      pushOptional(args, "--title", input.title);
      pushOptional(args, "--instructions", input.instructions ?? input.description);
      pushOptional(args, "--assignee-agent-id", input.assigneeAgentId);
      pushOptional(args, "--project-id", input.projectId);
      pushOptional(args, "--goal-id", input.goalId);
      pushOptional(args, "--parent-issue-id", input.parentIssueId);
      pushOptional(args, "--priority", input.priority);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--output-mode", input.outputMode);
      pushOptional(args, "--concurrency-policy", input.concurrencyPolicy);
      pushOptional(args, "--catch-up-policy", input.catchUpPolicy);
      pushBoolean(args, "--notify-on-issue-created", input.notifyOnIssueCreated);
      return args;
    }
    case "automation.enable":
      return ["automation", "enable", requiredAnyString(input, ["automation", "automationId"])];
    case "automation.disable":
      return ["automation", "disable", requiredAnyString(input, ["automation", "automationId"])];
    case "automation.run": {
      const args = ["automation", "run", requiredAnyString(input, ["automation", "automationId"])];
      pushOptional(args, "--trigger-id", input.triggerId);
      pushJson(args, "--payload", input.payload);
      pushOptional(args, "--idempotency-key", input.idempotencyKey);
      pushOptional(args, "--source", input.source);
      return args;
    }
    case "chat.list": {
      const args = ["chat", "list"];
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--query", input.query);
      pushOptional(args, "--limit", input.limit);
      return args;
    }
    case "chat.search": {
      const args = ["chat", "search", requiredString(input, "query")];
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--scope", input.scope);
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--snippet-chars", input.snippetChars);
      return args;
    }
    case "chat.get":
      return ["chat", "get", requiredAnyString(input, ["chat", "chatId"])];
    case "chat.messages": {
      const args = ["chat", "messages", requiredAnyString(input, ["chat", "chatId"])];
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--max-output-chars", input.maxOutputChars);
      pushBoolean(args, "--include-transcript", input.includeTranscript ?? input.includeOutput);
      return args;
    }
    case "chat.transcript": {
      const args = ["chat", "transcript", requiredAnyString(input, ["chat", "chatId"])];
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--max-output-chars", input.maxOutputChars);
      return args;
    }
    case "chat.read": {
      const args = ["chat", "read", requiredAnyString(input, ["chat", "chatId"])];
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--turn-limit", input.turnLimit);
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--max-output-chars", input.maxOutputChars);
      pushBoolean(args, "--include-transcript", input.includeTranscript ?? input.includeOutput);
      return args;
    }
    case "chat.create": {
      const args = ["chat", "create", "--body", requiredString(input, "body")];
      pushJson(args, "--payload", input.payload);
      pushOptional(args, "--title", input.title);
      pushOptional(args, "--summary", input.summary);
      pushOptional(args, "--preferred-agent-id", input.preferredAgentId);
      pushOptional(args, "--issue-creation-mode", input.issueCreationMode);
      pushBoolean(args, "--plan-mode", input.planMode);
      return args;
    }
    case "chat.send": {
      const args = ["chat", "send", requiredAnyString(input, ["chat", "chatId"]), "--body", requiredString(input, "body")];
      pushOptional(args, "--edit-user-message-id", input.editUserMessageId);
      return args;
    }
    case "chat.archive":
      return ["chat", "archive", requiredAnyString(input, ["chat", "chatId"])];
    case "runs.list": {
      const args = ["runs", "list"];
      pushOptional(args, "--updated-after", input.updatedAfter);
      pushOptional(args, "--run-id-prefix", input.runIdPrefix);
      pushOptional(args, "--agent-id", input.relatedAgentId);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--runtime", input.runtime);
      pushOptional(args, "--issue-id", input.issueId);
      pushOptional(args, "--used-skill", input.usedSkill);
      pushOptional(args, "--loaded-skill", input.loadedSkill);
      pushOptional(args, "--created-before", input.createdBefore);
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--limit", input.limit);
      return args;
    }
    case "runs.by-skill": {
      const args = ["runs", "by-skill", requiredString(input, "skill")];
      pushOptional(args, "--evidence", input.evidence);
      pushOptional(args, "--agent-id", input.relatedAgentId);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--runtime", input.runtime);
      pushOptional(args, "--issue-id", input.issueId);
      pushOptional(args, "--created-before", input.createdBefore);
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--limit", input.limit);
      return args;
    }
    case "runs.get":
      return ["runs", "get", requiredString(input, "run")];
    case "runs.events": {
      const args = ["runs", "events", requiredString(input, "run")];
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--after-seq", input.afterSeq);
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--max-chars", input.maxChars);
      return args;
    }
    case "runs.log": {
      const args = ["runs", "log", requiredString(input, "run")];
      pushOptional(args, "--max-chars", input.maxChars);
      pushOptional(args, "--offset", input.offset);
      pushOptional(args, "--limit-bytes", input.limitBytes);
      return args;
    }
    case "runs.transcript": {
      const args = ["runs", "transcript", requiredString(input, "run")];
      pushBoolean(args, "--errors-only", input.errorsOnly);
      pushOptional(args, "--around-error", input.aroundError);
      pushOptional(args, "--context-turns", input.contextTurns);
      pushOptional(args, "--cursor", input.cursor);
      pushOptional(args, "--turn-limit", input.turnLimit);
      pushBoolean(args, "--chronological", input.chronological);
      pushBoolean(args, "--narrative", input.narrative);
      pushOptional(args, "--max-chars", input.maxChars ?? input.maxOutputChars);
      pushBoolean(args, "--include-output", input.includeOutput);
      return args;
    }
    case "runs.errors": {
      const args = ["runs", "errors", requiredString(input, "run")];
      pushOptional(args, "--max-chars", input.maxChars);
      pushOptional(args, "--cursor", input.cursor);
      return args;
    }
    case "runs.cancel":
      return ["runs", "cancel", requiredString(input, "run")];
    case "runs.retry":
      return ["runs", "retry", requiredString(input, "run")];
    default:
      throw new Error(`Rudder MCP tool is not implemented: ${capabilityId}`);
  }
}

function toMcpToolListEntry(
  tool: AgentV1McpToolManifestEntry,
): ReturnType<typeof rudderMcpSemanticToolContract> {
  return rudderMcpSemanticToolContract(tool);
}

function requestedProtocolVersion(params: unknown): string | null {
  if (!isRecord(params)) return null;
  return typeof params.protocolVersion === "string" && params.protocolVersion.trim().length > 0
    ? params.protocolVersion.trim()
    : null;
}

function toolNameToCapabilityId(toolName: string): string | null {
  const manifest = buildAgentV1McpToolsManifest("agent-v1", { surface: "all" });
  return manifest.tools.find((tool) => tool.name === toolName)?.id ?? null;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`Missing required argument: ${key}`);
}

function requiredAnyString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = optionalString(input[key]);
    if (value) return value;
  }
  throw new Error(`Missing required argument: ${keys[0]}`);
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pushOptional(args: string[], flag: string, value: unknown): void {
  const rendered = optionalString(renderCsv(value));
  if (rendered) args.push(flag, rendered);
}

function pushBoolean(args: string[], flag: string, value: unknown): void {
  if (value === true) args.push(flag);
}

function pushBodyFile(args: string[], flag: string, value: unknown, tempFiles: TempFilePlan[]): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required body for ${flag}`);
  }
  args.push(flag, `<${flag}:temp>`);
  tempFiles.push({ flag, contents: value });
}

function pushJson(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim().length > 0) {
    args.push(flag, value.trim());
    return;
  }
  if (isRecord(value) || Array.isArray(value)) {
    args.push(flag, JSON.stringify(value));
  }
}

function pushImages(args: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const image of value) {
    if (typeof image === "string" && image.trim().length > 0) args.push("--image", image.trim());
  }
}

function normalizeLegacyToolArguments(
  capabilityId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = LEGACY_ARGUMENT_ALIASES[capabilityId];
  if (!aliases) return input;

  const normalized = { ...input };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(alias in normalized)) continue;
    if (!(canonical in normalized)) normalized[canonical] = normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

function pushStringListArgs(args: string[], value: unknown, key: string): void {
  const values = Array.isArray(value)
    ? value.map((entry) => optionalString(entry)).filter((entry): entry is string => Boolean(entry))
    : optionalString(value)?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (values.length === 0) {
    throw new Error(`Missing required argument: ${key}`);
  }
  args.push(...values);
}

function pushRuntimeAgentArg(
  args: string[],
  _input: Record<string, unknown>,
  env: McpServerEnv,
  required: boolean,
): void {
  const agent = optionalString(env.RUDDER_AGENT_ID);
  if (agent) {
    args.push(agent);
    return;
  }
  if (required) {
    throw new Error("Runtime agent ID is required. Set RUDDER_AGENT_ID.");
  }
}

function rejectModelProvidedRuntimeIdentity(input: Record<string, unknown>): void {
  const reserved = Object.keys(input).filter((key) =>
    RESERVED_MODEL_ARGUMENTS.has(key) ||
    RESERVED_MODEL_ARGUMENTS.has(key.toLowerCase()) ||
    NORMALIZED_RESERVED_MODEL_ARGUMENTS.has(normalizeRuntimeIdentityKey(key)) ||
    key.toUpperCase().startsWith("RUDDER_")
  );
  if (reserved.length === 0) return;
  const err = new Error(`Rudder MCP runtime identity is managed by the server; do not pass these arguments: ${reserved.sort().join(", ")}`);
  (err as Error & { code?: string }).code = "rudder_mcp_reserved_identity_argument";
  throw err;
}

function rejectUnsupportedToolArguments(toolName: string, input: Record<string, unknown>): void {
  const tool = buildAgentV1McpToolsManifest("agent-v1", { surface: "all" }).tools
    .find((entry) => entry.name === toolName);

  if (!tool) return;
  const supported = new Set(Object.keys(tool.inputSchema.properties));
  const unsupported = Object.keys(input).filter((key) => !supported.has(key)).sort();
  if (unsupported.length === 0) return;
  const err = new Error(`Unsupported argument${unsupported.length === 1 ? "" : "s"} for ${toolName}: ${unsupported.join(", ")}`);
  (err as Error & { code?: string }).code = "rudder_mcp_invalid_arguments";
  throw err;
}

function validateMcpToolArguments(toolName: string, input: Record<string, unknown>): void {
  const tool = buildAgentV1McpToolsManifest("agent-v1", { surface: "all" }).tools
    .find((entry) => entry.name === toolName);
  if (!tool) return;

  const schema = tool.inputSchema as typeof tool.inputSchema & {
    anyOf?: Array<{ required?: unknown }>;
  };
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    const value = input[key];
    const missing = value === undefined
      || value === null
      || (typeof value === "string" && value.trim().length === 0)
      || (Array.isArray(value) && value.length === 0);
    if (missing) throwInvalidMcpArgument(toolName, key, "is required");
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => {
      if (!isRecord(candidate) || !Array.isArray(candidate.required)) return false;
      return candidate.required.every((key) => {
        const value = input[String(key)];
        return value !== undefined
          && value !== null
          && !(typeof value === "string" && value.trim().length === 0)
          && !(Array.isArray(value) && value.length === 0);
      });
    });
    if (!matches) {
      const alternatives = schema.anyOf
        .flatMap((candidate) => isRecord(candidate) && Array.isArray(candidate.required) ? candidate.required : [])
        .map(String);
      throwInvalidMcpArgument(toolName, alternatives.join(" or "), "is required");
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key];
    if (!isRecord(property) || value === undefined) continue;
    const violation = jsonSchemaViolation(value, property);
    if (violation) throwInvalidMcpArgument(toolName, key, violation);
  }
}

function jsonSchemaViolation(value: unknown, schema: Record<string, unknown>): string | null {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.some((candidate) =>
      isRecord(candidate) && jsonSchemaViolation(value, candidate) === null
    );
    if (!matches) return "does not match any allowed shape";
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length > 0) {
    const validType = types.some((type) => (
      type === "string" ? typeof value === "string"
        : type === "number" ? typeof value === "number" && Number.isFinite(value)
          : type === "boolean" ? typeof value === "boolean"
            : type === "array" ? Array.isArray(value)
              : type === "object" ? isRecord(value)
                : false
    ));
    if (!validType) return `must be ${types.join(" or ")}`;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `must contain at least ${schema.minLength} character(s)`;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `must contain at most ${schema.maxLength} characters`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `must be one of: ${schema.enum.join(", ")}`;
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `must be at least ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `must be at most ${schema.maximum}`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `must contain at least ${schema.minItems} items`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `must contain at most ${schema.maxItems} items`;
    }
    if (isRecord(schema.items)) {
      for (const [index, item] of value.entries()) {
        const violation = jsonSchemaViolation(item, schema.items);
        if (violation) return `item ${index} ${violation}`;
      }
    }
  }
  if (isRecord(value) && schema.type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in value)) return `field ${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const unsupported = Object.keys(value).filter((key) => !(key in properties));
      if (unsupported.length > 0) return `contains unsupported field(s): ${unsupported.sort().join(", ")}`;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!isRecord(childSchema)) continue;
      const violation = jsonSchemaViolation(child, childSchema);
      if (violation) return `field ${key} ${violation}`;
    }
  }
  return null;
}

function throwInvalidMcpArgument(toolName: string, key: string, reason: string): never {
  const err = new Error(`Invalid argument for ${toolName}: ${key} ${reason}. Consult tools/list for the exact schema.`);
  (err as Error & { code?: string }).code = "rudder_mcp_invalid_arguments";
  throw err;
}

const READ_ONLY_BROWSER_LOCATOR_ACTIONS = new Set([
  "count", "allTextContents", "textContent", "innerText", "attribute",
  "visible", "enabled", "checked", "selected", "wait",
]);

function rejectUnsupportedBrowserLocatorAction(toolName: string, input: Record<string, unknown>): void {
  const locatorActionUnsupported = toolName === "rudder_browser_locator"
    && !READ_ONLY_BROWSER_LOCATOR_ACTIONS.has(String(input.action));
  const downloadModeUnsupported = toolName === "rudder_browser_download" && input.mode !== "media";
  if (!locatorActionUnsupported && !downloadModeUnsupported) return;
  const err = new Error(locatorActionUnsupported
    ? "rudder_browser_locator is read-only; use rudder_browser_click, rudder_browser_type, or rudder_browser_cua to interact."
    : "rudder_browser_download supports read-only media downloads only; use an explicit interaction tool before reading download evidence.");
  (err as Error & { code?: string }).code = "rudder_mcp_invalid_arguments";
  throw err;
}

function normalizeRuntimeIdentityKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function assertRuntimeMcpContext(
  capability: { requiresOrgId: boolean; requiresAgentId: boolean; requiresRunId: boolean },
  env: McpServerEnv,
): void {
  const missing: string[] = [];
  if (!optionalString(env.RUDDER_API_URL)) missing.push("RUDDER_API_URL");
  if (!optionalString(env.RUDDER_API_KEY)) missing.push("RUDDER_API_KEY");
  if (capability.requiresOrgId && !optionalString(env.RUDDER_ORG_ID)) missing.push("RUDDER_ORG_ID");
  if (capability.requiresAgentId && !optionalString(env.RUDDER_AGENT_ID)) missing.push("RUDDER_AGENT_ID");
  if (capability.requiresRunId && !optionalString(env.RUDDER_RUN_ID)) missing.push("RUDDER_RUN_ID");
  if (missing.length === 0) return;
  const err = new Error(`Rudder MCP runtime context is incomplete. Missing ${missing.join(", ")}.`);
  (err as Error & { code?: string }).code = "rudder_mcp_missing_runtime_context";
  throw err;
}

function browserCapabilityEnabled(env: McpServerEnv): boolean {
  return optionalString(env.RUDDER_BROWSER_ENABLED)?.toLowerCase() === "true";
}

function assertBrowserCapabilityEnabled(capabilityId: string, env: McpServerEnv): void {
  if (!capabilityId.startsWith("browser.") || browserCapabilityEnabled(env)) return;
  const error = new Error("Rudder Browser is disabled or unavailable for this run.");
  (error as Error & { code?: string }).code = "browser_disabled";
  throw error;
}

function structuredContentFromJsonText(text: string): { structuredContent?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) return { structuredContent: parsed };
    return { structuredContent: { result: parsed } };
  } catch {
    return {};
  }
}

function renderCsv(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => optionalString(entry)).filter(Boolean).join(",");
}

function runRudderCli(args: string[], env: McpServerEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const invocation = resolveRudderCliInvocation(args, env);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

export function resolveRudderCliInvocation(
  args: string[],
  env: McpServerEnv,
): { command: string; args: string[] } {
  if (env.RUDDER_MCP_RUDDER_BIN) {
    return { command: env.RUDDER_MCP_RUDDER_BIN, args };
  }

  const modulePath = fileURLToPath(new URL("./index.js", import.meta.url));
  if (existsSync(modulePath)) {
    return { command: process.execPath, args: [modulePath, ...args] };
  }

  if (hasRunnableRudderOnPath(env)) {
    return { command: "rudder", args };
  }

  return {
    command: process.execPath,
    args: [modulePath, ...args],
  };
}

function hasRunnableRudderOnPath(env: McpServerEnv): boolean {
  const probe = spawnSync("rudder", ["--version"], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !probe.error;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorDetails(err: unknown): unknown {
  if (!(err instanceof Error)) return undefined;
  const code = (err as Error & { code?: unknown }).code;
  return code ? { code } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
