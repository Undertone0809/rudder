import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";

interface JsonRpcResponse {
  id: number;
  result?: {
    tools?: Array<{
      name: string;
      inputSchema: {
        properties: Record<string, unknown>;
        required?: string[];
      };
    }>;
    structuredContent?: {
      status?: string;
      code?: string;
      message?: string;
    };
    isError?: boolean;
  };
}

test("serves exact agent tool schemas and rejects invalid calls over stdio", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const child = spawn(process.execPath, [
    path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
    path.join(repoRoot, "cli/src/index.ts"),
    "mcp-server",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUDDER_API_URL: "http://127.0.0.1:1",
      RUDDER_API_KEY: "e2e-runtime-key",
      RUDDER_ORG_ID: "e2e-org",
      RUDDER_AGENT_ID: "e2e-agent",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "rudder_runs_get",
      arguments: { runIdPrefix: "abc", includeTranscript: true },
    },
  })}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(exitCode, stderr).toBe(0);

  const responses = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
  const tools = responses.find((response) => response.id === 1)?.result?.tools ?? [];
  const issueList = tools.find((tool) => tool.name === "rudder_issue_list");
  const issueSearch = tools.find((tool) => tool.name === "rudder_issue_search");
  const issueCommit = tools.find((tool) => tool.name === "rudder_issue_commit");
  const goalList = tools.find((tool) => tool.name === "rudder_goal_list");
  const goalContext = tools.find((tool) => tool.name === "rudder_goal_context");
  const goalChange = tools.find((tool) => tool.name === "rudder_goal_change_propose");
  const runsGet = tools.find((tool) => tool.name === "rudder_runs_get");

  expect(issueList?.inputSchema.properties).toEqual({
    status: expect.any(Object),
    assigneeAgentId: expect.any(Object),
    projectId: expect.any(Object),
  });
  expect(issueSearch?.inputSchema.required).toEqual(["query"]);
  expect(issueCommit?.inputSchema.required).toEqual(["issue", "sha", "message"]);
  expect(goalList?.inputSchema.properties).toEqual({
    lifecycle: expect.any(Object),
    focus: expect.any(Object),
    facet: expect.any(Object),
    limit: expect.any(Object),
  });
  expect(goalContext?.inputSchema.required).toEqual(["goal"]);
  expect(goalContext?.inputSchema.properties).not.toHaveProperty("orgId");
  expect(goalContext?.inputSchema.properties).not.toHaveProperty("agentId");
  expect(goalChange?.inputSchema.required).toEqual([
    "goal",
    "contractRevision",
    "afterContract",
    "rationale",
    "idempotencyKey",
  ]);
  expect(goalChange?.inputSchema.properties).not.toHaveProperty("agentId");
  expect(Object.keys(runsGet?.inputSchema.properties ?? {})).toEqual(["run"]);

  const invalidResult = responses.find((response) => response.id === 2)?.result;
  expect(invalidResult).toMatchObject({
    isError: true,
    structuredContent: {
      status: "error",
      code: "rudder_mcp_invalid_arguments",
      message: expect.stringMatching(/includeTranscript.*runIdPrefix/i),
    },
  });
});
