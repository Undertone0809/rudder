import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("starts a separate manual heartbeat while a taskless chat run is active", async ({ page }) => {
  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: {
      name: `Agent-Heartbeat-Source-${Date.now()}`,
      issuePrefix: `AH${Date.now().toString().slice(-4)}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Chat Busy Agent",
      role: "engineer",
      title: "Chat Worker",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = (await agentRes.json()) as { id: string };

  const chatRunId = randomUUID();
  const startedAt = new Date();
  await e2eDb.insert(heartbeatRuns).values({
    id: chatRunId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply",
    status: "running",
    startedAt,
    contextSnapshot: { scene: "chat" },
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
  const sidebarRow = page.getByTestId(`agent-sidebar-row-${agent.id}`);
  await expect(sidebarRow).toContainText("Chat Busy Agent");
  await sidebarRow.hover();
  await page.getByTestId(`agent-sidebar-actions-${agent.id}`).click();

  const heartbeatResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/agents/${agent.id}/heartbeat/invoke`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Run heartbeat" }).click();
  const response = await heartbeatResponse;
  expect(response.ok()).toBe(true);
  const manualRun = (await response.json()) as {
    id: string;
    invocationSource: string;
    status: string;
  };
  expect(manualRun).toMatchObject({
    invocationSource: "on_demand",
    status: "queued",
  });
  expect(manualRun.id).not.toBe(chatRunId);
  await expect(page.getByText("Heartbeat started", { exact: true })).toBeVisible();
});
