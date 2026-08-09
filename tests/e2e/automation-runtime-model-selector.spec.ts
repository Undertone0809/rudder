import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Automation runtime model selector", () => {
  test("closes runtime menus after model and thinking selections", async ({ page }, testInfo) => {
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
    const otherAgentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Automation other Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(otherAgentRes.ok()).toBe(true);

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
    await expect(page.getByTestId("issue-runtime-selector")).toHaveCount(0);
    await assigneeControl.getByRole("button").first().click();
    const initialAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Automation runtime Agent" });
    const otherAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Automation other Agent" });
    await expect(initialAgentOption.getByTestId("issue-runtime-selector")).toBeVisible();
    await expect(otherAgentOption.getByTestId("issue-runtime-selector")).toHaveCount(0);
    const assigneeSearch = page.getByPlaceholder("Search assignees...");
    await assigneeSearch.fill("Automation other Agent");
    await assigneeSearch.press("Enter");
    const selectedAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: "Automation other Agent" });
    const runtimeSelector = selectedAgentOption.getByTestId("issue-runtime-selector");
    await expect(runtimeSelector).toBeVisible();
    await expect(selectedAgentOption.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(runtimeSelector).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("automation-agent-menu.png"), fullPage: false });
    await runtimeSelector.press("ArrowRight");
    await expect(page.getByTestId("issue-runtime-profile-panel")).toBeVisible();
    const runtimeTriggerBox = await runtimeSelector.boundingBox();
    const profilePanelBox = await page.getByTestId("issue-runtime-profile-panel").boundingBox();
    expect(runtimeTriggerBox).not.toBeNull();
    expect(profilePanelBox).not.toBeNull();
    expect(profilePanelBox!.x).toBeGreaterThanOrEqual(12);
    expect(profilePanelBox!.y).toBeGreaterThanOrEqual(12);
    expect(profilePanelBox!.x + profilePanelBox!.width).toBeLessThanOrEqual(1440 - 12);
    expect(profilePanelBox!.y + profilePanelBox!.height).toBeLessThanOrEqual(960 - 12);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("issue-runtime-profile-panel")).toBeHidden();
    await runtimeSelector.click();
    await expect(page.getByTestId("issue-runtime-profile-panel")).toBeVisible();
    await page.getByTestId("issue-runtime-model-trigger").click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();

    const modelOption = page.getByTestId("issue-runtime-option-default-model");
    await expect(modelOption).toBeVisible();
    const selectedModelLabel = (await modelOption.textContent())?.trim();
    await modelOption.click();
    await expect(page.getByTestId("issue-runtime-profile-panel")).toHaveCount(0);
    await expect(page.getByTestId("issue-runtime-model-options")).toHaveCount(0);
    await expect(runtimeSelector).toBeFocused();

    await runtimeSelector.press("ArrowRight");
    await page.getByTestId("issue-runtime-effort-trigger").click();
    const effortOption = page.locator(
      '[data-testid^="issue-runtime-option-effort-"]:not([data-testid="issue-runtime-option-effort-default"])',
    ).first();
    await expect(effortOption).toBeVisible();
    const selectedEffort = (await effortOption.getAttribute("data-testid"))
      ?.replace("issue-runtime-option-effort-", "");
    await effortOption.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("issue-runtime-profile-panel")).toHaveCount(0);
    await expect(page.getByTestId("issue-runtime-effort-options")).toHaveCount(0);
    await expect(runtimeSelector).toBeFocused();

    await expect.poll(async () => {
      const response = await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}`);
      expect(response.ok()).toBe(true);
      const detail = await response.json() as {
        assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
      };
      return detail.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.modelReasoningEffort ?? null;
    }).toBe(selectedEffort);

    const persisted = await (await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}`)).json() as {
      assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
    };
    expect(selectedEffort).toBeTruthy();
    expect(persisted.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.model).toBeUndefined();
    expect(persisted.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.modelReasoningEffort).toBe(selectedEffort);
    expect(selectedModelLabel).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("issue-runtime-selector")).toHaveCount(0);
    await page.getByTestId("automation-detail-agent-control").getByRole("button").first().click();
    const restoredRuntimeSelector = page.getByTestId("issue-runtime-selector");
    await expect(restoredRuntimeSelector).toBeVisible();
    await expect(restoredRuntimeSelector).toHaveAttribute("title", /Custom profile/);
    await page.screenshot({ path: testInfo.outputPath("automation-runtime-model-selector.png"), fullPage: false });
  });

  test("selects a model in the new automation composer before creation", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
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
    const composer = page.getByTestId("automation-composer-shell");
    await expect(page.getByTestId("issue-runtime-selector")).toHaveCount(0);
    await page.getByRole("button", { name: "Assignee" }).click();
    await page.getByRole("button", { name: /Composer runtime Agent/ }).click();

    const runtimeSelector = page.getByTestId("issue-runtime-selector");
    await expect(runtimeSelector).toBeVisible();
    await runtimeSelector.click();
    await expect(page.getByTestId("issue-runtime-profile-panel")).toBeVisible();
    const modelTrigger = page.getByTestId("issue-runtime-model-trigger");
    await modelTrigger.click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();
    const triggerBox = await modelTrigger.boundingBox();
    const submenuBox = await page.getByTestId("issue-runtime-model-options").boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(submenuBox).not.toBeNull();
    expect(Math.abs(submenuBox!.y - triggerBox!.y)).toBeLessThanOrEqual(12);
    expect(submenuBox!.x).toBeGreaterThanOrEqual(12);
    expect(submenuBox!.y).toBeGreaterThanOrEqual(12);
    expect(submenuBox!.x + submenuBox!.width).toBeLessThanOrEqual(1280 - 12);
    expect(submenuBox!.y + submenuBox!.height).toBeLessThanOrEqual(720 - 12);
    await page.locator('[data-testid^="issue-runtime-option-model-"]').first().click();
    await expect(page.getByTestId("issue-runtime-profile-panel")).toHaveCount(0);
    await expect(page.getByTestId("issue-runtime-model-options")).toHaveCount(0);
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

  test("keeps long agent and model labels usable on a narrow detail view", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto(E2E_BASE_URL);

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Automation-narrow-model-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const longAgentName = "Automation agent with a deliberately long name for narrow screens";
    const longModel = "gpt-5.6-model-name-that-is-long-enough-to-test-truncation";
    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: longAgentName,
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: longModel },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Narrow automation model selector",
        description: "Verify long runtime labels remain usable on narrow screens.",
        assigneeAgentId: agent.id,
        outputMode: "track_issue",
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = await automationRes.json() as { id: string };

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations/${automation.id}`);
    const assigneeControl = page.getByTestId("automation-detail-agent-control");
    await assigneeControl.getByRole("button").first().click();
    const selectedAgentOption = page.locator("[data-inline-entity-option]").filter({ hasText: longAgentName });
    const runtimeSelector = selectedAgentOption.getByTestId("issue-runtime-selector");
    await expect(runtimeSelector).toBeVisible();
    const assigneeMenuBox = await page.locator("[data-radix-popper-content-wrapper]").last().boundingBox();
    const runtimeBox = await runtimeSelector.boundingBox();
    const mobileNavBox = await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox();
    expect(assigneeMenuBox).not.toBeNull();
    expect(runtimeBox).not.toBeNull();
    expect(mobileNavBox).not.toBeNull();
    expect(assigneeMenuBox!.x).toBeGreaterThanOrEqual(8);
    expect(assigneeMenuBox!.x + assigneeMenuBox!.width).toBeLessThanOrEqual(375 - 8);
    expect(assigneeMenuBox!.y + assigneeMenuBox!.height).toBeLessThanOrEqual(mobileNavBox!.y);
    expect(runtimeBox!.x + runtimeBox!.width).toBeLessThanOrEqual(375 - 8);
    await page.screenshot({ path: testInfo.outputPath("automation-agent-menu-narrow-long-labels.png"), fullPage: false });

    await runtimeSelector.click();
    const profilePanel = page.getByTestId("issue-runtime-profile-panel");
    await expect(profilePanel).toBeVisible();
    const profilePanelBox = await profilePanel.boundingBox();
    expect(profilePanelBox).not.toBeNull();
    expect(profilePanelBox!.x).toBeGreaterThanOrEqual(12);
    expect(profilePanelBox!.y).toBeGreaterThanOrEqual(12);
    expect(profilePanelBox!.x + profilePanelBox!.width).toBeLessThanOrEqual(375 - 12);
    expect(profilePanelBox!.y + profilePanelBox!.height).toBeLessThanOrEqual(844 - 72);

    await page.getByTestId("issue-runtime-model-trigger").click();
    const modelOptions = page.getByTestId("issue-runtime-model-options");
    await expect(modelOptions).toBeVisible();
    await expect(modelOptions).toContainText(longModel);
    const modelOptionsBox = await modelOptions.boundingBox();
    expect(modelOptionsBox).not.toBeNull();
    expect(modelOptionsBox!.x).toBeGreaterThanOrEqual(12);
    expect(modelOptionsBox!.y).toBeGreaterThanOrEqual(12);
    expect(modelOptionsBox!.x + modelOptionsBox!.width).toBeLessThanOrEqual(375 - 12);
    expect(modelOptionsBox!.y + modelOptionsBox!.height).toBeLessThanOrEqual(844 - 72);
    expect(
      modelOptionsBox!.x >= profilePanelBox!.x + profilePanelBox!.width
      || modelOptionsBox!.x + modelOptionsBox!.width <= profilePanelBox!.x
      || modelOptionsBox!.y >= profilePanelBox!.y + profilePanelBox!.height
      || modelOptionsBox!.y + modelOptionsBox!.height <= profilePanelBox!.y,
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("automation-runtime-model-narrow-long-labels.png"), fullPage: false });
  });
});
