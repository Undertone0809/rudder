#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const apiBase = (process.env.RUDDER_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const runtime = runtimeArg?.slice("--runtime=".length) || "opencode_local";
const modelArg = process.argv.find((arg) => arg.startsWith("--model="));
const model =
  modelArg?.slice("--model=".length) ||
  (runtime === "pi_local" ? "opencode/deepseek-v4-flash-free" : "opencode/mimo-v2.5-free");
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const timeoutMs = Number.parseInt(timeoutArg?.slice("--timeout-ms=".length) || "180000", 10);
const issueWorkflow = process.argv.includes("--issue-workflow");

const jsonHeaders = { "content-type": "application/json" };

async function request(method, route, body) {
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : text;
    throw new Error(`${method} ${route} failed ${response.status}: ${message}`);
  }
  return data;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textIncludesToolError(text) {
  return /"isError"\s*:\s*true|"status"\s*:\s*"error"|rudder_cli_command_failed/i.test(text);
}

function collectCodexMcpEvidence(event, toolNames, toolErrors) {
  const item = event?.item;
  if (!item || typeof item !== "object") return;
  if (item.type !== "mcp_tool_call") return;
  const tool = typeof item.tool === "string" ? item.tool : "";
  const server = typeof item.server === "string" ? item.server : "";
  if (!tool) return;
  const qualifiedTool = server ? `${server}_${tool}` : tool;
  toolNames.add(qualifiedTool);
  const resultText = JSON.stringify(item.result ?? item.error ?? "");
  if (item.status === "failed" || item.error || textIncludesToolError(resultText)) {
    toolErrors.push({ tool: qualifiedTool, message: resultText.slice(0, 500) });
  }
}

function collectClaudeEvidence(event, toolNames, fallbackToolUses, toolErrors) {
  const message = event?.message;
  if (!message || typeof message !== "object") return;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.type === "tool_use") {
      const tool = typeof entry.name === "string" ? entry.name : "";
      if (!tool) continue;
      toolNames.add(tool);
      const inputText = JSON.stringify(entry.input ?? "");
      if (tool === "Bash" && /\brudder\s+(agent|issue|runs|library|chat|automation)\b|\bcurl\b.+RUDDER_API_KEY/i.test(inputText)) {
        fallbackToolUses.push({ tool, input: inputText.slice(0, 500) });
      }
    }
    if (entry.type === "tool_result") {
      const resultText = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? "");
      if (entry.is_error === true || textIncludesToolError(resultText)) {
        toolErrors.push({ tool: String(entry.tool_use_id ?? "claude_tool_result"), message: resultText.slice(0, 500) });
      }
    }
  }
  const resultText = JSON.stringify(event.tool_use_result ?? "");
  if (textIncludesToolError(resultText)) {
    toolErrors.push({ tool: "claude_tool_result", message: resultText.slice(0, 500) });
  }
}

function collectEvidence(logText) {
  const events = [];
  const toolNames = new Set();
  const fallbackToolUses = [];
  const toolErrors = [];
  const chunks = [];
  const lower = logText.toLowerCase();
  for (const raw of logText.split(/\r?\n/)) {
    const outer = parseJsonLine(raw);
    const chunk = typeof outer?.chunk === "string" ? outer.chunk : raw;
    chunks.push(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      const event = parseJsonLine(line.trim());
      if (!event || typeof event !== "object") continue;
      events.push(event);
      collectCodexMcpEvidence(event, toolNames, toolErrors);
      collectClaudeEvidence(event, toolNames, fallbackToolUses, toolErrors);
      if (event.type === "tool_use") {
        const tool = event.part?.tool || event.part?.name || event.name;
        if (typeof tool === "string") {
          toolNames.add(tool);
          const inputText = JSON.stringify(event.part?.state?.input ?? event.part?.input ?? "");
          const shellLike = /(?:^|_|\b)(bash|shell|terminal|exec|curl)(?:$|_|\b)/i.test(tool);
          if (shellLike && /\brudder\s+(agent|issue|runs|library|chat|automation)\b|\bcurl\b.+RUDDER_API_KEY/i.test(inputText)) {
            fallbackToolUses.push({ tool, input: inputText.slice(0, 500) });
          }
          const state = event.part?.state;
          if (state?.status === "error") {
            toolErrors.push({ tool, message: JSON.stringify(state.error ?? state.output ?? "").slice(0, 500) });
          } else if (typeof state?.output === "string" && textIncludesToolError(state.output)) {
            toolErrors.push({ tool, message: state.output.slice(0, 500) });
          }
        }
      }
      if (event.type === "tool_execution_start") {
        const tool = event.toolName;
        if (typeof tool === "string") {
          toolNames.add(tool);
          const inputText = typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? "");
          const shellLike = /^(bash|shell|terminal|exec|curl)$/i.test(tool);
          if (shellLike && /\brudder\s+(agent|issue|runs|library|chat|automation)\b|\bcurl\b.+RUDDER_API_KEY/i.test(inputText)) {
            fallbackToolUses.push({ tool, input: inputText.slice(0, 500) });
          }
        }
      }
      if (event.type === "tool_execution_end") {
        const tool = event.toolName;
        if (typeof tool === "string") {
          toolNames.add(tool);
          const resultText = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
          if (event.isError === true || textIncludesToolError(resultText)) {
            toolErrors.push({ tool, message: resultText.slice(0, 500) });
          }
        }
      }
    }
  }

  const usedCliFallback = fallbackToolUses.length > 0;
  const authBlocked =
    lower.includes("pi_auth_required") ||
    lower.includes("unable to verify your membership benefits") ||
    lower.includes("auth_required") ||
    lower.includes("authentication required");
  return {
    eventCount: events.length,
    toolNames: [...toolNames].sort(),
    usedCliFallback,
    fallbackToolUses,
    toolErrors,
    authBlocked,
  };
}

function extractFinalText(current) {
  const summary = typeof current.summary === "string" ? current.summary.trim() : "";
  if (summary) return summary;
  const result = typeof current.resultJson?.result === "string" ? current.resultJson.result.trim() : "";
  if (result) return result;
  const stdout = typeof current.resultJson?.stdout === "string" ? current.resultJson.stdout : "";
  const assistantTexts = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const event = parseJsonLine(raw.trim());
    if (!event || typeof event !== "object") continue;
    if (event.type === "text") {
      const text = typeof event.part?.text === "string" ? event.part.text.trim() : "";
      const synthetic = event.part?.synthetic === true || event.part?.metadata?.compaction_continue === true;
      if (text && !synthetic) assistantTexts.push(text);
    }
    if (event.type === "turn_end") {
      const text = typeof event.message?.text === "string" ? event.message.text.trim() : "";
      if (text) assistantTexts.push(text);
    }
    if (event.type === "agent_end") {
      const text = typeof event.finalText === "string" ? event.finalText.trim() : "";
      if (text) assistantTexts.push(text);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const text = typeof event.item.text === "string" ? event.item.text.trim() : "";
      if (text) assistantTexts.push(text);
    }
    if (event.type === "assistant") {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const entry of content) {
        if (entry?.type !== "text") continue;
        const text = typeof entry.text === "string" ? entry.text.trim() : "";
        if (text) assistantTexts.push(text);
      }
    }
    if (event.type === "result") {
      const text = typeof event.result === "string" ? event.result.trim() : "";
      if (text) assistantTexts.push(text);
    }
  }
  return assistantTexts.at(-1) || "";
}

function hasToolUnavailableContradiction(text) {
  return /(?:do(?:n't| not)\s+have|no\s+access\s+to|unavailable|not\s+available|not\s+found).{0,120}\brudder_agent_me\b/i.test(text) ||
    /\brudder_agent_me\b.{0,120}(?:do(?:es)?(?:n't| not)\s+exist|unavailable|not\s+available|not\s+found)/i.test(text) ||
    /"path"\s*:\s*"none"/i.test(text);
}

function hasExpectedFinalMcpAnswer(text) {
  return /"path"\s*:\s*"mcp"/i.test(text) && /"rudder_agent_me"/i.test(text);
}

function hasIssueWorkflowFinalAnswer(text, marker) {
  return text.includes(marker) && /(?:done|complete|completed|marked)/i.test(text);
}

async function main() {
  const health = await request("GET", "/api/health");
  const org = await request("POST", "/api/orgs", {
    name: `MCP Real Runtime Probe ${runtime} ${Date.now()}`,
  });
  const marker = `MCP_REAL_${runtime}_${Date.now()}`;

  const promptTemplate = [
    "You are validating Rudder runtime tools.",
    "Do not use shell, Bash, curl, or the rudder CLI for Rudder control-plane work.",
    "Call exactly one Rudder runtime tool first: rudder_agent_me.",
    "Then reply with compact JSON only: {\"path\":\"mcp\",\"tools\":[\"rudder_agent_me\"],\"note\":\"...\"}.",
    "If the tool is unavailable, reply with {\"path\":\"none\",\"tools\":[],\"note\":\"tool unavailable\"}.",
  ].join("\n");

  const agentRuntimeConfig =
    runtime === "opencode_local"
      ? {
          model,
          dangerouslySkipPermissions: true,
          promptTemplate,
          env: {
            OPENCODE_PERMISSION: "allow",
          },
        }
      : runtime === "claude_local"
        ? {
            model,
            promptTemplate,
            dangerouslySkipPermissions: true,
            maxTurnsPerRun: 5,
          }
      : {
          model,
          promptTemplate,
        };

  const agent = await request("POST", `/api/orgs/${org.id}/agents`, {
    name: `MCP Real Probe ${runtime} ${Date.now()}`,
    role: "engineer",
    agentRuntimeType: runtime,
    agentRuntimeConfig: issueWorkflow
      ? runtime === "opencode_local"
        ? {
            model,
            dangerouslySkipPermissions: true,
            env: {
              OPENCODE_PERMISSION: "allow",
            },
          }
        : runtime === "claude_local"
          ? { model, dangerouslySkipPermissions: true, maxTurnsPerRun: 12 }
        : { model }
      : agentRuntimeConfig,
    desiredSkills: ["rudder"],
  });

  let run;
  let issue = null;
  if (issueWorkflow) {
    issue = await request("POST", `/api/orgs/${org.id}/issues`, {
      title: `${marker} issue workflow Rudder tool validation`,
      description: [
        `Marker: ${marker}.`,
        "Use Rudder runtime tools only. Do not use shell, Bash, curl, or the rudder CLI for Rudder control-plane work.",
        "Required workflow:",
        "1. Call rudder_issue_context for this issue.",
        "2. Call rudder_issue_checkout for this issue.",
        `3. Call rudder_issue_comment with a progress comment containing ${marker}_PROGRESS.`,
        `4. Call rudder_issue_done with a done comment containing ${marker}_DONE.`,
        "Final answer: briefly list the exact Rudder tools you called and explicitly state whether you used CLI/Bash/curl.",
      ].join("\n"),
      priority: "medium",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runs = await request("GET", `/api/issues/${issue.id}/runs`);
      const candidate = Array.isArray(runs) ? runs.find((entry) => entry.agentId === agent.id) : null;
      if (candidate?.id) {
        run = candidate;
        break;
      }
      const currentIssue = await request("GET", `/api/issues/${issue.id}`);
      if (currentIssue.executionRunId) {
        run = await request("GET", `/api/heartbeat-runs/${currentIssue.executionRunId}`);
        break;
      }
      await delay(1000);
    }
    if (!run?.id) throw new Error(`Timed out waiting for assignment run for ${issue.id}`);
  } else {
    run = await request("POST", `/api/agents/${agent.id}/wakeup`, {
      source: "on_demand",
      triggerDetail: "manual",
      forceFreshSession: true,
      payload: {
        probe: "real-local-rudder-tools-runtime-probe",
        expectedTool: "rudder_agent_me",
      },
    });
  }

  const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
  const started = Date.now();
  let current = run;
  while (!terminal.has(current.status) && Date.now() - started < timeoutMs) {
    await delay(3000);
    current = await request("GET", `/api/heartbeat-runs/${run.id}`);
  }

  let logText = "";
  try {
    const logPayload = await request("GET", `/api/run-intelligence/runs/${run.id}/log`);
    logText = typeof logPayload?.content === "string" ? logPayload.content : "";
  } catch {
    const logPath = path.join(
      process.env.HOME || "",
      ".rudder",
      "instances",
      "dev",
      "data",
      "run-logs",
      org.id,
      agent.id,
      `${run.id}.ndjson`,
    );
    logText = await fs.readFile(logPath, "utf8").catch(() => "");
  }

  const evidence = collectEvidence(logText);
  const finalIssue = issueWorkflow && issue?.id
    ? await request("GET", `/api/issues/${issue.id}`)
    : null;
  const issueComments = issueWorkflow && issue?.id
    ? await request("GET", `/api/issues/${issue.id}/comments`)
    : [];
  const issueWorkflowCompleted = issueWorkflow
    ? finalIssue?.status === "done" &&
      Array.isArray(issueComments) &&
      issueComments.some((comment) => typeof comment?.body === "string" && comment.body.includes(`${marker}_PROGRESS`)) &&
      issueComments.some((comment) => typeof comment?.body === "string" && comment.body.includes(`${marker}_DONE`))
    : false;
  const expectedToolSeen = issueWorkflow
    ? ["rudder_issue_context", "rudder_issue_checkout", "rudder_issue_comment", "rudder_issue_done"].every((expected) =>
        evidence.toolNames.some((tool) => tool === expected || tool.endsWith(`_${expected}`)))
    : evidence.toolNames.some((tool) => {
    return tool === "rudder_agent_me" || tool.endsWith("_rudder_agent_me");
  });
  const finalText = extractFinalText(current);
  const finalContradictsTool = hasToolUnavailableContradiction(finalText);
  const finalMatchesExpected = issueWorkflow
    ? issueWorkflowCompleted || hasIssueWorkflowFinalAnswer(finalText, marker)
    : hasExpectedFinalMcpAnswer(finalText);
  const passed = current.status === "succeeded" &&
    expectedToolSeen &&
    !evidence.usedCliFallback &&
    evidence.toolErrors.length === 0 &&
    finalMatchesExpected &&
    !finalContradictsTool;
  const verdict = passed ? "passed" : evidence.authBlocked ? "blocked_auth" : "failed";

  console.log(JSON.stringify(
    {
      verdict,
      runtime,
      model,
      apiBase,
      health: {
        version: health?.version ?? null,
        deploymentMode: health?.deploymentMode ?? null,
        authReady: health?.authReady ?? null,
      },
      orgId: org.id,
      agentId: agent.id,
      issueId: issue?.id ?? null,
      issueIdentifier: issue?.identifier ?? null,
      marker,
      runId: run.id,
      status: current.status,
      summary: current.summary ?? null,
      finalText,
      finalMatchesExpected,
      finalContradictsTool,
      issueWorkflowCompleted,
      finalIssueStatus: finalIssue?.status ?? null,
      error: current.error ?? current.errorMessage ?? null,
      expectedToolSeen,
      ...evidence,
    },
    null,
    2,
  ));

  if (verdict === "failed") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
