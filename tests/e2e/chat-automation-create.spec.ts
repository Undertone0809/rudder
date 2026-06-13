import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BIN_DIR } from "./support/e2e-env";

async function writeAutomationCreateStub(name: string) {
  await fs.mkdir(E2E_BIN_DIR, { recursive: true });
  const stubPath = path.join(E2E_BIN_DIR, `${name}.js`);
  const result = {
    kind: "automation_create",
    body: "已创建每天中午 12 点发送 AI HOT 日报的自动化。",
    structuredPayload: {
      automationCreate: {
        title: "每天中午 12 点发送 AI HOT 日报",
        instructions: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
        outputMode: "chat_output",
        priority: "medium",
        schedule: {
          cronExpression: "0 12 * * *",
          timezone: "Asia/Shanghai",
          label: "daily-noon",
        },
      },
    },
  };
  const stubSource = `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const result = ${JSON.stringify(result)};
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-automation-create", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: result.body + "\\n" + sentinel + JSON.stringify(result),
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }) + "\\n");
});
`;
  await fs.writeFile(stubPath, stubSource, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

async function createAutomationChatOrg(page: Page, name: string, command: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Automation Agent",
    command,
  });
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  return { ...organization, chatAgent };
}

test.describe("Chat automation creation", () => {
  test("creates a scheduled automation directly from an agent chat response", async ({ page }) => {
    const command = await writeAutomationCreateStub("chat-automation-create");
    const organization = await createAutomationChatOrg(page, `Chat-Automation-${Date.now()}`, command);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("以后每天中午十二点跑一次 aihot 好了");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "已创建每天中午 12 点发送 AI HOT 日报的自动化",
      { timeout: 20_000 },
    );
    await expect(page.getByText("Created automation")).toBeVisible();
    await expect(page.getByRole("link", { name: "每天中午 12 点发送 AI HOT 日报" })).toBeVisible();
    await expect(page.getByText("Review proposal")).toHaveCount(0);

    const approvalsRes = await page.request.get(`/api/orgs/${organization.id}/approvals`);
    expect(approvalsRes.ok()).toBe(true);
    expect(await approvalsRes.json()).toEqual([]);

    const automationsRes = await page.request.get(`/api/orgs/${organization.id}/automations`);
    expect(automationsRes.ok()).toBe(true);
    const automations = await automationsRes.json();
    const created = automations.find((automation: { title: string }) =>
      automation.title === "每天中午 12 点发送 AI HOT 日报",
    );
    expect(created).toMatchObject({
      assigneeAgentId: organization.chatAgent.id,
      outputMode: "chat_output",
      status: "active",
    });
    const detailRes = await page.request.get(`/api/automations/${created.id}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json();
    expect(detail.triggers).toEqual([
      expect.objectContaining({
        kind: "schedule",
        cronExpression: "0 12 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
      }),
    ]);
  });
});
