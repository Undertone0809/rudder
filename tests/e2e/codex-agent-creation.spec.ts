import { expect, test } from "@playwright/test";

test("creates a Codex agent with GPT-6.2 Sol High and keeps the new models usable without discovery", async ({ page }) => {
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Codex Agent Creation ${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json() as { id: string; issuePrefix: string };
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, org.id);

  await page.goto(`/${org.issuePrefix}/agents/all`);
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("button", { name: "I want advanced configuration myself" }).click();
  await page.getByRole("button", { name: /Codex.*Local Codex agent/ }).click();

  const form = page.getByTestId("new-agent-form");
  await expect(form.getByTestId("agent-primary-model")).toHaveText("GPT-6.2-Sol");
  await expect(form.getByRole("button", { name: "High", exact: true })).toBeVisible();
  await page.getByPlaceholder("Agent name").fill("Codex Default Operator");
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/api/orgs/${org.id}/agent-hires`),
  );
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const created = await createResponse;
  expect(created.ok()).toBe(true);
  const { agent } = await created.json() as { agent: { id: string } };
  await expect(page.getByRole("heading", { name: "Codex Default Operator", exact: true })).toBeVisible();
  const saved = await page.request.get(`/api/agents/${agent.id}`);
  expect(saved.ok()).toBe(true);
  expect(await saved.json()).toMatchObject({
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: { model: "gpt-6.2-sol", modelReasoningEffort: "high" },
  });

  await page.route(`**/api/orgs/${org.id}/adapters/codex_local/models`, (route) => route.abort());
  await page.goto(`/${org.issuePrefix}/agents/new?agentRuntimeType=codex_local`);
  await form.getByTestId("agent-primary-model").click();
  const popover = page.locator("[data-radix-popper-content-wrapper]").last();
  await popover.getByRole("button", { name: "GPT-6.2-Astra", exact: true }).click();
  await form.getByRole("button", { name: "High", exact: true }).click();
  await expect(popover.getByRole("button")).toHaveCount(7);
  for (const effort of ["Auto", "Low", "Medium", "High", "Extra High", "Max", "Ultra"]) {
    await expect(popover.getByText(effort, { exact: true })).toBeVisible();
  }
  await popover.getByText("Ultra", { exact: true }).click();
  await page.getByPlaceholder("Agent name").fill("Codex Astra Operator");
  const overrideResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/api/orgs/${org.id}/agent-hires`),
  );
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const overridden = await overrideResponse;
  expect(overridden.ok()).toBe(true);
  expect(await overridden.json()).toMatchObject({
    agent: { agentRuntimeConfig: { model: "gpt-6.2-astra", modelReasoningEffort: "ultra" } },
  });
});
