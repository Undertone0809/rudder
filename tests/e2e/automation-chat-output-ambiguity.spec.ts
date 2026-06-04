import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { E2E_BASE_URL } from "./support/e2e-env";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function createGuardAwareCodexStub() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-automation-chat-"));
  const script = path.join(dir, "codex-automation-chat-guard.js");
  await fs.writeFile(script, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const hasGuard =
    prompt.includes('structuredPayload.eventType = "automation_run_input"') &&
    prompt.includes('Do not emit result kind "automation_create" because of an automation-run input.');
  const response = hasGuard
    ? {
      kind: "message",
      body: "Guarded automation execution.",
      structuredPayload: null,
    }
    : {
      kind: "automation_create",
      body: "I can create that daily automation.",
      structuredPayload: {
        automationCreate: {
          title: "Daily information flow",
          description: "Send a daily information flow.",
          priority: "medium",
          outputMode: "chat_output",
          schedule: {
            cronExpression: "0 9 * * *",
            timezone: "Asia/Shanghai",
          },
        },
      },
    };
  const finalText = sentinel + JSON.stringify(response);
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      id: "msg-automation-chat-guard",
      type: "agent_message",
      text: finalText,
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    result: finalText,
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }) + "\\n");
});
`);
  await fs.chmod(script, 0o755);
  return { dir, script };
}

test.describe("Automation chat-output ambiguity", () => {
  test("executes an existing Send to chat automation instead of treating its run input as automation creation", async ({ page }) => {
    const stub = await createGuardAwareCodexStub();
    test.info().attachments.push({ name: "guard-aware-codex-stub", path: stub.script, contentType: "text/plain" });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automation-Chat-Ambiguity-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Daily Flow Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: stub.script,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = (await agentRes.json()) as { id: string };

    const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Daily information flow",
        description: "Send me a daily information flow.",
        assigneeAgentId: agent.id,
        priority: "medium",
        outputMode: "chat_output",
        chatConversationId: null,
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = (await automationRes.json()) as { id: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations/${automation.id}`);
    await page.getByRole("button", { name: "Run now" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]+/);

    await expect(page.getByText("Automation: Daily information flow").first()).toBeVisible();
    await expect(page.getByText("Guarded automation execution.").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("I can create that daily automation.")).toHaveCount(0);
    await expect(page.getByText("Created automation")).toHaveCount(0);

    const runsRes = await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}/runs?limit=10`);
    expect(runsRes.ok()).toBe(true);
    const runs = (await runsRes.json()) as Array<{
      status: string;
      linkedIssueId: string | null;
      linkedChatConversationId: string | null;
    }>;
    const completedRun = runs.find((run) => run.status === "completed");
    expect(completedRun?.linkedIssueId).toBeNull();
    expect(completedRun?.linkedChatConversationId).toBeTruthy();
  });
});
