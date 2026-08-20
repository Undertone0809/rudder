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

  return { organization, project, agent, automation };
}

test.describe("Automation detail layout", () => {
  test("uses absolute timestamps for historical activity while keeping recent activity relative", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { organization, automation } = await createAutomationFixture(page);

    let historicalEventPatched = false;
    await page.route(`**/api/orgs/${organization.id}/activity**`, async (route) => {
      const response = await page.request.get(route.request().url());
      expect(response.ok()).toBe(true);
      const events = await response.json() as Array<Record<string, unknown>>;
      // The API owns createdAt, so make the historical boundary deterministic in this UI test.
      const historicalEvents = events.map((event) => {
        if (historicalEventPatched) return event;
        historicalEventPatched = true;
        return { ...event, createdAt: "2026-07-30T01:00:00.000Z" };
      });
      await route.fulfill({
        status: response.status(),
        headers: { ...response.headers(), "content-type": "application/json" },
        body: JSON.stringify(historicalEvents),
      });
    });

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}`);

    const timestamps = page.getByTestId("automation-activity-time");
    await expect(page.getByTestId("automation-activity-list")).toBeVisible();
    await expect(timestamps.filter({ hasText: /2026|Jul/ }).first()).toBeVisible();
    await expect(timestamps.filter({ hasText: /ago|just now/ }).first()).toBeVisible();
  });

  test("opens a Codex-style inspector beside the list and preserves editing controls", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1900, height: 1200 });
    const { organization, project, agent, automation } = await createAutomationFixture(page);
    const secondAutomationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Weekly review of onboarding progress",
        description: "Compare the current onboarding funnel with last week.",
        projectId: project.id,
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(secondAutomationRes.ok()).toBe(true);
    const secondAutomation = await secondAutomationRes.json() as { id: string };
    const webhookTriggerRes = await page.request.post(`/api/automations/${automation.id}/triggers`, {
      data: {
        kind: "webhook",
        signingMode: "bearer",
        replayWindowSec: 300,
      },
    });
    expect(webhookTriggerRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto("/automations");

    const headerActions = page.getByTestId("workspace-main-header-actions");
    const primaryRail = page.getByTestId("primary-rail");
    const workspaceCard = page.getByTestId("workspace-main-card");
    const masterDetail = page.getByTestId("automations-master-detail");
    const listPane = page.getByTestId("automations-list-pane");
    const automationRow = page.getByRole("row").filter({ hasText: "Every morning summarize onboarding blockers" });
    const automationRowTitle = automationRow.getByText("Every morning summarize onboarding blockers", { exact: true });
    await expect(page.getByTestId("automation-detail-pane")).toHaveCount(0);
    await automationRowTitle.click();
    await expect(page).toHaveURL(new RegExp(`/automations/${automation.id}$`));

    const secondAutomationRow = page.getByRole("row").filter({ hasText: "Weekly review of onboarding progress" });
    const secondAutomationRowTitle = secondAutomationRow.getByText("Weekly review of onboarding progress", { exact: true });
    await secondAutomationRowTitle.click();
    await expect(page).toHaveURL(new RegExp(`/automations/${secondAutomation.id}$`));
    await expect(page.getByPlaceholder("Automation title")).toHaveValue("Weekly review of onboarding progress");
    await expect(secondAutomationRow).toHaveAttribute("aria-current", "page");
    await automationRowTitle.click();
    await expect(page).toHaveURL(new RegExp(`/automations/${automation.id}$`));

    const detailPane = page.getByTestId("automation-detail-pane");
    const listCardHeader = page.getByTestId("automations-list-card-header");
    const detailCardHeader = page.getByTestId("automation-detail-card-header");
    const shell = page.getByTestId("automation-detail-shell");
    const panelHeader = page.getByTestId("automation-detail-panel-header");
    const configurationCard = page.getByTestId("automation-configuration-card");
    const agentControl = page.getByTestId("automation-detail-agent-control");
    const projectControl = page.getByTestId("automation-detail-project-control");
    const addTriggerButton = page.getByTestId("automation-add-trigger-button");
    const triggersList = page.getByTestId("automation-triggers-list");
    const triggerEditorBody = page.getByTestId("automation-trigger-editor-body");
    const notifySwitch = configurationCard.getByRole("switch", { name: "Follow issues created by this automation" });

    await expect(primaryRail).toBeVisible();
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeVisible();
    await expect(headerActions).toHaveCount(0);
    await expect(listCardHeader).toContainText("Automations");
    await expect(detailCardHeader.getByRole("button", { name: "Create automation" })).toBeVisible();
    await expect(automationRow).toHaveAttribute("aria-current", "page");
    await expect(automationRow.getByText("Every morning summarize onboarding blockers", { exact: true })).toBeVisible();
    await expect(shell).toBeVisible();
    await expect(panelHeader).toContainText("Active");
    await expect(panelHeader.getByRole("button", { name: "Pause automation" })).toBeVisible();
    await expect(panelHeader.getByRole("button", { name: "Close automation detail" })).toBeVisible();
    await expect(page.getByTestId("automation-overview-strip")).toBeHidden();
    await expect(page.getByText("Details")).toBeVisible();
    await expect(page.getByText("Frequency")).toBeVisible();
    await expect(page.getByText("Previous runs")).toBeVisible();
    await expect(page.getByText("Configuration")).toHaveCount(0);
    await expect(page.getByText("Run status")).toHaveCount(0);
    await expect(agentControl.getByRole("button", { name: /Automation Layout Agent/ })).toBeVisible();
    await expect(projectControl.getByRole("button", { name: /Onboarding/ })).toBeVisible();
    await expect(addTriggerButton).toBeVisible();
    await expect(triggersList).toBeVisible();
    await expect(triggerEditorBody).toBeHidden();
    await expect(notifySwitch).toHaveAttribute("aria-checked", "false");

    await addTriggerButton.click();
    const addTriggerCard = page.getByTestId("automation-add-trigger-card");
    await expect(addTriggerCard).toBeVisible();
    await expect(addTriggerCard.getByRole("button", { name: "Create trigger" })).toBeVisible();
    await addTriggerButton.click();
    await expect(addTriggerCard).toBeHidden();
    await triggersList.getByRole("button", { name: "Edit trigger" }).first().click();
    await expect(triggerEditorBody).toBeVisible();
    await expect(triggerEditorBody).not.toContainText("daily-check");
    await page.keyboard.press("Escape");

    await triggersList.getByTestId("automation-trigger-menu-button").filter({ hasText: "Webhook trigger" }).click();
    const rotateSecretResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().includes("/rotate-secret"),
    );
    await triggerEditorBody.getByRole("button", { name: "Rotate secret" }).click();
    expect((await rotateSecretResponse).ok()).toBe(true);
    await expect(page.getByText("Webhook secret rotated")).toBeVisible();
    await page.keyboard.press("Escape");
    await secondAutomationRowTitle.click();
    await expect(page).toHaveURL(new RegExp(`/automations/${secondAutomation.id}$`));
    await expect(page.getByText("Webhook secret rotated")).toHaveCount(0);
    await automationRowTitle.click();
    await expect(page).toHaveURL(new RegExp(`/automations/${automation.id}$`));

    const titleInput = page.getByPlaceholder("Automation title");
    await expect(titleInput).toHaveValue("Every morning summarize onboarding blockers");
    await page.waitForTimeout(1_000);
    await expect(titleInput).toHaveValue("Every morning summarize onboarding blockers");
    const patchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await titleInput.fill("Every morning summarize onboarding blockers and risks");
    expect((await patchPromise).ok()).toBe(true);
    await expect(panelHeader.getByText("In sync")).toBeVisible({ timeout: 10_000 });

    const notifyPatchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await notifySwitch.click();
    expect((await notifyPatchPromise).ok()).toBe(true);
    await expect(notifySwitch).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });

    const chatOutputPatchPromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await configurationCard.getByRole("combobox").click();
    await page.getByRole("option", { name: "Send to chat" }).click();
    expect((await chatOutputPatchPromise).ok()).toBe(true);
    await expect(notifySwitch).toBeHidden();
    const savedAutomationRes = await page.request.get(`/api/automations/${automation.id}`);
    expect(savedAutomationRes.ok()).toBe(true);
    const savedAutomation = await savedAutomationRes.json() as {
      title: string;
      outputMode: string;
      notifyOnIssueCreated: boolean;
    };
    expect(savedAutomation.title).toBe("Every morning summarize onboarding blockers and risks");
    expect(savedAutomation.outputMode).toBe("chat_output");
    expect(savedAutomation.notifyOnIssueCreated).toBe(false);

    await page.getByRole("button", { name: "Automation actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Run now" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog", { name: /Delete/ });
    await expect(deleteDialog).toContainText("This will permanently remove the automation and stop future runs.");
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();

    const [railBox, masterDetailBox, listBox, detailBox] = await Promise.all([
      primaryRail.boundingBox(),
      masterDetail.boundingBox(),
      listPane.boundingBox(),
      detailPane.boundingBox(),
    ]);
    const panelStyles = await Promise.all([
      workspaceCard.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          borderRadius: Number.parseFloat(style.borderTopLeftRadius),
          borderWidth: Number.parseFloat(style.borderTopWidth),
          backgroundColor: style.backgroundColor,
        };
      }),
      listPane.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          borderRadius: Number.parseFloat(style.borderTopLeftRadius),
          borderWidth: Number.parseFloat(style.borderTopWidth),
          backgroundColor: style.backgroundColor,
        };
      }),
      detailPane.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          borderRadius: Number.parseFloat(style.borderTopLeftRadius),
          borderWidth: Number.parseFloat(style.borderTopWidth),
          backgroundColor: style.backgroundColor,
        };
      }),
    ]);
    expect(railBox).not.toBeNull();
    expect(masterDetailBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    expect(listBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 2);
    expect(Math.abs(listBox!.x - masterDetailBox!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(listBox!.y - masterDetailBox!.y)).toBeLessThanOrEqual(2);
    expect(detailBox!.x - (listBox!.x + listBox!.width)).toBeGreaterThanOrEqual(8);
    expect(Math.abs(masterDetailBox!.x + masterDetailBox!.width - (detailBox!.x + detailBox!.width))).toBeLessThanOrEqual(2);
    expect(Math.abs(masterDetailBox!.y + masterDetailBox!.height - (detailBox!.y + detailBox!.height))).toBeLessThanOrEqual(2);
    expect(detailBox!.width).toBeGreaterThanOrEqual(500);
    expect(panelStyles[0].borderWidth).toBe(0);
    expect(panelStyles[0].backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(panelStyles[1].borderRadius).toBeGreaterThan(0);
    expect(panelStyles[2].borderRadius).toBeGreaterThan(0);
    expect(panelStyles[1].borderWidth).toBeGreaterThan(0);
    expect(panelStyles[2].borderWidth).toBeGreaterThan(0);

    const expandedListBox = await listPane.boundingBox();
    await detailCardHeader.getByRole("button", { name: "Collapse automation detail" }).click();
    await expect(detailPane).toHaveAttribute("data-collapsed", "true");
    await expect(shell).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/automations/${automation.id}$`));
    await expect(automationRow).toHaveAttribute("aria-current", "page");
    await expect.poll(async () => (await detailPane.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
    const [collapsedDetailBox, collapsedListBox] = await Promise.all([
      detailPane.boundingBox(),
      listPane.boundingBox(),
    ]);
    expect(collapsedDetailBox?.width).toBeLessThanOrEqual(1);
    expect(collapsedListBox!.width).toBeGreaterThan(expandedListBox!.width);
    expect(Math.abs(masterDetailBox!.x + masterDetailBox!.width - (collapsedListBox!.x + collapsedListBox!.width))).toBeLessThanOrEqual(2);
    await expect(detailCardHeader.getByRole("button", { name: "Collapse automation detail" })).toBeHidden();
    const expandDetailButton = listCardHeader.getByRole("button", { name: "Expand automation detail" });
    await expect(expandDetailButton).toBeFocused();
    const collapsedCreateButton = listCardHeader.getByRole("button", { name: "Create automation" });
    await expect(collapsedCreateButton).toBeVisible();
    await collapsedCreateButton.click();
    const composerShell = page.getByTestId("automation-composer-shell");
    await expect(composerShell.getByPlaceholder("Automation title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(composerShell).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath("automation-detail-collapsed.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 900, height: 900 });
    await expect(detailPane).not.toHaveAttribute("aria-hidden", "true");
    await expect(shell).toBeVisible();
    await expect(detailCardHeader.getByRole("button", { name: "Collapse automation detail" })).toBeHidden();

    await page.setViewportSize({ width: 1900, height: 1200 });
    await expect(detailCardHeader.getByRole("button", { name: "Collapse automation detail" })).toBeVisible();
    await detailCardHeader.getByRole("button", { name: "Collapse automation detail" }).click();
    await expect.poll(async () => (await detailPane.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
    await expect(expandDetailButton).toBeFocused();
    await expandDetailButton.press("Enter");
    await page.waitForTimeout(100);
    const expandingDetailBox = await detailPane.boundingBox();
    expect(expandingDetailBox?.width).toBeGreaterThan(1);
    expect(expandingDetailBox?.width).toBeLessThan(detailBox!.width);
    await expect(detailPane).not.toHaveAttribute("data-collapsed", "true");
    await expect(shell).toBeVisible();
    await expect(detailCardHeader.getByRole("button", { name: "Collapse automation detail" })).toBeVisible();
    await expect(detailCardHeader.getByRole("button", { name: "Collapse automation detail" })).toBeFocused();

    await page.screenshot({
      path: testInfo.outputPath("automation-three-column-detail.png"),
      fullPage: true,
    });

    await panelHeader.getByRole("button", { name: "Close automation detail" }).click();
    await expect(page).toHaveURL(/\/automations$/);
    await expect(page.getByTestId("automation-detail-pane")).toHaveCount(0);
    await expect(listPane).toBeVisible();
  });

  test("deletes an automation from the inspector and returns to the list", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { organization, automation } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}`);

    await page.getByRole("button", { name: "Automation actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog", { name: /Delete/ });
    await expect(deleteDialog).toContainText("This will permanently remove the automation and stop future runs.");
    await expect(deleteDialog).not.toContainText("archived");

    const deleteResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "DELETE" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    expect((await deleteResponsePromise).ok()).toBe(true);

    await expect(page).toHaveURL(/\/automations$/);
    await expect(page.getByText("Every morning summarize onboarding blockers")).toHaveCount(0);
    expect((await page.request.get(`/api/automations/${automation.id}`)).status()).toBe(404);
  });

  test("uses the detail as the only content pane on narrow viewports and closes without overflow", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { organization, automation } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}`);

    const listPane = page.getByTestId("automations-list-pane");
    const detailPane = page.getByTestId("automation-detail-pane");
    const activityList = page.getByTestId("automation-activity-list");
    const firstRow = page.getByTestId("automation-activity-row").first();
    const firstSummary = page.getByTestId("automation-activity-summary").first();
    const firstTimestamp = page.getByTestId("automation-activity-time").first();

    await expect(listPane).toBeHidden();
    await expect(detailPane).toBeVisible();
    await expect(activityList).toBeVisible();
    await expect(firstRow).toBeVisible();
    await expect(firstSummary).toContainText("Added schedule trigger");

    const [summaryBox, timestampBox] = await Promise.all([
      firstSummary.boundingBox(),
      firstTimestamp.boundingBox(),
    ]);
    const widths = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(summaryBox).not.toBeNull();
    expect(timestampBox).not.toBeNull();
    expect(timestampBox!.y).toBeGreaterThan(summaryBox!.y);
    expect(widths.bodyWidth).toBeLessThanOrEqual(widths.viewportWidth);

    await page.screenshot({
      path: testInfo.outputPath("automation-detail-narrow.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Close automation detail" }).click();
    await expect(page).toHaveURL(/\/automations$/);
    await expect(listPane).toBeVisible();
    await expect(page.getByTestId("automation-detail-pane")).toHaveCount(0);
  });

  test("keeps an invalid narrow direct link inside a closable inspector state", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { organization } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto("/automations/00000000-0000-4000-8000-000000000000");

    const listPane = page.getByTestId("automations-list-pane");
    const detailPane = page.getByTestId("automation-detail-pane");
    await expect(listPane).toBeHidden();
    await expect(detailPane).toBeVisible();
    await detailPane.getByRole("button", { name: "Close automation detail" }).click();

    await expect(page).toHaveURL(/\/automations$/);
    await expect(listPane).toBeVisible();
    await expect(page.getByTestId("automation-detail-pane")).toHaveCount(0);
  });
});
