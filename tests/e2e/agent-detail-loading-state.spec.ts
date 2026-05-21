import { expect, test, type Page, type Route } from "@playwright/test";

async function createAgentFixture(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name,
      role: "engineer",
      title: "Founding Engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  return { organization, agent };
}

async function holdHeartbeatRuns(page: Page, orgId: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(`**/api/orgs/${orgId}/heartbeat-runs**`, async (route: Route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });

  return release;
}

test.describe("Agent detail loading state", () => {
  test("keeps the dashboard in a skeleton state until agent activity loads", async ({ page }) => {
    const { organization, agent } = await createAgentFixture(page, "Loading Dashboard Agent");
    const releaseHeartbeatRuns = await holdHeartbeatRuns(page, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Loading Dashboard Agent", exact: true })).toBeVisible();
    await expect(mainContent.getByTestId("agent-dashboard-skeleton")).toBeVisible();
    await expect(mainContent.getByText("No recent issues.")).toHaveCount(0);

    releaseHeartbeatRuns();

    await expect(mainContent.getByTestId("agent-dashboard-skeleton")).toHaveCount(0);
    await expect(mainContent.getByText("No recent issues.")).toBeVisible();
  });

  test("does not flash an empty runs state before runs have loaded", async ({ page }) => {
    const { organization, agent } = await createAgentFixture(page, "Loading Runs Agent");
    const releaseHeartbeatRuns = await holdHeartbeatRuns(page, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/runs`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Loading Runs Agent", exact: true })).toBeVisible();
    await expect(mainContent.getByTestId("agent-runs-skeleton")).toBeVisible();
    await expect(mainContent.getByText("No runs yet.")).toHaveCount(0);

    releaseHeartbeatRuns();

    await expect(mainContent.getByTestId("agent-runs-skeleton")).toHaveCount(0);
    await expect(mainContent.getByText("No runs yet.")).toBeVisible();
  });
});
