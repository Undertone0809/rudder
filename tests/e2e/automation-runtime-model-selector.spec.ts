import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Automation runtime model selector", () => {
  test("selects and persists a model for the current automation agent", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(E2E_BASE_URL);

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Automation-runtime-selector-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Automation runtime Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Select an automation model",
        description: "Verify an automation can use a selected model.",
        assigneeAgentId: agent.id,
        outputMode: "track_issue",
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = await automationRes.json() as { id: string };

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations/${automation.id}`);
    const assigneeControl = page.getByTestId("automation-detail-agent-control");
    await expect(assigneeControl).toBeVisible();
    const runtimeSelector = assigneeControl.getByTestId("issue-runtime-selector");
    await expect(runtimeSelector).toBeVisible();
    await runtimeSelector.click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();

    const modelOption = page.locator('[data-testid^="issue-runtime-option-model-"]').first();
    await expect(modelOption).toBeVisible();
    const selectedModelId = (await modelOption.getAttribute("data-testid"))?.replace("issue-runtime-option-model-", "");
    const selectedModelLabel = (await modelOption.textContent())?.trim();
    await modelOption.click();
    await page.getByTestId("issue-runtime-apply").click();

    await expect.poll(async () => {
      const response = await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}`);
      expect(response.ok()).toBe(true);
      const detail = await response.json() as {
        assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
      };
      return detail.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.model ?? null;
    }).not.toBeNull();

    const persisted = await (await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}`)).json() as {
      assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
    };
    expect(selectedModelId).toBeTruthy();
    expect(persisted.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.model).toBe(selectedModelId);
    expect(selectedModelLabel).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("issue-runtime-selector")).toHaveAttribute("title", /Custom profile/);
    await page.screenshot({ path: testInfo.outputPath("automation-runtime-model-selector.png"), fullPage: false });
  });

  test("selects a model in the new automation composer before creation", async ({ page }) => {
    await page.goto(E2E_BASE_URL);

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Automation-composer-model-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Composer runtime Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);
    await page.getByRole("button", { name: "Create automation" }).click();
    await page.getByPlaceholder("Automation title").fill("Composer model selection");
    await page.getByRole("button", { name: "Assignee" }).click();
    await page.getByRole("button", { name: /Composer runtime Agent/ }).click();

    const composer = page.getByTestId("automation-composer-shell");
    await expect(composer.getByTestId("issue-runtime-selector")).toBeVisible();
    await composer.getByTestId("issue-runtime-selector").click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();
    await page.locator('[data-testid^="issue-runtime-option-model-"]').first().click();
    await page.getByTestId("issue-runtime-apply").click();
    await page.getByRole("button", { name: /^Create$/ }).click();

    await expect(page.getByText("Composer model selection", { exact: true })).toBeVisible();
    const automationsRes = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`);
    expect(automationsRes.ok()).toBe(true);
    const created = ((await automationsRes.json()) as Array<{
      title: string;
      assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
    }>).find((automation) => automation.title === "Composer model selection");
    expect(created?.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.model).toBeTruthy();
  });
});
