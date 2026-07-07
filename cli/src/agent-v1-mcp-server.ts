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
import { RudderApiClient } from "./client/http.js";

export const RUDDER_MCP_SERVER_NAME = "rudder-control-plane";

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
  RUDDER_PROJECT_LIBRARY_PATH?: string;
  RUDDER_MCP_RUDDER_BIN?: string;
  [key: string]: string | undefined;
}

type McpStdioMode = "framed" | "newline";
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
    RUDDER_PROJECT_LIBRARY_PATH: env.RUDDER_PROJECT_LIBRARY_PATH,
    RUDDER_MCP_RUDDER_BIN: env.RUDDER_MCP_RUDDER_BIN,
  };
}

export function buildAgentV1ToolCallPlan(
  toolName: string,
  rawArgs: unknown,
  env: McpServerEnv = buildMcpServerEnv(),
): AgentV1ToolCallPlan {
  const input = isRecord(rawArgs) ? rawArgs : {};
  const capabilityId = toolNameToCapabilityId(toolName);
  if (!capabilityId) {
    throw new Error(`Unknown Rudder MCP tool: ${toolName}`);
  }
  const capability = getAgentCliCapabilityById(capabilityId);
  rejectModelProvidedRuntimeIdentity(input);
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
      RUDDER_PROJECT_LIBRARY_PATH: env.RUDDER_PROJECT_LIBRARY_PATH,
    },
    tempFiles,
  };
}

export async function runAgentV1McpJsonRpcMessage(
  message: JsonRpcRequest,
  env: McpServerEnv = buildMcpServerEnv(),
): Promise<Record<string, unknown> | null> {
  const isNotification = message.id === undefined;
  const id = message.id ?? null;
  try {
    switch (message.method) {
      case "notifications/initialized":
        return isNotification ? null : rpcResult(id, {});
      case "initialize":
        return rpcResult(id, {
          protocolVersion: requestedProtocolVersion(message.params) ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: RUDDER_MCP_SERVER_NAME, version: "1.0.0" },
        });
      case "tools/list":
        return rpcResult(id, {
          tools: buildAgentV1McpToolsManifest("agent-v1").tools.map(toMcpToolListEntry),
        });
      case "tools/call":
        return rpcResult(id, await callToolSafely(message.params, env));
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Unsupported JSON-RPC method: ${String(message.method ?? "")}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, -32000, errorMessage(err), errorDetails(err));
  }
}

export async function runMcpStdioServer(env: McpServerEnv = buildMcpServerEnv()): Promise<void> {
  let buffer = "";
  let mode: McpStdioMode | null = null;
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const parsed = parseMcpStdioMessages(buffer, mode);
    mode = parsed.mode ?? mode;
    buffer = parsed.remainder;
    for (const message of parsed.messages) {
      const response = await runAgentV1McpJsonRpcMessage(message, env);
      if (!response) continue;
      const payload = JSON.stringify(response);
      process.stdout.write(parsed.mode === "framed"
        ? `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`
        : `${payload}\n`);
    }
  }
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

async function callToolSafely(params: unknown, env: McpServerEnv): Promise<Record<string, unknown>> {
  try {
    return await callTool(params, env);
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

async function callTool(params: unknown, env: McpServerEnv): Promise<Record<string, unknown>> {
  const record = isRecord(params) ? params : {};
  const toolName = typeof record.name === "string" ? record.name : "";
  const args = record.arguments;
  const plan = buildAgentV1ToolCallPlan(toolName, args, env);
  const directResult = await callToolDirectlyIfSupported(toolName, args, env);
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
      return {
        content: [{ type: "text", text }],
        ...structuredContentFromJsonText(text),
        isError: false,
      };
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
): Promise<Record<string, unknown> | null> {
  const capabilityId = toolNameToCapabilityId(toolName);
  if (!capabilityId) return null;
  const input = isRecord(rawArgs) ? rawArgs : {};
  const api = mcpApiClient(env);

  switch (capabilityId) {
    case "agent.me":
      return mcpSuccess(await api.get("/api/agents/me"));
    case "agent.inbox":
      return mcpSuccess(await api.get("/api/agents/me/inbox-lite"));
    case "issue.get":
      return mcpSuccess(await api.get(`/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}`));
    case "issue.context": {
      const params = new URLSearchParams();
      const wakeCommentId = optionalString(input.wakeCommentId);
      if (wakeCommentId) params.set("wakeCommentId", wakeCommentId);
      const query = params.toString();
      return mcpSuccess(await api.get(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}/heartbeat-context${query ? `?${query}` : ""}`,
      ));
    }
    case "issue.checkout": {
      const expectedStatuses = parseCsvInput(input.expectedStatuses, "todo,backlog,blocked");
      const payload = checkoutIssueSchema.parse({
        agentId: optionalString(env.RUDDER_AGENT_ID),
        expectedStatuses,
      });
      return mcpSuccess(await api.post(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}/checkout`,
        payload,
      ));
    }
    case "issue.comment": {
      const payload = addIssueCommentSchema.parse({
        body: requiredAnyString(input, ["body", "comment"]),
        reopen: input.reopen === true ? true : undefined,
      });
      return mcpSuccess(await api.post(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}/comments`,
        payload,
      ));
    }
    case "issue.done": {
      const comment = requiredAnyString(input, ["comment", "body"]);
      return mcpSuccess(await api.patch(
        `/api/issues/${encodeURIComponent(requiredAnyString(input, ["issue", "issueId"]))}`,
        { status: "done", comment },
      ));
    }
    default:
      return null;
  }
}

function mcpApiClient(env: McpServerEnv): RudderApiClient {
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
  });
}

function mcpSuccess(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data ?? {});
  return {
    content: [{ type: "text", text }],
    ...structuredContentFromJsonText(text),
    isError: false,
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
      pushOptional(args, "--reports-to", input.reportsTo);
      pushBoolean(args, "--clear-title", input.clearTitle);
      pushBoolean(args, "--clear-capabilities", input.clearCapabilities ?? input.clearDescription);
      pushBoolean(args, "--clear-reports-to", input.clearReportsTo);
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
      const args = ["chat", "create"];
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
      pushOptional(args, "--limit", input.limit);
      return args;
    }
    case "runs.get":
      return ["runs", "get", requiredString(input, "run")];
    case "runs.events":
      return ["runs", "events", requiredString(input, "run")];
    case "runs.log": {
      const args = ["runs", "log", requiredString(input, "run")];
      pushOptional(args, "--max-chars", input.maxChars);
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

function toMcpToolListEntry(tool: AgentV1McpToolManifestEntry): Record<string, unknown> {
  return {
    name: tool.name,
    description: `${tool.description} Mutating: ${tool.mutating ? "yes" : "no"}. Runtime identity and authorization are injected by the Rudder-managed MCP server and are not accepted as tool input. Org context: ${tool.requiresOrgId ? "required from runtime env" : "not required by this tool"}. Agent context: ${tool.requiresAgentId ? "required from runtime env" : "runtime env when available"}. Run attribution: ${tool.attachesRunIdWhenAvailable ? "attached from runtime env when available" : "not attached"}.`,
    inputSchema: tool.inputSchema,
  };
}

function requestedProtocolVersion(params: unknown): string | null {
  if (!isRecord(params)) return null;
  return typeof params.protocolVersion === "string" && params.protocolVersion.trim().length > 0
    ? params.protocolVersion.trim()
    : null;
}

function toolNameToCapabilityId(toolName: string): string | null {
  const manifest = buildAgentV1McpToolsManifest("agent-v1");
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

function normalizeRuntimeIdentityKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function assertRuntimeMcpContext(
  capability: { requiresOrgId: boolean; requiresAgentId: boolean },
  env: McpServerEnv,
): void {
  const missing: string[] = [];
  if (!optionalString(env.RUDDER_API_URL)) missing.push("RUDDER_API_URL");
  if (!optionalString(env.RUDDER_API_KEY)) missing.push("RUDDER_API_KEY");
  if (capability.requiresOrgId && !optionalString(env.RUDDER_ORG_ID)) missing.push("RUDDER_ORG_ID");
  if (capability.requiresAgentId && !optionalString(env.RUDDER_AGENT_ID)) missing.push("RUDDER_AGENT_ID");
  if (missing.length === 0) return;
  const err = new Error(`Rudder MCP runtime context is incomplete. Missing ${missing.join(", ")}.`);
  (err as Error & { code?: string }).code = "rudder_mcp_missing_runtime_context";
  throw err;
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
