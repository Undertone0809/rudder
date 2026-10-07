import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("keeps a long run reason badge clear of the timing column", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });

  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Agent-Run-Rail-Layout-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Run Rail Layout Inspector",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const runId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "review",
    triggerDetail: "issue_changes_requested",
    status: "succeeded",
    startedAt: new Date("2026-05-24T10:00:00.000Z"),
    finishedAt: new Date("2026-05-24T10:04:00.000Z"),
    contextSnapshot: { wakeReason: "issue_changes_requested" },
    resultJson: { summary: "Run with a long review reason" },
    createdAt: new Date("2026-05-24T10:00:00.000Z"),
    updatedAt: new Date("2026-05-24T10:04:00.000Z"),
  });

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

  const row = page.getByTestId("agent-runs-list-pane").getByRole("link").first();
  await expect(row).toContainText("Changes requested");
  const reason = row.getByTestId("run-list-reason");
  const timing = row.getByTestId("run-list-timing");
  await expect(reason).toBeVisible();
  await expect(timing).toBeVisible();

  const geometry = await row.evaluate((element) => {
    const reasonBox = element.querySelector<HTMLElement>("[data-testid='run-list-reason']")?.getBoundingClientRect();
    const timingBox = element.querySelector<HTMLElement>("[data-testid='run-list-timing']")?.getBoundingClientRect();
    if (!reasonBox || !timingBox) throw new Error("Run rail geometry is unavailable");

    return {
      reason: { left: reasonBox.left, right: reasonBox.right, top: reasonBox.top, bottom: reasonBox.bottom },
      timing: { left: timingBox.left, right: timingBox.right, top: timingBox.top, bottom: timingBox.bottom },
      overlaps: reasonBox.left < timingBox.right
        && timingBox.left < reasonBox.right
        && reasonBox.top < timingBox.bottom
        && timingBox.top < reasonBox.bottom,
    };
  });

  expect(geometry.overlaps).toBe(false);
  expect(geometry.reason.right).toBeLessThanOrEqual(geometry.timing.left);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("agent-runs-history-trigger").click();
  const history = page.getByTestId("agent-runs-history-list");
  await expect(history).toBeVisible();
  await page.waitForTimeout(500);

  const mobileRow = history.getByRole("link").first();
  await expect(mobileRow).toContainText("Changes requested");
  const mobileGeometry = await mobileRow.evaluate((element) => {
    const reasonBox = element.querySelector<HTMLElement>("[data-testid='run-list-reason']")?.getBoundingClientRect();
    const timingBox = element.querySelector<HTMLElement>("[data-testid='run-list-timing']")?.getBoundingClientRect();
    if (!reasonBox || !timingBox) throw new Error("Mobile run rail geometry is unavailable");

    return {
      reason: { left: reasonBox.left, right: reasonBox.right, top: reasonBox.top, bottom: reasonBox.bottom },
      timing: { left: timingBox.left, right: timingBox.right, top: timingBox.top, bottom: timingBox.bottom },
      overlaps: reasonBox.left < timingBox.right
        && timingBox.left < reasonBox.right
        && reasonBox.top < timingBox.bottom
        && timingBox.top < reasonBox.bottom,
    };
  });

  expect(mobileGeometry.overlaps).toBe(false);
  expect(mobileGeometry.reason.right).toBeLessThanOrEqual(mobileGeometry.timing.left);
});

test("keeps a stale listed Run visible without rendering its missing detail or Reader", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });

  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Agent-Run-Stale-Detail-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Stale Run Detail Inspector",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const runId = randomUUID();
  const now = new Date();
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply_stream",
    status: "succeeded",
    startedAt: now,
    finishedAt: now,
    contextSnapshot: { wakeReason: "chat_assistant_reply_stream" },
    resultJson: { summary: "Stale list summary" },
    createdAt: now,
    updatedAt: now,
  });

  let detailRequests = 0;
  let transcriptRequests = 0;
  const detailPath = `/api/agent-runs/${runId}`;
  await page.route((url) => url.pathname === detailPath, async (route) => {
    detailRequests += 1;
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "not_found" }),
    });
  });
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/run-intelligence/runs/${runId}/transcript`) transcriptRequests += 1;
  });
  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

  const staleRow = page.getByTestId("agent-runs-list-pane").getByRole("link").first();
  await expect(staleRow).toBeVisible();
  await expect(staleRow).toContainText(runId.slice(0, 8));
  const detailPane = page.getByTestId("agent-runs-detail-pane");
  await expect(detailPane.getByRole("alert")).toContainText("Run not found");
  await expect(detailPane).not.toContainText("Stale list summary");
  await expect(detailPane).not.toContainText("Transcript missing");
  expect(detailRequests).toBe(1);
  expect(transcriptRequests).toBe(0);
  await expect(detailPane.getByRole("link", { name: "Back to runs" })).toBeVisible();
});
