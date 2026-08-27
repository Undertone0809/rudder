#!/usr/bin/env node

import { spawn } from "node:child_process";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.on("SIGTERM", () => process.exit(0));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function callRudderMcp(requests) {
  const command = process.env.RUDDER_MCP_RUDDER_BIN?.trim() || "rudder";
  const child = spawn(command, ["mcp-server"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const close = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Rudder MCP server failed (${code ?? signal}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve(stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(new Error(`Rudder MCP server returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  return await close;
}

async function main() {
  requiredEnv("RUDDER_API_URL");
  requiredEnv("RUDDER_API_KEY");
  requiredEnv("RUDDER_ORG_ID");
  requiredEnv("RUDDER_RUN_ID");
  const instruction = prompt.match(/<quoted_issue_context>\s*([\s\S]*?)\s*<\/quoted_issue_context>/u)?.[1]?.trim()
    || prompt.match(/\*\*User instruction:\*\*\s*([\s\S]*?)\s*\n\n## Required Behavior/u)?.[1]?.trim()
    || "Create a follow-up issue for the requested regression.";
  const marker = instruction.match(/\[E2E:[^\]]+\]/u)?.[0] ?? "[E2E:agent-issue-creation]";

  emit({ type: "thread.started", thread_id: "thread-agent-issue-creation-e2e", model: "gpt-5.4" });

  const responses = await callRudderMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "rudder_issue_create",
        arguments: {
          title: `Agent-created ${marker}`,
          description: [
            "Created by the production-shaped Agent Issue creation fixture through Rudder MCP.",
            "",
            "User instruction:",
            instruction,
          ].join("\n"),
          status: "backlog",
          priority: "medium",
        },
      },
    },
  ]);
  const toolList = responses.find((response) => response.id === 1)?.result?.tools ?? [];
  if (!toolList.some((tool) => tool.name === "rudder_issue_create")) {
    throw new Error("Rudder MCP manifest does not expose rudder_issue_create");
  }
  const toolCall = responses.find((response) => response.id === 2);
  if (toolCall?.result?.isError) {
    throw new Error(`rudder_issue_create failed: ${toolCall.result.structuredContent?.message ?? "unknown MCP error"}`);
  }
  const issue = toolCall?.result?.structuredContent;
  if (!issue || typeof issue !== "object") {
    throw new Error("rudder_issue_create returned no structured issue result");
  }

  emit({
    type: "item.completed",
    item: {
      id: "agent-issue-creation-e2e-result",
      type: "agent_message",
      text: `Created ${issue.identifier ?? issue.id}`,
    },
  });
  emit({
    type: "turn.completed",
    result: `Created ${issue.identifier ?? issue.id}`,
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  });
}

process.stdin.on("end", () => {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
});
