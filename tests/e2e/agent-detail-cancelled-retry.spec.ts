import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Agent detail cancelled run retry", () => {
  test("offers retry for a cancelled adapter failure and opens the retried run", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Agent-Cancelled-Retry-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Retryable Designer",
        role: "designer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const runId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      startedAt: new Date("2026-05-13T06:13:02.000Z"),
      finishedAt: new Date("2026-05-13T06:15:18.000Z"),
      error: "Adapter failed",
      errorCode: "cancelled",
      stderrExcerpt: "worker quit with fatal transport channel closed",
      contextSnapshot: {
        wakeReason: "manual",
        wakeSource: "on_demand",
      },
      createdAt: new Date("2026-05-13T06:13:02.000Z"),
      updatedAt: new Date("2026-05-13T06:15:18.000Z"),
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

    const detailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(detailPane.getByText("Adapter failed")).toBeVisible({ timeout: 15_000 });
    const summaryCard = detailPane.getByTestId("run-summary-card");
    const retryButton = summaryCard.getByTestId("run-detail-retry");
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toHaveText(/Retry/);

    const summaryBox = await summaryCard.boundingBox();
    const retryBox = await retryButton.boundingBox();
    expect(summaryBox).not.toBeNull();
    expect(retryBox).not.toBeNull();
    expect(retryBox!.x + retryBox!.width).toBeGreaterThan(summaryBox!.x + summaryBox!.width * 0.75);
    expect(retryBox!.y).toBeLessThan(summaryBox!.y + 48);

    const retryResponsePromise = page.waitForResponse((response) =>
      response.url().includes(`/api/heartbeat-runs/${runId}/retry`) && response.request().method() === "POST",
    );
    await retryButton.click();
    const retryResponse = await retryResponsePromise;
    expect(retryResponse.ok()).toBe(true);
    const retriedRun = await retryResponse.json() as { id: string; retryOfRunId: string | null };

    expect(retriedRun.retryOfRunId).toBe(runId);
    await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${retriedRun.id}$`));
  });
});
