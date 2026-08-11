import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { chatConversations, chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("localizes completed Chat process activity and the Work manifest in zh-CN", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Process-ZH-${Date.now()}`,
      issuePrefix: `CPZ${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "中文过程 Agent" });
  const chat = { id: randomUUID() };
  await e2eDb.insert(chatConversations).values({
    id: chat.id,
    orgId: organization.id,
    title: "中文过程适配",
    preferredAgentId: agent.id,
  });
  const chatTurnId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const startedAt = new Date("2026-08-11T00:00:00.000Z");
  const endedAt = new Date("2026-08-11T02:27:14.000Z");

  await e2eDb.insert(chatMessages).values([
    {
      id: userMessageId,
      orgId: organization.id,
      conversationId: chat.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "请结合 https://source.example/brief 完成分析。",
      chatTurnId,
      turnVariant: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
    },
    {
      id: assistantMessageId,
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "分析已完成，参考 https://reference.example/report 。",
      structuredPayload: {
        __chatTranscript: [
          {
            kind: "tool_call",
            ts: startedAt.toISOString(),
            name: "Skill",
            toolUseId: "skill-1",
            input: { skill: "mcp-chrome-global" },
          },
          {
            kind: "tool_result",
            ts: "2026-08-11T00:00:02.000Z",
            toolUseId: "skill-1",
            content: "Loaded skill",
            isError: false,
          },
          {
            kind: "tool_call",
            ts: "2026-08-11T00:00:03.000Z",
            name: "Read",
            toolUseId: "read-1",
            input: { path: "/workspace/apple-mail.md" },
          },
          {
            kind: "tool_result",
            ts: "2026-08-11T00:00:04.000Z",
            toolUseId: "read-1",
            content: "Mail notes",
            isError: false,
          },
          {
            kind: "tool_call",
            ts: "2026-08-11T02:27:13.000Z",
            name: "mcp__rudder-tools__rudder_automation_get",
            toolUseId: "mcp-1",
            input: { automationId: "automation-1" },
          },
          {
            kind: "tool_result",
            ts: endedAt.toISOString(),
            toolUseId: "mcp-1",
            content: "Automation details",
            isError: false,
          },
        ],
      },
      replyingAgentId: agent.id,
      chatTurnId,
      turnVariant: 0,
      createdAt: endedAt,
      updatedAt: endedAt,
    },
  ]);

  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, uiLocale: "zh-CN" } });
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const transcript = page.getByTestId("chat-transcript-item");
  const processButton = transcript.getByRole("button", { name: /已完成，147 分钟 14 秒/ });
  await expect(processButton).toBeVisible({ timeout: 15_000 });
  await processButton.click();

  const activityButton = transcript.getByRole("button", { name: "展开工具活动" });
  await expect(activityButton).toContainText("使用了 1 个技能，读取了 1 个文件，使用了 1 个工具");
  await activityButton.click();
  await expect(transcript).toContainText("使用 mcp-chrome-global 技能");
  await expect(transcript).toContainText("读取 apple-mail.md");
  await expect(transcript).toContainText("调用 Rudder automation get");

  const shelf = page.getByRole("complementary", { name: "会话文件与链接" });
  await expect(shelf).toBeVisible();
  await expect(shelf.getByRole("region", { name: "来源" })).toBeVisible();
  await expect(shelf.getByRole("region", { name: "引用" })).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-chat-process-localization-desktop.png", fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const compactTrigger = page.getByTestId("chat-work-manifest-trigger");
  await expect(compactTrigger).toContainText("来源 1");
  await expect(processButton).toBeVisible();
  const compactTriggerBox = await compactTrigger.boundingBox();
  const toolbarActionsBox = await page.getByTestId("chat-desktop-toolbar-actions").boundingBox();
  expect(compactTriggerBox).not.toBeNull();
  expect(toolbarActionsBox).not.toBeNull();
  expect(compactTriggerBox!.x + compactTriggerBox!.width).toBeLessThanOrEqual(toolbarActionsBox!.x);
  await page.screenshot({ path: "/tmp/rudder-chat-process-localization-mobile.png", fullPage: false });

  const activeStartedAt = new Date(Date.now() - ((147 * 60 + 14) * 1_000));
  await e2eDb.update(chatMessages).set({
    status: "tool_busy",
    structuredPayload: {
      __chatTranscript: [
        {
          kind: "tool_call",
          ts: activeStartedAt.toISOString(),
          name: "mcp__rudder-tools__rudder_automation_get",
          toolUseId: "mcp-active-1",
          input: { automationId: "automation-1" },
        },
      ],
    },
    createdAt: activeStartedAt,
    updatedAt: new Date(),
  }).where(eq(chatMessages.id, assistantMessageId));
  await e2eDb.update(chatMessages).set({
    createdAt: activeStartedAt,
    updatedAt: activeStartedAt,
  }).where(eq(chatMessages.id, userMessageId));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const activeProcessButton = page.getByTestId("chat-transcript-item")
    .getByRole("button", { name: /正在思考，147 分钟 \d+ 秒/ });
  await expect(activeProcessButton).toBeVisible({ timeout: 15_000 });
  await activeProcessButton.click();
  const runningMessages = page.getByTestId("chat-messages-content");
  await expect(runningMessages).toContainText("调用 Rudder automation get");
  await expect(runningMessages).toContainText("运行中");
  await expect(runningMessages).not.toContainText("Working");
  await page.screenshot({ path: "/tmp/rudder-chat-process-localization-running.png", fullPage: false });
});
