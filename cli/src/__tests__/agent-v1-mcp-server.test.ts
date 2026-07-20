import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_CONTRACT_VERSION,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentV1ToolCallPlan,
  buildMcpServerEnv,
  parseMcpStdioMessages,
  resolveRudderCliInvocation,
  runAgentV1McpJsonRpcMessage,
} from "../agent-v1-mcp-server.js";
import { buildAgentV1McpToolsManifest } from "../agent-v1-registry.js";

const SAMPLE_INPUT_BY_TOOL: Record<string, Record<string, unknown>> = {
  rudder_agent_update: { title: "Runtime Agent" },
  rudder_agent_skills_create: { name: "local-helper", description: "Local helper" },
  rudder_agent_skills_enable: { selectionRefs: ["rudder/rudder-docs"] },
  rudder_agent_skills_sync: { desiredSkills: "rudder/rudder-docs" },
  rudder_issue_get: { issue: "ZST-123" },
  rudder_issue_search: { query: "checkout" },
  rudder_issue_context: { issue: "ZST-123", wakeCommentId: "cmt_abc123" },
  rudder_issue_checkout: { issue: "ZST-123" },
  rudder_issue_comment: { issue: "ZST-123", body: "Progress" },
  rudder_issue_comments_list: { issue: "ZST-123" },
  rudder_issue_comments_get: { issue: "ZST-123", comment: "cmt_abc123" },
  rudder_issue_update: { issue: "ZST-123", status: "in_progress", comment: "Updated" },
  rudder_issue_review: { issue: "ZST-123", decision: "approve", comment: "Looks good" },
  rudder_issue_commit: { issue: "ZST-123", sha: "abc123", message: "feat: test" },
  rudder_issue_done: { issue: "ZST-123", comment: "Done" },
  rudder_issue_block: { issue: "ZST-123", comment: "Blocked" },
  rudder_project_get: { project: "proj_123" },
  rudder_project_create: { name: "MCP project" },
  rudder_project_update: { project: "proj_123", status: "in_progress" },
  rudder_library_file_list: { directory: "projects" },
  rudder_library_file_get: { path: "projects/demo/file.md" },
  rudder_library_file_ref: { path: "projects/demo/file.md" },
  rudder_library_file_link: { path: "projects/demo/file.md" },
  rudder_library_file_put: { path: "projects/demo/file.md", body: "# Demo" },
  rudder_approval_get: { approval: "apr_123" },
  rudder_approval_issues: { approval: "apr_123" },
  rudder_approval_comment: { approval: "apr_123", body: "Question" },
  rudder_skill_get: { skill: "skill_123" },
  rudder_skill_file: { skill: "skill_123", path: "SKILL.md" },
  rudder_skill_import: { source: "/tmp/skill" },
  rudder_skill_scan_local: { roots: "/tmp/skills" },
  rudder_skill_scan_projects: { projectIds: "proj_123" },
  rudder_browser_open: { url: "https://example.com" },
  rudder_browser_navigate: { tabId: "tab-1", url: "https://example.com/next" },
  rudder_browser_read: { tabId: "tab-1" },
  rudder_browser_click: { tabId: "tab-1", ref: "ref-1" },
  rudder_browser_type: { tabId: "tab-1", ref: "ref-1", text: "hello", submit: true },
  rudder_browser_screenshot: { tabId: "tab-1" },
  rudder_browser_close: { tabId: "tab-1" },
  rudder_automation_get: { automation: "aut_123" },
  rudder_automation_runs: { automation: "aut_123", limit: 5 },
  rudder_automation_triggers_list: { automation: "aut_123" },
  rudder_automation_triggers_create: { automation: "aut_123", kind: "api", label: "API" },
  rudder_automation_triggers_update: { trigger: "trg_123", label: "Updated" },
  rudder_automation_triggers_delete: { trigger: "trg_123" },
  rudder_automation_triggers_rotate_secret: { trigger: "trg_123" },
  rudder_automation_create: { title: "Daily", instructions: "Run daily", assigneeAgentId: "agt_123" },
  rudder_automation_update: { automation: "aut_123", title: "Updated" },
  rudder_automation_enable: { automation: "aut_123" },
  rudder_automation_disable: { automation: "aut_123" },
  rudder_automation_run: { automation: "aut_123", payload: { mode: "manual" } },
  rudder_chat_search: { query: "handoff" },
  rudder_chat_get: { chat: "chat_123" },
  rudder_chat_messages: { chat: "chat_123", limit: 10 },
  rudder_chat_transcript: { chat: "chat_123", limit: 10 },
  rudder_chat_read: { chat: "chat_123", turnLimit: 5 },
  rudder_chat_create: { title: "MCP chat", body: "Start with evidence" },
  rudder_chat_send: { chat: "chat_123", body: "Hello" },
  rudder_chat_archive: { chat: "chat_123" },
  rudder_runs_list: { cursor: "next-run-page" },
  rudder_runs_by_skill: { skill: "rudder", cursor: "next-skill-page" },
  rudder_runs_get: { run: "run_123" },
  rudder_runs_events: { run: "run_123", afterSeq: 40, limit: 20 },
  rudder_runs_log: { run: "run_123", maxChars: 2000, offset: 256000, limitBytes: 256000 },
  rudder_runs_transcript: { run: "run_123", turnLimit: 5 },
  rudder_runs_errors: { run: "run_123" },
  rudder_runs_cancel: { run: "run_123" },
  rudder_runs_retry: { run: "run_123" },
};

describe("agent-v1 MCP server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects model-provided runtime identity fields", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "rudder_issue_checkout",
          arguments: {
            issue: "ZST-123",
            orgId: "wrong-org",
            ApiKey: "mixed-case-key",
            apiBASE: "mixed-case-base",
            agentId: "wrong-agent",
            runId: "wrong-run",
            apiKey: "wrong-key",
            apiBase: "https://wrong.invalid",
          },
        },
      },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
        RUDDER_ORG_ID: "runtime-org",
        RUDDER_AGENT_ID: "runtime-agent",
        RUDDER_RUN_ID: "runtime-run",
      }),
    );

    expect(response).not.toBeNull();
    const result = response!.result as { content: Array<{ text: string }>; isError: boolean; structuredContent?: Record<string, unknown> };
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code: string; message: string };
    expect(result.isError).toBe(true);
    expect(payload.code).toBe("rudder_mcp_reserved_identity_argument");
    expect(payload.message).toContain("ApiKey");
    expect(payload.message).toContain("apiBase");
    expect(payload.message).toContain("apiBASE");
    expect(payload.message).toContain("orgId");
    expect(result.structuredContent).toMatchObject({
      code: "rudder_mcp_reserved_identity_argument",
    });
  });

  it("fails closed when runtime authentication context is missing", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rudder_library_file_list", arguments: {} },
      },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "",
        RUDDER_ORG_ID: "runtime-org",
      }),
    );

    expect(response).not.toBeNull();
    const result = response!.result as { content: Array<{ text: string }>; isError: boolean; structuredContent?: Record<string, unknown> };
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code: string; message: string };
    expect(result.isError).toBe(true);
    expect(payload.code).toBe("rudder_mcp_missing_runtime_context");
    expect(payload.message).toContain("RUDDER_API_KEY");
    expect(result.structuredContent).toMatchObject({
      code: "rudder_mcp_missing_runtime_context",
    });
  });

  it("uses runtime agent identity for commands that need an agent positional argument", () => {
    const plan = buildAgentV1ToolCallPlan(
      "rudder_agent_skills_enable",
      {
        selectionRefs: ["rudder/rudder-docs"],
      },
      {
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
        RUDDER_AGENT_ID: "runtime-agent",
        RUDDER_ORG_ID: "runtime-org",
      },
    );

    expect(plan.args).toEqual([
      "agent",
      "skills",
      "enable",
      "runtime-agent",
      "rudder/rudder-docs",
      "--json",
    ]);
    expect(plan.args).not.toContain("wrong-agent");
    expect(plan.args).not.toContain("also-wrong");
  });

  it("requires and forwards the first message when creating a chat", () => {
    const env = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
      RUDDER_ORG_ID: "runtime-org",
    };

    expect(() => buildAgentV1ToolCallPlan("rudder_chat_create", {}, env))
      .toThrow("Missing required argument: body");
    expect(buildAgentV1ToolCallPlan("rudder_chat_create", { body: "Start with evidence" }, env).args)
      .toEqual(["chat", "create", "--body", "Start with evidence", "--json"]);
  });

  it("defaults library file list to the runtime project Library path", () => {
    const plan = buildAgentV1ToolCallPlan(
      "rudder_library_file_list",
      {},
      {
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
        RUDDER_ORG_ID: "runtime-org",
        RUDDER_PROJECT_LIBRARY_PATH: "projects/test-project",
      },
    );

    expect(plan.args).toEqual([
      "library",
      "file",
      "list",
      "projects/test-project",
      "--json",
    ]);
  });

  it("keeps runtime identity out of MCP tool schemas and descriptions", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
        RUDDER_ORG_ID: "runtime-org",
      }),
    );

    expect(response).not.toBeNull();
    const result = response!.result as {
      tools: Array<{ description: string; inputSchema: { additionalProperties?: boolean; properties: Record<string, unknown> } }>;
    };
    for (const tool of result.tools) {
      expect(tool.description).not.toMatch(/\b(?:orgId|agentId|runId|apiBase|apiKey)\b/);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("orgId");
      expect(tool.inputSchema.properties).not.toHaveProperty("agentId");
      expect(tool.inputSchema.properties).not.toHaveProperty("runId");
      expect(tool.inputSchema.properties).not.toHaveProperty("apiKey");
      expect(tool.inputSchema.properties).not.toHaveProperty("apiBase");
    }
  });

  it("advertises Browser tools only for runs with the managed Browser capability flag", async () => {
    const baseEnv = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
      RUDDER_ORG_ID: "runtime-org",
      RUDDER_AGENT_ID: "runtime-agent",
      RUDDER_RUN_ID: "runtime-run",
    };
    const disabled = await runAgentV1McpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      buildMcpServerEnv(baseEnv),
    );
    const enabled = await runAgentV1McpJsonRpcMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      buildMcpServerEnv({ ...baseEnv, RUDDER_BROWSER_ENABLED: "true" }),
    );

    const disabledNames = ((disabled?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    const enabledNames = ((enabled?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(disabledNames).not.toContain("rudder_browser_open");
    expect(enabledNames).toContain("rudder_browser_open");
    expect(enabledNames).toHaveLength(disabledNames.length + 8);
  });

  it("rejects Browser calls without a runtime-owned run and capability flag", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rudder_browser_tabs", arguments: {} },
      },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
        RUDDER_ORG_ID: "runtime-org",
        RUDDER_AGENT_ID: "runtime-agent",
      }),
    );

    const result = response!.result as { content: Array<{ text: string }>; isError: boolean };
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code: string; message: string };
    expect(result.isError).toBe(true);
    expect(payload.code).toBe("browser_disabled");
  });

  it("turns direct comment text into a temporary body file instead of shell text", () => {
    const plan = buildAgentV1ToolCallPlan(
      "rudder_issue_comment",
      { issue: "ZST-123", body: "Done\n\n- test", images: ["/tmp/proof.png"] },
      {
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
      },
    );

    expect(plan.args.slice(0, 2)).toEqual(["issue", "comment"]);
    expect(plan.args).toContain("ZST-123");
    expect(plan.args).toContain("--body-file");
    expect(plan.tempFiles).toHaveLength(1);
    expect(plan.tempFiles[0]?.contents).toBe("Done\n\n- test");
    expect(plan.args).toContain("--image");
    expect(plan.args).toContain("/tmp/proof.png");
    expect(plan.args).toContain("--json");
  });

  it("accepts comment as an alias for issue comment body", () => {
    const plan = buildAgentV1ToolCallPlan(
      "rudder_issue_comment",
      { issue: "ZST-123", comment: "Progress update" },
      {
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
      },
    );

    expect(plan.tempFiles).toEqual([{ flag: "--body-file", contents: "Progress update" }]);
  });

  it("builds a CLI invocation plan for every agent-v1 MCP tool", () => {
    const env = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
      RUDDER_ORG_ID: "runtime-org",
      RUDDER_AGENT_ID: "runtime-agent",
      RUDDER_RUN_ID: "runtime-run",
      RUDDER_BROWSER_ENABLED: "true",
    };

    for (const tool of buildAgentV1McpToolsManifest("agent-v1").tools) {
      const input = SAMPLE_INPUT_BY_TOOL[tool.name] ?? {};
      expect(() => buildAgentV1ToolCallPlan(tool.name, input, env), tool.name).not.toThrow();
    }
  });

  it("keeps raw full compatibility out of MCP run summary tools", () => {
    const env = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
      RUDDER_ORG_ID: "runtime-org",
    };

    expect(buildAgentV1ToolCallPlan("rudder_runs_list", { cursor: "next-page" }, env).args).toEqual([
      "runs",
      "list",
      "--cursor",
      "next-page",
      "--json",
    ]);
    expect(buildAgentV1ToolCallPlan("rudder_runs_by_skill", {
      skill: "rudder",
      cursor: "next-skill-page",
    }, env).args).toEqual([
      "runs",
      "by-skill",
      "rudder",
      "--cursor",
      "next-skill-page",
      "--json",
    ]);
    expect(() => buildAgentV1ToolCallPlan("rudder_runs_list", { includeOutput: false }, env))
      .toThrow(/unsupported argument/i);
  });

  it("advertises every sampled MCP tool input argument in strict schemas", () => {
    for (const tool of buildAgentV1McpToolsManifest("agent-v1").tools) {
      const input = SAMPLE_INPUT_BY_TOOL[tool.name] ?? {};
      for (const key of Object.keys(input)) {
        expect(tool.inputSchema.properties, `${tool.name}.${key}`).toHaveProperty(key);
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("advertises every planner-supported MCP tool input argument in strict schemas", async () => {
    const serverSource = await fs.readFile(path.resolve(import.meta.dirname, "../agent-v1-mcp-server.ts"), "utf8");
    const reservedRuntimeIdentityKeys = new Set(["orgId", "agentId", "runId", "apiBase", "apiKey"]);
    const referencedKeys = new Set<string>();
    for (const match of serverSource.matchAll(/\binput\.([a-zA-Z][a-zA-Z0-9]*)\b/g)) {
      referencedKeys.add(match[1]);
    }
    for (const match of serverSource.matchAll(/\binput\.([a-zA-Z][a-zA-Z0-9]*)\s*\?\?/g)) {
      referencedKeys.add(match[1]);
    }
    for (const match of serverSource.matchAll(/requiredString\(input,\s*"([a-zA-Z][a-zA-Z0-9]*)"/g)) {
      referencedKeys.add(match[1]);
    }
    for (const match of serverSource.matchAll(/requiredAnyString\(input,\s*\[([^\]]*)\]/g)) {
      for (const key of match[0].matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/g)) {
        referencedKeys.add(key[1]);
      }
    }

    const schemaKeys = new Set<string>();
    for (const tool of buildAgentV1McpToolsManifest("agent-v1").tools) {
      for (const key of Object.keys(tool.inputSchema.properties)) schemaKeys.add(key);
    }

    for (const key of referencedKeys) {
      if (reservedRuntimeIdentityKeys.has(key)) continue;
      expect(schemaKeys, `planner input key ${key}`).toContain(key);
    }
  });

  it("lists every agent-v1 MCP tool through JSON-RPC tools/list", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
      }),
    );

    expect(response).not.toBeNull();
    const nonNullResponse = response!;
    const result = nonNullResponse.result as { tools: Array<{ name: string }> };
    expect(nonNullResponse).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(result.tools.map((tool) => tool.name)).toContain("rudder_agent_me");
    expect(result.tools.map((tool) => tool.name)).toContain("rudder_issue_review");
  });

  it("echoes the client's initialize protocol version", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
      }),
    );

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          experimental: {
            rudder: {
              contractVersion: RUDDER_MCP_CONTRACT_VERSION,
              coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
              browserContractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
            },
          },
        },
        serverInfo: { name: "rudder-operating-layer", version: "0.5.0" },
      },
    });
  });

  it("returns structured MCP tool failure content for invalid tool arguments", async () => {
    const response = await runAgentV1McpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rudder_issue_context", arguments: {} },
      },
      buildMcpServerEnv({
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
      }),
    );

    expect(response).not.toBeNull();
    const nonNullResponse = response!;
    const result = nonNullResponse.result as { content: Array<{ text: string }>; isError: boolean };
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { status: string; code: string; message: string };
    expect(nonNullResponse).not.toHaveProperty("error");
    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      status: "error",
      code: "rudder_mcp_tool_error",
      message: "Missing required argument: issue",
    });
  });

  it("returns structuredContent for successful JSON tool output", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-mcp-success-"));
    try {
      const shimPath = path.join(tempDir, process.platform === "win32" ? "rudder.cmd" : "rudder");
      const output = JSON.stringify({ entries: [], path: "projects/test-project" });
      if (process.platform === "win32") {
        await fs.writeFile(shimPath, `@echo off\r\necho ${output.replaceAll('"', '\\"')}\r\n`, "utf8");
      } else {
        await fs.writeFile(shimPath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
        await fs.chmod(shimPath, 0o755);
      }

      const response = await runAgentV1McpJsonRpcMessage(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "rudder_library_file_list", arguments: {} },
        },
        buildMcpServerEnv({
          PATH: tempDir,
          RUDDER_API_URL: "http://127.0.0.1:3100",
          RUDDER_API_KEY: "runtime-key",
          RUDDER_ORG_ID: "runtime-org",
          RUDDER_PROJECT_LIBRARY_PATH: "projects/test-project",
        }),
      );

      expect(response).not.toBeNull();
      const result = response!.result as { isError: boolean; structuredContent?: Record<string, unknown> };
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ entries: [], path: "projects/test-project" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a 50-row runs list JSON-RPC response below 200 KiB without duplicating structured data", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-mcp-runs-list-"));
    try {
      const shimPath = path.join(tempDir, process.platform === "win32" ? "rudder.cmd" : "rudder");
      const marker = "bounded-summary-marker";
      const output = JSON.stringify({
        items: Array.from({ length: 50 }, (_, index) => ({
          id: `run-${index}`,
          status: "failed",
          outcome: `${marker}-${index}-${"S".repeat(2_000)}`,
        })),
        page: { limit: 50, hasMore: false, nextCursor: null },
      });
      if (process.platform === "win32") {
        await fs.writeFile(shimPath, `@echo off\r\necho ${output.replaceAll('"', '\\"')}\r\n`, "utf8");
      } else {
        await fs.writeFile(shimPath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
        await fs.chmod(shimPath, 0o755);
      }

      const response = await runAgentV1McpJsonRpcMessage({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "rudder_runs_list", arguments: { limit: 50 } },
      }, buildMcpServerEnv({
        PATH: tempDir,
        RUDDER_API_URL: "http://127.0.0.1:3100",
        RUDDER_API_KEY: "runtime-key",
        RUDDER_ORG_ID: "runtime-org",
      }));

      expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(200 * 1024);
      const result = response!.result as {
        content: Array<{ text: string }>;
        structuredContent: { items: unknown[] };
        isError: boolean;
      };
      expect(result.isError).toBe(false);
      expect(result.structuredContent.items).toHaveLength(50);
      expect(result.content[0]?.text).not.toContain(marker);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces an oversized final JSON-RPC tool result with a bounded error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ payload: "X".repeat(1_100_000) }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const response = await runAgentV1McpJsonRpcMessage({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "rudder_agent_me", arguments: {} },
    }, buildMcpServerEnv({
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
    }));

    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(10_000);
    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "rudder_mcp_response_too_large",
        details: { maxBytes: 1_000_000 },
      },
    });
  });

  it("executes core MCP tools through the runtime API context without shelling out to rudder", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/api/agents/me")) {
        expect(init?.method).toBe("GET");
        expect(headers.get("authorization")).toBe("Bearer runtime-key");
        expect(headers.get("x-rudder-agent-id")).toBeNull();
        expect(headers.get("x-rudder-run-id")).toBeNull();
        return new Response(JSON.stringify({ id: "runtime-agent", ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/issues/ISSUE-1/checkout")) {
        expect(init?.method).toBe("POST");
        expect(headers.get("authorization")).toBe("Bearer runtime-key");
        expect(headers.get("x-rudder-agent-id")).toBe("11111111-1111-4111-8111-111111111111");
        expect(headers.get("x-rudder-run-id")).toBe("22222222-2222-4222-8222-222222222222");
        expect(JSON.parse(String(init?.body))).toEqual({
          agentId: "11111111-1111-4111-8111-111111111111",
          expectedStatuses: ["todo", "blocked"],
        });
        return new Response(JSON.stringify({ id: "ISSUE-1", status: "in_progress" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const env = buildMcpServerEnv({
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
      RUDDER_ORG_ID: "runtime-org",
      RUDDER_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      RUDDER_RUN_ID: "22222222-2222-4222-8222-222222222222",
      RUDDER_MCP_RUDDER_BIN: "/missing/rudder",
    });

    const meResponse = await runAgentV1McpJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "rudder_agent_me", arguments: {} },
    }, env);
    const checkoutResponse = await runAgentV1McpJsonRpcMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "rudder_issue_checkout",
        arguments: { issue: "ISSUE-1", expectedStatuses: "todo,blocked" },
      },
    }, env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meResponse?.result).toMatchObject({
      isError: false,
      structuredContent: { id: "runtime-agent", ok: true },
    });
    expect(checkoutResponse?.result).toMatchObject({
      isError: false,
      structuredContent: { id: "ISSUE-1", status: "in_progress" },
    });
  });

  it("dispatches Browser tools directly through the runtime-owned API identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:3100/api/browser/open");
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer runtime-key");
      expect(headers.get("x-rudder-agent-id")).toBe("11111111-1111-4111-8111-111111111111");
      expect(headers.get("x-rudder-run-id")).toBe("22222222-2222-4222-8222-222222222222");
      expect(JSON.parse(String(init?.body))).toEqual({ url: "https://example.com" });
      return new Response(JSON.stringify({ tabId: "tab-1", url: "https://example.com/" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await runAgentV1McpJsonRpcMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "rudder_browser_open", arguments: { url: "https://example.com" } },
    }, buildMcpServerEnv({
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "runtime-key",
      RUDDER_ORG_ID: "runtime-org",
      RUDDER_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      RUDDER_RUN_ID: "22222222-2222-4222-8222-222222222222",
      RUDDER_BROWSER_ENABLED: "true",
      RUDDER_MCP_RUDDER_BIN: "/missing/rudder",
    }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response?.result).toMatchObject({
      isError: false,
      structuredContent: { tabId: "tab-1", url: "https://example.com/" },
    });
  });

  it("does not respond to JSON-RPC notifications", async () => {
    await expect(
      runAgentV1McpJsonRpcMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        buildMcpServerEnv({
          RUDDER_API_URL: "http://127.0.0.1:3100",
          RUDDER_API_KEY: "runtime-key",
        }),
      ),
    ).resolves.toBeNull();
  });

  it("parses Content-Length framed MCP stdio messages", () => {
    const first = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const second = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const framed =
      `Content-Length: ${Buffer.byteLength(first, "utf8")}\r\n\r\n${first}` +
      `Content-Length: ${Buffer.byteLength(second, "utf8")}\r\n\r\n${second.slice(0, 10)}`;

    const parsed = parseMcpStdioMessages(framed);

    expect(parsed.mode).toBe("framed");
    expect(parsed.messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    ]);
    expect(parsed.remainder).toBe(`Content-Length: ${Buffer.byteLength(second, "utf8")}\r\n\r\n${second.slice(0, 10)}`);

    const completed = parseMcpStdioMessages(`${parsed.remainder}${second.slice(10)}`);
    expect(completed.messages).toEqual([
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    expect(completed.remainder).toBe("");
  });

  it("waits for a complete Content-Length prefix before locking stdio mode", () => {
    const pending = parseMcpStdioMessages("Content-L");

    expect(pending.mode).toBeNull();
    expect(pending.messages).toEqual([]);
    expect(pending.remainder).toBe("Content-L");

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const completed = parseMcpStdioMessages(
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
      pending.mode,
    );
    expect(completed.mode).toBe("framed");
    expect(completed.messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    ]);
  });

  it("parses Content-Length framed messages by byte length", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "rudder_issue_comment",
        arguments: { issue: "MCP-1", body: "中文 progress" },
      },
    });
    const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;

    const parsed = parseMcpStdioMessages(framed);

    expect(parsed.mode).toBe("framed");
    expect(parsed.messages).toEqual([JSON.parse(body)]);
    expect(parsed.remainder).toBe("");
  });

  it("uses the runtime PATH rudder shim when running from TypeScript source", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-mcp-path-"));
    try {
      const shimPath = path.join(tempDir, process.platform === "win32" ? "rudder.cmd" : "rudder");
      if (process.platform === "win32") {
        await fs.writeFile(shimPath, "@echo off\r\necho rudder-test\r\n", "utf8");
      } else {
        await fs.writeFile(shimPath, "#!/bin/sh\necho rudder-test\n", "utf8");
        await fs.chmod(shimPath, 0o755);
      }

      const invocation = resolveRudderCliInvocation(["agent", "me", "--json"], {
        PATH: tempDir,
      });

      expect(invocation).toEqual({
        command: "rudder",
        args: ["agent", "me", "--json"],
      });
      expect(invocation.args.join(" ")).not.toContain("cli/src/index.js");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
