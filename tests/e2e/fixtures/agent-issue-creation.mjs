#!/usr/bin/env node

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

async function main() {
  const apiUrl = requiredEnv("RUDDER_API_URL").replace(/\/$/u, "");
  const apiKey = requiredEnv("RUDDER_API_KEY");
  const orgId = requiredEnv("RUDDER_ORG_ID");
  const runId = requiredEnv("RUDDER_RUN_ID");
  const instruction = prompt.match(/\*\*User instruction:\*\*\s*([\s\S]*?)\s*\n\n## Required Behavior/u)?.[1]?.trim()
    || "Create a follow-up issue for the requested regression.";
  const marker = instruction.match(/\[E2E:[^\]]+\]/u)?.[0] ?? "[E2E:agent-issue-creation]";

  emit({ type: "thread.started", thread_id: "thread-agent-issue-creation-e2e", model: "gpt-5.4" });

  const response = await fetch(`${apiUrl}/api/orgs/${encodeURIComponent(orgId)}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-rudder-run-id": runId,
    },
    body: JSON.stringify({
      title: `Agent-created ${marker}`,
      description: [
        "Created by the production-shaped Agent Issue creation fixture.",
        "",
        "User instruction:",
        instruction,
      ].join("\n"),
      status: "backlog",
      priority: "medium",
    }),
  });
  const responseText = await response.text();
  let issue;
  try {
    issue = JSON.parse(responseText);
  } catch {
    throw new Error(`Issue creation returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`Issue creation failed (${response.status}): ${issue?.error ?? responseText}`);
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
