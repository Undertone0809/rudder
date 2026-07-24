import { expect, test, type Locator, type Page } from "@playwright/test";

import { E2E_BASE_URL, E2E_CODEX_STUB } from "./support/e2e-env";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function createAutomationFixture(page: Page) {
  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: {
      name: `Automations-Delete-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Automation Delete Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = (await agentRes.json()) as { id: string };

  const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
    data: {
      title: "Remove stale automation",
      description: "Used to verify destructive deletion from the list.",
      assigneeAgentId: agent.id,
      priority: "medium",
    },
  });
  expect(automationRes.ok()).toBe(true);
  const automation = (await automationRes.json()) as { id: string; title: string };

  return { organization, automation };
}

async function createCiWebhookAutomationFixture(page: Page) {
  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: {
      name: `Automations-CI-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
    data: {
      name: "CI Trigger Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = (await agentRes.json()) as { id: string };

  const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
    data: {
      title: "CI regression gate",
      description: "Review CI failures and open tracked work when a regression needs action.",
      assigneeAgentId: agent.id,
      priority: "medium",
      outputMode: "track_issue",
    },
  });
  expect(automationRes.ok()).toBe(true);
  const automation = (await automationRes.json()) as { id: string };

  const triggerRes = await page.request.post(`${E2E_BASE_URL}/api/automations/${automation.id}/triggers`, {
    data: {
      kind: "webhook",
      label: "ci",
      signingMode: "bearer",
    },
  });
  expect(triggerRes.ok()).toBe(true);
  const trigger = (await triggerRes.json()) as {
    trigger: { publicId: string };
    secretMaterial: { webhookSecret: string };
  };

  const fireRes = await page.request.post(`${E2E_BASE_URL}/api/automation-triggers/public/${trigger.trigger.publicId}/fire`, {
    headers: {
      authorization: `Bearer ${trigger.secretMaterial.webhookSecret}`,
    },
    data: {
      action: "completed",
      repository: { full_name: "rudderhq/rudder" },
      workflow_run: {
        name: "E2E",
        head_branch: "main",
        head_sha: "1234567890abcdef1234567890abcdef12345678",
      },
    },
  });
  expect(fireRes.ok()).toBe(true);

  return { organization, automation };
}

test.describe("Automations index layout", () => {
  test("filters the list by all, active, and paused status", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Automations-Filters-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };
    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Automation Filter Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = (await agentRes.json()) as { id: string };

    const activeRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Active daily review",
        description: "Active filter fixture.",
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(activeRes.ok()).toBe(true);

    const pausedRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Paused weekly review",
        description: "Paused filter fixture.",
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(pausedRes.ok()).toBe(true);
    const pausedAutomation = (await pausedRes.json()) as { id: string };
    const pauseRes = await page.request.patch(`${E2E_BASE_URL}/api/automations/${pausedAutomation.id}`, {
      data: { status: "paused" },
    });
    expect(pauseRes.ok(), await pauseRes.text()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    const statusTabs = page.getByRole("tablist", { name: "Automation status" });
    const tableSurface = page.getByTestId("automations-table-surface");
    await expect(statusTabs.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    await expect(tableSurface.getByText("Active daily review", { exact: true })).toBeVisible();
    await expect(tableSurface.getByText("Paused weekly review", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-automation-status-tabs.png", fullPage: true });

    await expect(tableSurface).toBeVisible();
    expect(await tableSurface.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);

    await tableSurface.getByText("Active daily review", { exact: true }).click();
    const selectedRow = page.locator('tr[data-selected="true"]');
    const firstSelectedCell = selectedRow.locator("td").first();
    expect(await firstSelectedCell.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);

    const detailHeader = page.getByTestId("automation-detail-panel-header");
    await expect(detailHeader).toBeVisible();
    expect(await detailHeader.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);

    await statusTabs.getByRole("tab", { name: "All" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(statusTabs.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "true");
    await expect(tableSurface.getByText("Active daily review", { exact: true })).toBeVisible();
    await expect(tableSurface.getByText("Paused weekly review", { exact: true })).toHaveCount(0);

    await statusTabs.getByRole("tab", { name: "Paused" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/automations$`));
    await expect(page.getByTestId("automation-detail-pane")).toHaveCount(0);
    await expect(tableSurface.getByText("Active daily review", { exact: true })).toHaveCount(0);
    await expect(tableSurface.getByText("Paused weekly review", { exact: true })).toBeVisible();

    await tableSurface.getByText("Paused weekly review", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/automations/${pausedAutomation.id}$`));
    await expect(page.getByTestId("automation-detail-pane")).toBeVisible();
    await tableSurface.getByRole("switch", { name: "Enable Paused weekly review" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/automations$`));
    await expect(page.getByTestId("automation-detail-pane")).toHaveCount(0);
    await expect(page.getByText("No paused automations", { exact: true })).toBeVisible();
    await expect(page.getByTestId("automation-template-grid")).toHaveCount(0);
  });

  test("uses the outer list card and places the create action in its header", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Index-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };
    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Automation Output Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    const workspaceCard = page.getByTestId("workspace-main-card");
    const listPane = page.getByTestId("automations-list-pane");
    const listCardHeader = page.getByTestId("automations-list-card-header");
    const pageContent = page.getByTestId("automations-page-content");
    const createButton = listCardHeader.getByRole("button", { name: "Create automation" });
    const emptyState = page.getByText("No automations yet");
    const templateGrid = page.getByTestId("automation-template-grid");

    await expect(workspaceCard).toHaveClass(/workspace-main-card--frameless/);
    await expect(listCardHeader).toContainText("Automations");
    await expect(pageContent).toBeVisible();
    await expect(createButton).toBeVisible();
    await expect(emptyState).toBeVisible();
    await expect(templateGrid).toBeVisible();
    await expect(page.getByRole("button", { name: /Daily review/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Bug triage/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Daily standup review/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Weekly progress report/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Dependency audit/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Advisor review loop/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Create custom automation/ })).toHaveCount(0);
    await expect(page.getByText("Start from scratch")).toHaveCount(0);

    const listCardHeaderBox = await listCardHeader.boundingBox();
    const workspaceCardBox = await workspaceCard.boundingBox();
    const listPaneBox = await listPane.boundingBox();
    const pageContentBox = await pageContent.boundingBox();
    const createButtonBox = await createButton.boundingBox();
    const emptyStateBox = await emptyState.boundingBox();

    expect(listCardHeaderBox).not.toBeNull();
    expect(workspaceCardBox).not.toBeNull();
    expect(listPaneBox).not.toBeNull();
    expect(pageContentBox).not.toBeNull();
    expect(createButtonBox).not.toBeNull();
    expect(emptyStateBox).not.toBeNull();
    expect(Math.abs(pageContentBox!.width - workspaceCardBox!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(listPaneBox!.x - workspaceCardBox!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(listPaneBox!.width - workspaceCardBox!.width)).toBeLessThanOrEqual(2);
    const cardStyles = await Promise.all([
      workspaceCard.evaluate((element) => Number.parseFloat(window.getComputedStyle(element).borderTopWidth)),
      listPane.evaluate((element) => Number.parseFloat(window.getComputedStyle(element).borderTopWidth)),
    ]);
    expect(cardStyles[0]).toBe(0);
    expect(cardStyles[1]).toBeGreaterThan(0);
    expect(createButtonBox!.x).toBeGreaterThanOrEqual(listCardHeaderBox!.x - 2);
    expect(createButtonBox!.y).toBeGreaterThanOrEqual(listCardHeaderBox!.y - 2);
    expect(createButtonBox!.y + createButtonBox!.height).toBeLessThanOrEqual(listCardHeaderBox!.y + listCardHeaderBox!.height + 2);
    expect(createButtonBox!.y + createButtonBox!.height).toBeLessThan(emptyStateBox!.y);

    await page.screenshot({
      path: testInfo.outputPath("automations-index-outer-card.png"),
      fullPage: true,
    });

    await createButton.click();
    await expect(page.getByPlaceholder("Automation title")).toBeVisible();
    const outputMethod = page.getByTestId("automation-create-output-mode");
    await expect(outputMethod).toContainText("Send to chat");
    await expect(page.getByTestId("automation-create-chat-destination")).toContainText("New chat per run");
    await outputMethod.click();
    await page.getByRole("button", { name: /Track as issue/ }).click();
    await expect(outputMethod).toContainText("Track as issue");
    await expect(page.getByTestId("automation-create-chat-destination")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Delivery rules/ })).toBeVisible();
    await expect(page.getByText("Every day at 09:00")).toBeVisible();
    await expect(page.getByTestId("automation-composer-shell")).toBeVisible();
    await page.getByPlaceholder("Automation title").fill("Persist tracked output");
    await page.getByRole("button", { name: /^Assignee$/ }).click();
    await page.getByRole("button", { name: /Automation Output Agent/ }).click();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: testInfo.outputPath("automation-output-method-track-issue.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page.getByText("Persist tracked output", { exact: true })).toBeVisible();
    const automationsRes = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`);
    expect(automationsRes.ok()).toBe(true);
    const createdAutomation = ((await automationsRes.json()) as Array<{ title: string; outputMode: string }>)
      .find((automation) => automation.title === "Persist tracked output");
    expect(createdAutomation?.outputMode).toBe("track_issue");
  });

  test("applies and creates the Daily review template from the composer header", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Daily-Review-Template-${Date.now()}`,
        issuePrefix: `ADR${Date.now().toString(36).slice(-6)}`.toUpperCase(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };
    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Daily Review Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = (await agentRes.json()) as { id: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    await page.getByTestId("automations-list-card-header").getByRole("button", { name: "Create automation" }).click();
    await page.getByPlaceholder("Automation title").fill("Temporary custom draft");
    await page.getByRole("button", { name: /^Assignee$/ }).click();
    await page.getByRole("button", { name: /Daily Review Agent/ }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Use template" }).click();

    const templatePicker = page.getByTestId("automation-template-picker");
    await expect(templatePicker).toBeVisible();
    await expect(templatePicker.getByRole("button", { name: /Advisor review loop/ })).toHaveCount(0);
    await expect(templatePicker.getByRole("button", { name: /Dependency audit/ })).toHaveCount(0);
    await templatePicker.getByRole("button", { name: /Daily review/ }).click();

    await expect(page.getByPlaceholder("Automation title")).toHaveValue("Daily review");
    const instructionsEditor = page
      .getByTestId("automation-instructions-composer")
      .locator('[data-editor-engine="codemirror-live-preview"]');
    await expect(instructionsEditor).toContainText("Review what I worked on today");
    await expect(instructionsEditor).toContainText("highest-priority next action for tomorrow");
    await expect(page.getByText("Every day at 18:00")).toBeVisible();
    await expect(page.getByTestId("automation-create-output-mode")).toContainText("Send to chat");
    await expect(page.getByTestId("automation-create-chat-destination")).toContainText("New chat per run");
    await expect(page.getByRole("button", { name: /Daily Review Agent/ }).first()).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("automations-daily-review-template-composer.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page.getByTestId("automation-composer-shell")).toHaveCount(0);
    await expect(page.getByText("Daily review", { exact: true }).first()).toBeVisible();

    const automationsRes = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`);
    expect(automationsRes.ok()).toBe(true);
    const createdAutomation = ((await automationsRes.json()) as Array<{
      id: string;
      title: string;
      assigneeAgentId: string | null;
      outputMode: string;
    }>).find((automation) => automation.title === "Daily review");
    expect(createdAutomation).toMatchObject({
      assigneeAgentId: agent.id,
      outputMode: "chat_output",
    });

    let detail: {
      description: string;
      triggers: Array<{ kind: string; cronExpression: string | null }>;
    } | null = null;
    await expect.poll(async () => {
      const detailRes = await page.request.get(`${E2E_BASE_URL}/api/automations/${createdAutomation!.id}`);
      expect(detailRes.ok()).toBe(true);
      detail = await detailRes.json() as typeof detail;
      return detail?.triggers.find((trigger) => trigger.kind === "schedule")?.cronExpression ?? null;
    }).toBe("0 18 * * *");
    expect(detail?.description).toContain("Review what I worked on today");
  });

  test("keeps composer selectors scrollable above the dialog footer", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Composer-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const agentResponses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
          data: {
            name: `Auto Agent ${String(index).padStart(2, "0")}`,
            role: "engineer",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: {
              model: "gpt-5.4",
            },
          },
        }),
      ),
    );
    for (const response of agentResponses) expect(response.ok()).toBe(true);
    const projectResponses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
          data: {
            name: `Auto Project ${String(index).padStart(2, "0")}`,
            description: "Project used to verify automation composer selectors.",
          },
        }),
      ),
    );
    for (const response of projectResponses) expect(response.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    const createButton = page.getByTestId("automations-list-card-header").getByRole("button", { name: "Create automation" });
    await createButton.click();
    await page.getByPlaceholder("Automation title").fill("Composer selector interaction");

    const assigneePill = page.getByRole("button", { name: /^Assignee$/ });
    const projectPill = page.getByRole("button", { name: /^No project$/ }).first();

    await assigneePill.click();
    await assertOpenSelectorScrolls(page);
    await page.getByRole("button", { name: /Auto Agent 00/ }).click();
    const selectedAssigneePill = page.getByRole("button", { name: /Auto Agent 00/ }).first();
    await expect(selectedAssigneePill).toBeVisible();
    await expect.poll(() => directChildSvgCount(selectedAssigneePill)).toBe(0);

    if ((await page.locator('[data-slot="popover-content"][data-state="open"]').count()) === 0) {
      await projectPill.click();
    }
    if ((await page.locator('[data-slot="popover-content"][data-state="open"]').count()) === 0) {
      await projectPill.click({ force: true });
    }
    await assertOpenSelectorScrolls(page);
    await page.getByRole("button", { name: "Auto Project 00" }).click();
    const selectedProjectPill = page.getByRole("button", { name: "Auto Project 00" }).first();
    await expect(selectedProjectPill).toBeVisible();
    await expect.poll(() => directChildSvgCount(selectedProjectPill)).toBe(0);

    await page.screenshot({
      path: testInfo.outputPath("automations-composer-selectors.png"),
      fullPage: true,
    });
  });

  test("prefills the automation composer from a use-case template", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Template-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    await page.getByRole("button", { name: /Bug triage/ }).click();

    await expect(page.getByPlaceholder("Automation title")).toHaveValue("Bug triage");
    const instructionsEditor = page
      .getByTestId("automation-instructions-composer")
      .locator('[data-editor-engine="codemirror-live-preview"]');
    await expect(instructionsEditor).toContainText("List all open issues labeled bug");
    await expect(page.getByText("Weekdays at 09:00")).toBeVisible();
    await expect(page.getByRole("button", { name: /Track as issue/ })).toBeVisible();
    await page.getByRole("button", { name: /Track as issue/ }).click();
    await expect(page.getByRole("button", { name: /Send to chat/ })).toBeEnabled();
    await page.getByRole("button", { name: /Send to chat/ }).click();
    await expect(instructionsEditor).toContainText("each run's final result to a new Rudder chat");
    await expect(page.getByRole("button", { name: /^Create$/ })).toBeDisabled();

    await page.screenshot({
      path: testInfo.outputPath("automations-template-composer.png"),
      fullPage: true,
    });
  });

  test("summarizes CI webhook trigger runs in the list", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { organization } = await createCiWebhookAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    const row = page.getByRole("row").filter({ hasText: "CI regression gate" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Opened issue");
    await expect(row).toContainText("CI webhook");
    await expect(row).toContainText("rudderhq/rudder");
    await expect(row).toContainText("E2E");
    await expect(row).toContainText("main");
    await expect(row).toContainText("1234567");
    await expect(row).toContainText(new RegExp(`Issue ${organization.issuePrefix}-\\d+`));

    await page.screenshot({
      path: testInfo.outputPath("automations-ci-webhook-run-summary.png"),
      fullPage: true,
    });
  });

  test("posts automation run output into Messenger chat", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Digest Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = (await agentRes.json()) as { id: string };

    const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Daily digest",
        description: "Summarize the latest organization updates.",
        assigneeAgentId: agent.id,
        priority: "medium",
        outputMode: "chat_output",
        chatConversationId: null,
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = (await automationRes.json()) as { id: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations/${automation.id}`);
    await page.getByRole("button", { name: "Run now" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[0-9a-f-]+/);
    const linkedChatConversationId = page.url().match(/\/messenger\/chat\/([^/?#]+)/)?.[1] ?? null;
    expect(linkedChatConversationId).toBeTruthy();

    let run: {
      id: string;
      status: string;
      linkedIssueId: string | null;
      linkedChatConversationId: string | null;
    } | null = null;
    await expect.poll(async () => {
      const runsRes = await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}/runs?limit=10`);
      expect(runsRes.ok()).toBe(true);
      const runs = (await runsRes.json()) as Array<{
        id: string;
        status: string;
        linkedIssueId: string | null;
        linkedChatConversationId: string | null;
      }>;
      run = runs.find((item) => item.linkedChatConversationId === linkedChatConversationId) ?? null;
      return run ? "ready" : "pending";
    }, { timeout: 20_000 }).toBe("ready");
    expect(run!.status).toMatch(/running|completed/);
    expect(run!.linkedIssueId).toBeNull();
    expect(run!.linkedChatConversationId).toBe(linkedChatConversationId);

    await expect(page.getByText("Summarize the latest organization updates.").first()).toBeVisible();
    await expect(page.getByText("Automation: Daily digest").first()).toBeVisible();
    await expect(page.getByText("Streaming reply for chat.").first()).toBeVisible({ timeout: 20_000 });

    await expect.poll(async () => {
      const runsRes = await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}/runs?limit=10`);
      expect(runsRes.ok()).toBe(true);
      const runs = (await runsRes.json()) as Array<{ id: string; status: string }>;
      return runs.find((item) => item.id === run!.id)?.status ?? null;
    }, { timeout: 20_000 }).toBe("completed");

    const secondRunRes = await page.request.post(`${E2E_BASE_URL}/api/automations/${automation.id}/run`, {
      data: { source: "manual" },
    });
    expect(secondRunRes.ok()).toBe(true);
    const secondRun = (await secondRunRes.json()) as {
      status: string;
      linkedIssueId: string | null;
      linkedChatConversationId: string | null;
    };
    expect(secondRun.status).toBe("running");
    expect(secondRun.linkedIssueId).toBeNull();
    expect(secondRun.linkedChatConversationId).toBeTruthy();
    expect(secondRun.linkedChatConversationId).not.toBe(run.linkedChatConversationId);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/messenger/chat/${secondRun.linkedChatConversationId}`);

    await expect(page.getByText("Automation: Daily digest").first()).toBeVisible();
    await expect(page.getByText("Streaming reply for chat.").first()).toBeVisible({ timeout: 20_000 });
  });

  test("deletes an automation from the row menu without exposing archive lifecycle actions", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { organization, automation } = await createAutomationFixture(page);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    await expect(page.getByText(automation.title)).toBeVisible();
    await page.getByRole("button", { name: `More actions for ${automation.title}` }).click();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Archive" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Restore" })).toHaveCount(0);
    await expect(page.getByText("Archived")).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Delete" }).click();

    const deleteDialog = page.getByRole("dialog", { name: /Delete/ });
    await expect(deleteDialog).toContainText("This will permanently remove the automation and stop future runs.");
    await expect(deleteDialog).not.toContainText("archived");

    const deleteResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "DELETE" &&
      response.url().includes(`/api/automations/${automation.id}`),
    );
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.ok()).toBe(true);

    await expect(page.getByText(automation.title)).toHaveCount(0);
    await expect(page.getByText("Archive")).toHaveCount(0);
    await expect(page.getByText("Restore")).toHaveCount(0);
    await expect(page.getByText("Archived")).toHaveCount(0);
  });

  test("renders localized use cases and a narrow create layout", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-ZH-${Date.now()}`,
        issuePrefix: `AZH${Date.now().toString(36).slice(-6)}`.toUpperCase(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    await page.route("**/api/health", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, uiLocale: "zh-CN" } });
    });

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    await expect(page.getByRole("button", { name: /日会/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Bug 分诊/ })).toBeVisible();
    await page.getByRole("button", { name: "创建自动化", exact: true }).click();
    await page.getByRole("button", { name: "使用模板" }).click();

    const templatePicker = page.getByTestId("automation-template-picker");
    await expect(templatePicker).toBeVisible();
    await expect(templatePicker.getByText("模板", { exact: true })).toBeVisible();
    const templatePickerBox = await templatePicker.boundingBox();
    expect(templatePickerBox).not.toBeNull();
    expect(templatePickerBox!.x).toBeGreaterThanOrEqual(0);
    expect(templatePickerBox!.x + templatePickerBox!.width).toBeLessThanOrEqual(390);
    expect(templatePickerBox!.y).toBeGreaterThanOrEqual(0);
    expect(templatePickerBox!.y + templatePickerBox!.height).toBeLessThanOrEqual(844);

    await page.screenshot({
      path: testInfo.outputPath("automations-zh-narrow-template-picker.png"),
      fullPage: false,
    });

    await templatePicker.getByRole("button", { name: /每日回顾/ }).click();

    await expect(page.getByPlaceholder("Automation title")).toHaveValue("每日回顾");
    const instructionsEditor = page
      .getByTestId("automation-instructions-composer")
      .locator('[data-editor-engine="codemirror-live-preview"]');
    await expect(instructionsEditor).toContainText("回顾我今天完成的工作");
    await expect(instructionsEditor).toContainText("推荐明天优先级最高的行动");
    await expect(page.getByText("每天 18:00")).toBeVisible();
    await expect(page.getByTestId("automation-create-output-mode")).toContainText("发送到聊天");

    await page.screenshot({
      path: testInfo.outputPath("automations-zh-narrow-daily-review.png"),
      fullPage: true,
    });
  });

  test("keeps composer mention menus bounded and keyboard selectable", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Mentions-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Mention Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = (await agentRes.json()) as { id: string };

    const skillSlugs = Array.from({ length: 24 }, (_, index) => `advisor-skill-${String(index).padStart(2, "0")}`);
    for (const slug of skillSlugs) {
      const skillRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/skills`, {
        data: {
          name: `Advisor Skill ${slug.slice(-2)}`,
          slug,
          markdown: `---\nname: ${slug}\ndescription: A long advisor skill description used to verify menu clipping and keyboard scrolling.\n---\n\n# ${slug}\n`,
        },
      });
      expect(skillRes.ok()).toBe(true);
    }

    const syncRes = await page.request.post(`${E2E_BASE_URL}/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
      data: {
        desiredSkills: skillSlugs,
      },
    });
    expect(syncRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    await page.getByTestId("automations-list-card-header").getByRole("button", { name: "Create automation" }).click();
    await page.getByPlaceholder("Automation title").fill("Composer mention menu interaction");

    const assigneePill = page.getByRole("button", { name: /^Assignee$/ });
    await assigneePill.click();
    await page.getByRole("button", { name: /Mention Builder/ }).click();
    await page.keyboard.press("Escape");

    const composer = page
      .getByTestId("automation-instructions-composer")
      .locator('[data-editor-engine="codemirror-live-preview"] .cm-content');
    await composer.click();
    await page.keyboard.type("Use $advisor");

    const mentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
    await expect(mentionMenu).toHaveAttribute("role", "menu");
    await expect(mentionMenu).toHaveClass(/scrollbar-auto-hide/);

    const menuBox = await mentionMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.width).toBeLessThanOrEqual(540);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1440 - 12 + 1);

    await composer.focus();
    await page.keyboard.press("ArrowDown");

    const selectedOption = mentionMenu.locator('[data-mention-option-index="1"]');
    await expect(selectedOption).toContainText("advisor-skill-01");
    await expect(selectedOption).toHaveClass(/surface-active/);

    await page.keyboard.press("Enter");
    await expect(composer.locator("[data-skill-token='true']")).toContainText("advisor-skill-01");

    await page.screenshot({
      path: testInfo.outputPath("automations-composer-mention-menu.png"),
      fullPage: true,
    });
  });
});

async function assertOpenSelectorScrolls(page: Page) {
  const content = page.locator('[data-slot="popover-content"][data-state="open"]').last();
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute("data-side", /^(top|bottom)$/);
  await expect(content).toHaveCSS("z-index", "70");

  const scroller = content.locator(".overflow-y-auto");
  const box = await scroller.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scroller.evaluate((element) => Math.round(element.scrollTop))).toBeGreaterThan(0);
}

async function directChildSvgCount(locator: Locator) {
  return locator.evaluate((element) => Array.from(element.children).filter((child) => child.tagName.toLowerCase() === "svg").length);
}
