import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function createAutomationFixture(page: Page) {
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

  return { organization, automation };
}

test.describe("Automation detail layout", () => {
  test("keeps page actions in the header and moves editing context into the configuration rail", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    const { organization, automation } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}?tab=triggers`);

    const headerActions = page.getByTestId("workspace-main-header-actions");
    const shell = page.getByTestId("automation-detail-shell");
    const overviewStrip = page.getByTestId("automation-overview-strip");
    const configurationCard = page.getByTestId("automation-configuration-card");
    const agentControl = page.getByTestId("automation-detail-agent-control");
    const projectControl = page.getByTestId("automation-detail-project-control");
    const addTriggerButton = page.getByTestId("automation-add-trigger-button");
    const triggersList = page.getByTestId("automation-triggers-list");
    const triggerEditorBody = page.getByTestId("automation-trigger-editor-body");
    const statusSwitch = headerActions.getByRole("switch", { name: "Disable automation" });
    const deleteButton = headerActions.getByRole("button", { name: "Delete automation" });
    const runButton = headerActions.getByRole("button", { name: "Run now" });

    await expect(headerActions).toBeVisible();
    await expect(shell).toBeVisible();
    await expect(overviewStrip).toBeVisible();
    await expect(configurationCard).toBeVisible();
    await expect(agentControl).toBeVisible();
    await expect(projectControl).toBeVisible();
    await expect(addTriggerButton).toBeVisible();
    await expect(page.getByTestId("automation-add-trigger-card")).toHaveCount(0);
    await expect(triggersList).toBeVisible();
    await expect(triggerEditorBody).toBeHidden();
    await expect(statusSwitch).toBeVisible();
    await expect(deleteButton).toBeVisible();
    await expect(runButton).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Save$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByText(/Automatic triggers/)).toHaveCount(0);
    await expect(page.getByText(/Changes save automatically/)).toHaveCount(0);
    await expect(page.getByText("Configuration")).toBeVisible();
    await expect(configurationCard.getByText("Output")).toBeVisible();
    await expect(page.getByText("Send to chat")).toBeVisible();
    await expect(page.getByText("Run status")).toBeVisible();
    await expect(configurationCard.getByText("Triggers")).toBeVisible();
    await expect(triggersList).not.toContainText("daily-check");
    await expect(page.getByText("Details")).toHaveCount(0);
    await expect(addTriggerButton).toHaveText("Add trigger");
    await addTriggerButton.click();
    const addTriggerCard = page.getByTestId("automation-add-trigger-card");
    await expect(addTriggerCard).toBeVisible();
    await expect(addTriggerCard.getByRole("button", { name: "Create trigger" })).toBeVisible();
    const addTriggerBox = await addTriggerCard.boundingBox();
    expect(addTriggerBox).not.toBeNull();
    await triggersList.getByRole("button", { name: "Edit trigger" }).click();
    await expect(triggerEditorBody).toBeVisible();
    await expect(triggerEditorBody.getByText("Label")).toHaveCount(0);
    await expect(triggerEditorBody).not.toContainText("daily-check");

    const assigneeSelector = agentControl.getByRole("button", { name: /Automation Layout Agent/ });
    const projectSelector = projectControl.getByRole("button", { name: /Onboarding/ });
    await expect(assigneeSelector).toBeVisible();
    await expect(projectSelector).toBeVisible();

    const titleInput = page.getByPlaceholder("Automation title");
    const patchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await titleInput.fill("Every morning summarize onboarding blockers and risks");
    const patchResponse = await patchPromise;
    expect(patchResponse.ok()).toBe(true);
    await expect(page.getByText("In sync")).toBeVisible({ timeout: 10_000 });

    await deleteButton.click();
    const deleteDialog = page.getByRole("dialog", { name: /Delete/ });
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText("This will permanently remove the automation and stop future runs.");
    await expect(deleteDialog).not.toContainText("archived");
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(deleteDialog).toBeHidden();

    const viewport = page.viewportSize();
    const shellBox = await shell.boundingBox();
    const headerActionsBox = await headerActions.boundingBox();
    const statusButtonBox = await statusSwitch.boundingBox();
    const deleteButtonBox = await deleteButton.boundingBox();
    const runButtonBox = await runButton.boundingBox();
    const overviewBox = await overviewStrip.boundingBox();
    const configurationCardBox = await configurationCard.boundingBox();
    const addTriggerButtonBox = await addTriggerButton.boundingBox();
    const triggersListBox = await triggersList.boundingBox();

    expect(viewport).not.toBeNull();
    expect(shellBox).not.toBeNull();
    expect(headerActionsBox).not.toBeNull();
    expect(statusButtonBox).not.toBeNull();
    expect(deleteButtonBox).not.toBeNull();
    expect(runButtonBox).not.toBeNull();
    expect(overviewBox).not.toBeNull();
    expect(configurationCardBox).not.toBeNull();
    expect(addTriggerButtonBox).not.toBeNull();
    expect(triggersListBox).not.toBeNull();

    expect(statusButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(deleteButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(runButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(runButtonBox!.x).toBeGreaterThan(deleteButtonBox!.x);
    expect(overviewBox!.y).toBeGreaterThan(shellBox!.y);
    expect(configurationCardBox!.x).toBeGreaterThan(overviewBox!.x + overviewBox!.width);
    expect(addTriggerButtonBox!.y).toBeLessThan(triggersListBox!.y + 8);
    expect(addTriggerButtonBox!.x).toBeGreaterThanOrEqual(configurationCardBox!.x - 2);
    expect(addTriggerBox!.x + addTriggerBox!.width).toBeLessThanOrEqual(configurationCardBox!.x + 16);
    expect(addTriggerBox!.y).toBeLessThanOrEqual(addTriggerButtonBox!.y + addTriggerButtonBox!.height + 8);

    await page.screenshot({
      path: testInfo.outputPath("automation-detail-layout.png"),
      fullPage: true,
    });
  });

  test("deletes an automation from detail and returns to the list", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { organization, automation } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}`);

    await page.getByTestId("workspace-main-header-actions").getByRole("button", { name: "Delete automation" }).click();
    const deleteDialog = page.getByRole("dialog", { name: /Delete/ });
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText("This will permanently remove the automation and stop future runs.");
    await expect(page.getByText("It will be archived")).toHaveCount(0);

    const deleteResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "DELETE" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.ok()).toBe(true);

    await expect(page).toHaveURL(/\/automations$/);
    await expect(page.getByText("Every morning summarize onboarding blockers")).toHaveCount(0);
    await expect(page.getByText("Archive")).toHaveCount(0);
    await expect(page.getByText("Restore")).toHaveCount(0);
    await expect(page.getByText("Archived")).toHaveCount(0);

    const detailRes = await page.request.get(`/api/automations/${automation.id}`);
    expect(detailRes.status()).toBe(404);
  });

  test("stacks activity metadata cleanly on narrow viewports", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { organization, automation } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}`);

    const activityList = page.getByTestId("automation-activity-list");
    const firstRow = page.getByTestId("automation-activity-row").first();
    const firstSummary = page.getByTestId("automation-activity-summary").first();
    const firstTimestamp = page.getByTestId("automation-activity-time").first();
    const firstDetails = page.getByTestId("automation-activity-details").first();

    await expect(activityList).toBeVisible();
    await expect(firstRow).toBeVisible();
    await expect(firstSummary).toContainText("Added schedule trigger");
    await expect(firstDetails).toContainText("Every day at 10:00");
    await expect(firstDetails).not.toContainText("automationId");
    await expect(firstDetails).not.toContainText("kind: schedule");

    const [rowBox, summaryBox, timestampBox] = await Promise.all([
      firstRow.boundingBox(),
      firstSummary.boundingBox(),
      firstTimestamp.boundingBox(),
    ]);
    const widths = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
    }));

    expect(rowBox).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    expect(timestampBox).not.toBeNull();
    expect(timestampBox!.y).toBeGreaterThan(summaryBox!.y);
    expect(widths.bodyWidth).toBeLessThanOrEqual(widths.viewportWidth);

    await page.screenshot({
      path: testInfo.outputPath("automation-detail-mobile-layout.png"),
      fullPage: true,
    });
  });
});
