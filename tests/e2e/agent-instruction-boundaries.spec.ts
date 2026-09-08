import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

type Organization = {
  id: string;
  issuePrefix: string;
};

type Agent = {
  id: string;
  name: string;
};

type AgentRun = {
  id: string;
  status: string;
  contextSnapshot?: Record<string, unknown> | null;
};

const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

async function writeCanonicalInstructions(page: Page, agentId: string, label: string) {
  const files = ["SOUL.md", "TOOLS.md", "MEMORY.md", "AGENTS.md"];
  for (const file of files) {
    const response = await page.request.put(`/api/agents/${agentId}/instructions-bundle/file`, {
      data: {
        path: file,
        content: `# ${label} ${file}\n\nKeep this Markdown body unchanged.\n`,
      },
    });
    expect(response.ok()).toBe(true);
  }
  const entryResponse = await page.request.patch(`/api/agents/${agentId}/instructions-bundle`, {
    data: { entryFile: "AGENTS.md" },
  });
  expect(entryResponse.ok()).toBe(true);
}

async function waitForRun(
  page: Page,
  organizationId: string,
  agentId: string,
  predicate: (run: AgentRun) => boolean,
) {
  let matched: AgentRun | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/orgs/${organizationId}/heartbeat-runs?agentId=${agentId}&limit=20`,
    );
    expect(response.ok()).toBe(true);
    const runs = await response.json() as AgentRun[];
    matched = runs.find(predicate);
    return matched?.status ?? null;
  }, {
    timeout: 45_000,
    intervals: [250, 500, 1_000],
  }).toBe("succeeded");
  expect(matched).toBeTruthy();
  return matched!;
}

async function readInvocationPrompt(page: Page, organizationId: string, agentId: string, runId: string) {
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organizationId);
  await page.goto(`/agents/${agentId}/runs/${runId}`);
  await page.getByRole("tab", { name: "Metadata" }).click();
  const prompt = page.getByTestId("invocation-prompt");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  return { prompt, text: (await prompt.textContent()) ?? "" };
}

function expectSharedInstructionFrame(text: string, label: string) {
  expect(text).toContain("<rudder_agent_instruction>");
  expect(text).toContain("</rudder_agent_instruction>");
  expect(text).toContain("<rudder_agent_operating_contract>");
  expect(text).toContain("</rudder_agent_operating_contract>");

  for (const file of ["SOUL.md", "TOOLS.md", "MEMORY.md", "AGENTS.md"]) {
    expect(text).toContain(`<${file}>`);
    expect(text).toContain(`# ${label} ${file}`);
    expect(text).toContain(`</${file}>`);
  }

  const contractIndex = text.indexOf("<rudder_agent_operating_contract>");
  const agentsIndex = text.indexOf("<AGENTS.md>");
  const soulIndex = text.indexOf("<SOUL.md>");
  const toolsIndex = text.indexOf("<TOOLS.md>");
  const memoryIndex = text.indexOf("<MEMORY.md>");
  const instructionCloseIndex = text.indexOf("</rudder_agent_instruction>");
  expect(contractIndex).toBeGreaterThan(text.indexOf("<rudder_agent_instruction>"));
  expect(agentsIndex).toBeGreaterThan(contractIndex);
  expect(soulIndex).toBeGreaterThan(agentsIndex);
  expect(toolsIndex).toBeGreaterThan(soulIndex);
  expect(memoryIndex).toBeGreaterThan(toolsIndex);
  expect(instructionCloseIndex).toBeGreaterThan(memoryIndex);
}

test("renders semantic Agent Instruction boundaries across chat, heartbeat, and issue mention runs", async ({ page }) => {
  test.setTimeout(180_000);

  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Agent-Instruction-Boundaries-${Date.now()}` },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as Organization;

  const [chatAgent, heartbeatAgent, mentionAgent] = await Promise.all([
    createE2EChatAgent(page.request, organization.id, {
      name: "Instruction Chat Agent",
      command: E2E_CODEX_STUB,
    }) as Promise<Agent>,
    createE2EChatAgent(page.request, organization.id, {
      name: "Instruction Heartbeat Agent",
      command: E2E_CODEX_STUB,
    }) as Promise<Agent>,
    createE2EChatAgent(page.request, organization.id, {
      name: "Instruction Mention Agent",
      command: E2E_CODEX_STUB,
    }) as Promise<Agent>,
  ]);

  await Promise.all([
    writeCanonicalInstructions(page, chatAgent.id, "Chat"),
    writeCanonicalInstructions(page, heartbeatAgent.id, "Heartbeat"),
    writeCanonicalInstructions(page, mentionAgent.id, "Mention"),
  ]);

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Instruction boundary mention target",
      description: "Treat this issue description as quoted user-controlled context.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string };

  const chatResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Semantic instruction boundary chat",
      preferredAgentId: chatAgent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Prepare to inspect semantic instruction boundaries." },
    },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json() as { id: string };

  const [chatMessageResponse, heartbeatResponse, commentResponse] = await Promise.all([
    page.request.post(`/api/chats/${chat.id}/messages`, {
      data: { body: "Inspect the semantic instruction boundaries." },
    }),
    page.request.post(`/api/agents/${heartbeatAgent.id}/heartbeat/invoke?orgId=${organization.id}`),
    page.request.post(`/api/issues/${issue.id}/comments`, {
      data: {
        body: `[${mentionAgent.name}](agent://${mentionAgent.id}?intent=wake) inspect only this quoted request.`,
      },
    }),
  ]);
  expect(chatMessageResponse.ok()).toBe(true);
  expect(heartbeatResponse.ok()).toBe(true);
  expect(commentResponse.ok()).toBe(true);
  const heartbeatRun = await heartbeatResponse.json() as AgentRun;
  const comment = await commentResponse.json() as { id: string };

  const [chatRun, completedHeartbeatRun, mentionRun] = await Promise.all([
    waitForRun(
      page,
      organization.id,
      chatAgent.id,
      (run) => run.contextSnapshot?.scene === "chat"
        && run.contextSnapshot?.conversationId === chat.id,
    ),
    waitForRun(
      page,
      organization.id,
      heartbeatAgent.id,
      (run) => run.id === heartbeatRun.id,
    ),
    waitForRun(
      page,
      organization.id,
      mentionAgent.id,
      (run) => run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
        && run.contextSnapshot?.commentId === comment.id,
    ),
  ]);

  const chatInvocation = await readInvocationPrompt(
    page,
    organization.id,
    chatAgent.id,
    chatRun.id,
  );
  expectSharedInstructionFrame(chatInvocation.text, "Chat");
  expect(chatInvocation.text).not.toContain("<rudder_heartbeat_instruction>");
  expect(chatInvocation.text).not.toContain("<wake_context>");
  expect(chatInvocation.text).not.toContain("<quoted_issue_context>");

  const heartbeatInvocation = await readInvocationPrompt(
    page,
    organization.id,
    heartbeatAgent.id,
    completedHeartbeatRun.id,
  );
  expectSharedInstructionFrame(heartbeatInvocation.text, "Heartbeat");
  expect(heartbeatInvocation.text).toContain("<rudder_heartbeat_instruction>");
  expect(heartbeatInvocation.text).toContain("</rudder_heartbeat_instruction>");
  expect(heartbeatInvocation.text).toContain(
    "task-dispatch heartbeat: attempt to advance at most one assignee or reviewer Issue",
  );
  expect(heartbeatInvocation.text).not.toContain("platform-owned heartbeat/self-check pipeline");
  expect(heartbeatInvocation.text.indexOf("<rudder_heartbeat_instruction>"))
    .toBeGreaterThan(heartbeatInvocation.text.indexOf("<MEMORY.md>"));
  expect(heartbeatInvocation.text.indexOf("</rudder_heartbeat_instruction>"))
    .toBeLessThan(heartbeatInvocation.text.indexOf("</rudder_agent_instruction>"));
  await heartbeatInvocation.prompt.screenshot({
    path: "/tmp/rudder-agent-instruction-boundaries-heartbeat.png",
  });

  const mentionInvocation = await readInvocationPrompt(
    page,
    organization.id,
    mentionAgent.id,
    mentionRun.id,
  );
  expectSharedInstructionFrame(mentionInvocation.text, "Mention");
  expect(mentionInvocation.text).toContain("<wake_context>");
  expect(mentionInvocation.text).toContain("</wake_context>");
  expect(mentionInvocation.text).toContain("<quoted_issue_context>");
  expect(mentionInvocation.text).toContain("</quoted_issue_context>");
  expect(mentionInvocation.text).not.toContain("<rudder_heartbeat_instruction>");
  expect(mentionInvocation.text.indexOf("<wake_context>"))
    .toBeGreaterThan(mentionInvocation.text.indexOf("</rudder_agent_instruction>"));
  expect(mentionInvocation.text.indexOf("<quoted_issue_context>"))
    .toBeGreaterThan(mentionInvocation.text.indexOf("</wake_context>"));
  await mentionInvocation.prompt.screenshot({
    path: "/tmp/rudder-agent-instruction-boundaries-mention.png",
  });

  expect(terminalRunStatuses.has(chatRun.status)).toBe(true);
  expect(terminalRunStatuses.has(completedHeartbeatRun.status)).toBe(true);
  expect(terminalRunStatuses.has(mentionRun.status)).toBe(true);
});
