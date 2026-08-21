import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("opens the newest run by default and keeps the loading skeleton aligned", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Agent-Runs-Default-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Latest Run Operator",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const olderRunId = randomUUID();
  const newestRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values([
    {
      id: olderRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      startedAt: new Date("2026-05-22T08:00:00.000Z"),
      finishedAt: new Date("2026-05-22T08:01:00.000Z"),
      stdoutExcerpt: "Older run output",
      resultJson: { summary: "Older run output" },
      createdAt: new Date("2026-05-22T08:00:00.000Z"),
      updatedAt: new Date("2026-05-22T08:01:00.000Z"),
    },
    {
      id: newestRunId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date("2026-05-24T10:00:00.000Z"),
      finishedAt: new Date("2026-05-24T10:01:00.000Z"),
      stdoutExcerpt: "Newest default run output",
      resultJson: { summary: "Newest default run output" },
      createdAt: new Date("2026-05-24T10:00:00.000Z"),
      updatedAt: new Date("2026-05-24T10:01:00.000Z"),
    },
  ]);

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  let releaseRunsRequest!: () => void;
  const runsRequestReleased = new Promise<void>((resolve) => {
    releaseRunsRequest = resolve;
  });
  await page.route("**/api/orgs/**/agent-runs**", async (route) => {
    await runsRequestReleased;
    await route.continue();
  });

  await page.goto(`/agents/${agent.id}/runs`, { waitUntil: "domcontentloaded" });
  const mainContent = page.locator("#main-content");
  await expect(mainContent.getByTestId("agent-runs-skeleton")).toBeVisible();
  await expect(mainContent.getByTestId("agent-runs-skeleton")).toHaveAttribute("aria-busy", "true");

  releaseRunsRequest();
  await expect(mainContent.getByTestId("agent-runs-skeleton")).toHaveCount(0, { timeout: 30_000 });
  await expect(mainContent.getByTestId("run-stdout-excerpt")).toContainText("Newest default run output");
  await expect(mainContent.getByTestId("agent-runs-list-pane").getByRole("link").first())
    .toContainText(newestRunId.slice(0, 8));
});
