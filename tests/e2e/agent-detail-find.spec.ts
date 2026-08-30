import { expect, test, type Page } from "@playwright/test";

async function openAgentFind(page: Page, query: string) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");

  const findUi = page.getByRole("search", { name: "Find in agent" });
  await expect(findUi).toBeVisible();

  const input = findUi.getByRole("textbox", { name: "Find in agent" });
  await input.fill(query);
  return { findUi, input };
}

async function expectCssHighlight(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const highlights = (CSS as unknown as {
      highlights?: { get: (name: string) => { size?: number } | undefined };
    }).highlights;
    return highlights?.get("rudder-issue-find-highlight")?.size ?? 0;
  })).toBeGreaterThan(0);
}

test("Agent Detail supports Command+F across every local detail view", async ({ page }) => {
  const suffix = Date.now();
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Agent-Detail-Find-${suffix}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: `Searchable Agent ${suffix}`,
      role: "engineer",
      title: "Find Acceptance Engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.6-sol" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string; urlKey: string };

  await page.route(`**/api/orgs/${organization.id}/adapters/codex_local/models`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: [{
        id: "gpt-5.6-sol",
        label: "gpt-5.6-sol",
        variants: ["low", "medium", "high", "xhigh", "max", "ultra"],
      }],
    });
  });

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem("rudder:agent-skills:onboarding:v1", "dismissed");
  }, organization.id);

  const views = [
    { route: "dashboard", text: "Recent Issues" },
    { route: "configuration", text: "Agent Runtime" },
    { route: "skills", text: "Add Skill" },
    { route: "integrations", text: "Supabase" },
    { route: "runs", text: "No runs yet." },
  ] as const;

  for (const view of views) {
    await page.goto(`/${organization.issuePrefix}/agents/${agent.urlKey}/${view.route}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText(view.text, { exact: true }).first()).toBeVisible();

    const { findUi, input } = await openAgentFind(page, view.text);
    await expect(findUi).not.toContainText("0 of 0");
    await expectCssHighlight(page);

    await input.press("Escape");
    await expect(findUi).toHaveCount(0);
  }

  const { findUi, input } = await openAgentFind(page, `NoAgentMatch${suffix}`);
  await expect(findUi).toContainText("0 of 0");
  await expect(page.locator("#main-content")).toBeVisible();
  await input.press("Escape");
});
