import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

describe("Issue transport fallback budget CLI workflow", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("allows one MCP-to-CLI fallback and then stops before another backend request", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Internal server error" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const runtimeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-issue-budget-e2e-"));
    tempDirs.push(runtimeTmpDir);
    const commonEnv = {
      ...process.env,
      RUDDER_API_URL: `http://127.0.0.1:${address.port}`,
      RUDDER_API_KEY: "test-agent-key",
      RUDDER_AGENT_ID: "agent-e2e",
      RUDDER_RUN_ID: "run-issue-budget-e2e",
      RUDDER_RUNTIME_TMPDIR: runtimeTmpDir,
    };

    try {
      const first = await runMcpCommentsList(commonEnv);
      const firstError = (first.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(firstError).toMatchObject({
        status: "error",
        code: "api_request_error",
        message: "Internal server error; use the equivalent Rudder CLI fallback once: rudder issue comments list iss_e2e --order desc --json",
        details: {
          status: 500,
          issueTransport: {
            state: "fallback_available",
            initialSurface: "mcp",
            fallbackBudgetRemaining: 1,
            fallbackAction: {
              surface: "cli",
              command: "rudder issue comments list iss_e2e --order desc --json",
            },
          },
        },
      });

      const fallback = await runCli(commonEnv, ["issue", "comments", "list", "iss_e2e", "--json"]);
      const fallbackError = JSON.parse(fallback.stderr) as Record<string, unknown>;
      expect(fallback.exitCode).toBe(1);
      expect(fallbackError).toMatchObject({
        status: 500,
        code: "issue_transport_unavailable",
        details: {
          issueTransport: {
            state: "blocked",
            initialSurface: "mcp",
            fallbackSurface: "cli",
            fallbackMatchedFingerprint: true,
            fallbackBudgetRemaining: 0,
            fallbackAction: null,
          },
        },
      });

      const stopped = await runCli(commonEnv, ["issue", "comments", "list", "iss_e2e", "--json"]);
      const stoppedError = JSON.parse(stopped.stderr) as Record<string, unknown>;
      expect(stopped.exitCode).toBe(1);
      expect(stoppedError).toMatchObject({
        status: 503,
        code: "issue_transport_unavailable",
        details: {
          issueTransport: {
            state: "blocked",
            fallbackBudgetRemaining: 0,
            fallbackAction: null,
            checkpoint: "Issue transport unavailable",
          },
        },
      });
      expect(requestCount).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 20_000);

  it("shares a scoped runs-list budget across MCP and CLI processes", async () => {
    let requestCount = 0;
    const requestUrls: string[] = [];
    const server = createServer((request, response) => {
      requestCount += 1;
      requestUrls.push(request.url ?? "");
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Internal server error" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const runtimeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-issue-budget-runs-e2e-"));
    tempDirs.push(runtimeTmpDir);
    const commonEnv = {
      ...process.env,
      RUDDER_API_URL: `http://127.0.0.1:${address.port}`,
      RUDDER_API_KEY: "test-agent-key",
      RUDDER_ORG_ID: "org_e2e",
      RUDDER_AGENT_ID: "agent-e2e",
      RUDDER_RUN_ID: "run-runs-list-budget-e2e",
      RUDDER_RUNTIME_TMPDIR: runtimeTmpDir,
    };

    try {
      const first = await runMcpTool(commonEnv, "rudder_runs_list", {
        relatedAgentId: "agent-e2e",
        limit: 20,
      });
      const firstError = (first.result as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(firstError).toMatchObject({
        status: "error",
        code: "api_request_error",
        details: {
          status: 500,
          issueTransport: {
            state: "fallback_available",
            operation: "runs.list",
            scopeKey: "org:org_e2e",
            initialSurface: "mcp",
            fallbackBudgetRemaining: 1,
            fallbackAction: {
              surface: "cli",
              command: "rudder runs list --org-id org_e2e --agent-id agent-e2e --limit 20 --json",
            },
          },
        },
      });

      const fallback = await runCli(commonEnv, [
        "runs",
        "list",
        "--org-id",
        "org_e2e",
        "--agent-id",
        "other-agent",
        "--limit",
        "50",
        "--json",
      ]);
      const fallbackError = JSON.parse(fallback.stderr) as Record<string, unknown>;
      expect(fallback.exitCode).toBe(1);
      expect(fallbackError).toMatchObject({
        status: 500,
        code: "issue_transport_unavailable",
        details: {
          issueTransport: {
            state: "blocked",
            operation: "runs.list",
            scopeKey: "org:org_e2e",
            initialSurface: "mcp",
            fallbackSurface: "cli",
            fallbackMatchedFingerprint: true,
            fallbackBudgetRemaining: 0,
          },
        },
      });

      const stopped = await runCli(commonEnv, [
        "runs",
        "list",
        "--org-id",
        "org_e2e",
        "--status",
        "failed",
        "--json",
      ]);
      const stoppedError = JSON.parse(stopped.stderr) as Record<string, unknown>;
      expect(stopped.exitCode).toBe(1);
      expect(stoppedError).toMatchObject({
        status: 503,
        code: "issue_transport_unavailable",
        details: {
          issueTransport: {
            state: "blocked",
            operation: "runs.list",
            scopeKey: "org:org_e2e",
            fallbackBudgetRemaining: 0,
            checkpoint: "Issue transport unavailable",
          },
        },
      });
      expect(requestCount).toBe(2);
      expect(requestUrls).toHaveLength(2);
      expect(requestUrls[0]).toContain("/api/run-intelligence/orgs/org_e2e/runs");
      expect(requestUrls[1]).toContain("/api/run-intelligence/orgs/org_e2e/runs");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 20_000);
});

function runCli(
  env: NodeJS.ProcessEnv,
  args = ["issue", "get", "iss_e2e", "--json"],
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("cli/node_modules/tsx/dist/cli.mjs"),
        path.resolve("cli/src/index.ts"),
        ...args,
      ],
      { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runMcpCommentsList(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return runMcpTool(env, "rudder_issue_comments_list", { issue: "iss_e2e" });
}

function runMcpTool(
  env: NodeJS.ProcessEnv,
  name: string,
  toolArguments: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("cli/node_modules/tsx/dist/cli.mjs"),
        path.resolve("cli/src/index.ts"),
        "mcp-server",
      ],
      { cwd: path.resolve("."), env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0 || settled) return;
      settled = true;
      const response = JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>;
      child.kill();
      resolve(response);
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (!settled) reject(new Error(`MCP process exited ${String(exitCode)}: ${stderr}`));
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: toolArguments },
    })}\n`);
  });
}
