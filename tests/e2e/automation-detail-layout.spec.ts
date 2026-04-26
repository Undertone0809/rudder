import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Automation detail layout", () => {
  test("keeps page actions in the header and relies on autosave", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Automation-Layout-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Onboarding",
        description: "Project used to verify the automation detail layout.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Automation Layout Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Every morning summarize onboarding blockers",
        description: "Check onboarding health and report the top blockers.",
        projectId: project.id,
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = await automationRes.json() as { id: string };

    const triggerRes = await page.request.post(`/api/automations/${automation.id}/triggers`, {
      data: {
        kind: "schedule",
        label: "daily-check",
        cronExpression: "0 10 * * *",
        timezone: "Asia/Shanghai",
      },
    });
    expect(triggerRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}?tab=triggers`);

    const headerActions = page.getByTestId("workspace-main-header-actions");
    const shell = page.getByTestId("automation-detail-shell");
    const addTriggerCard = page.getByTestId("automation-add-trigger-card");
    const triggersList = page.getByTestId("automation-triggers-list");
    const statusButton = headerActions.getByRole("button", { name: "Pause automation" });
    const deleteButton = headerActions.getByRole("button", { name: "Delete automation" });
    const runButton = headerActions.getByRole("button", { name: "Run now" });

    await expect(headerActions).toBeVisible();
    await expect(shell).toBeVisible();
    await expect(addTriggerCard).toBeVisible();
    await expect(triggersList).toBeVisible();
    await expect(statusButton).toBeVisible();
    await expect(deleteButton).toBeVisible();
    await expect(runButton).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Save$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByText(/Automatic triggers/)).toHaveCount(0);
    await expect(page.getByText(/Changes save automatically/)).toHaveCount(0);
    await expect(addTriggerCard.getByRole("button", { name: "Add trigger" })).toBeVisible();

    const assigneeSelector = page.getByRole("button", { name: /Automation Layout Agent/ });
    const projectSelector = page.getByRole("button", { name: /Onboarding/ });
    await expect(assigneeSelector).toHaveCSS("border-top-width", "1px");
    await expect(projectSelector).toHaveCSS("border-top-width", "1px");

    const titleInput = page.getByPlaceholder("Automation title");
    const patchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await titleInput.fill("Every morning summarize onboarding blockers and risks");
    const patchResponse = await patchPromise;
    expect(patchResponse.ok()).toBe(true);
    await expect(page.getByText("In sync")).toBeVisible({ timeout: 10_000 });

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Delete");
      await dialog.dismiss();
    });
    await deleteButton.click();

    const viewport = page.viewportSize();
    const shellBox = await shell.boundingBox();
    const headerActionsBox = await headerActions.boundingBox();
    const statusButtonBox = await statusButton.boundingBox();
    const deleteButtonBox = await deleteButton.boundingBox();
    const runButtonBox = await runButton.boundingBox();
    const addTriggerBox = await addTriggerCard.boundingBox();
    const triggersListBox = await triggersList.boundingBox();

    expect(viewport).not.toBeNull();
    expect(shellBox).not.toBeNull();
    expect(headerActionsBox).not.toBeNull();
    expect(statusButtonBox).not.toBeNull();
    expect(deleteButtonBox).not.toBeNull();
    expect(runButtonBox).not.toBeNull();
    expect(addTriggerBox).not.toBeNull();
    expect(triggersListBox).not.toBeNull();

    expect(statusButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(deleteButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(runButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(runButtonBox!.x).toBeGreaterThan(deleteButtonBox!.x);
    expect(addTriggerBox!.y + addTriggerBox!.height).toBeLessThan(triggersListBox!.y + 8);
    expect(addTriggerBox!.x).toBeGreaterThanOrEqual(shellBox!.x - 2);

    await page.screenshot({
      path: testInfo.outputPath("automation-detail-layout.png"),
      fullPage: true,
    });
  });
});
