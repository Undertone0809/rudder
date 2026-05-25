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

test.describe("Automations index layout", () => {
  test("places the create action in the workspace header", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Index-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    const headerActions = page.getByTestId("workspace-main-header-actions");
    const createButton = headerActions.getByRole("button", { name: "Create automation" });
    const emptyState = page.getByText("No automations yet");
    const templateGrid = page.getByTestId("automation-template-grid");

    await expect(headerActions).toBeVisible();
    await expect(createButton).toBeVisible();
    await expect(emptyState).toBeVisible();
    await expect(templateGrid).toBeVisible();
    await expect(page.getByRole("button", { name: /Bug triage/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Daily standup/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Weekly progress report/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Advisor review loop/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Create custom automation/ })).toHaveCount(0);
    await expect(page.getByText("Start from scratch")).toHaveCount(0);

    const headerActionsBox = await headerActions.boundingBox();
    const createButtonBox = await createButton.boundingBox();
    const emptyStateBox = await emptyState.boundingBox();

    expect(headerActionsBox).not.toBeNull();
    expect(createButtonBox).not.toBeNull();
    expect(emptyStateBox).not.toBeNull();
    expect(createButtonBox!.x).toBeGreaterThanOrEqual(headerActionsBox!.x - 2);
    expect(createButtonBox!.y).toBeGreaterThanOrEqual(headerActionsBox!.y - 2);
    expect(createButtonBox!.y + createButtonBox!.height).toBeLessThanOrEqual(headerActionsBox!.y + headerActionsBox!.height + 2);
    expect(createButtonBox!.y + createButtonBox!.height).toBeLessThan(emptyStateBox!.y);

    await createButton.click();
    await expect(page.getByPlaceholder("Automation title")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use template" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Track as issue/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Delivery rules/ })).toBeVisible();
    await expect(page.getByText("Every day at 09:00")).toBeVisible();
    await expect(page.getByTestId("automation-composer-shell")).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("automations-index-layout.png"),
      fullPage: true,
    });
  });

  test("applies the dependency audit template from the composer header", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Automations-Advisor-Template-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/automations`);

    await page.getByTestId("workspace-main-header-actions").getByRole("button", { name: "Create automation" }).click();
    await page.getByRole("button", { name: "Use template" }).click();

    const templatePicker = page.getByTestId("automation-template-picker");
    await expect(templatePicker).toBeVisible();
    await expect(templatePicker.getByRole("button", { name: /Advisor review loop/ })).toHaveCount(0);
    await templatePicker.getByRole("button", { name: /Dependency audit/ }).click();

    await expect(page.getByPlaceholder("Automation title")).toHaveValue("Dependency audit");
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("Inspect dependency and lockfile changes");
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("known vulnerabilities");
    await expect(page.getByText("Every Tue at 11:00")).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("automations-dependency-template-composer.png"),
      fullPage: true,
    });
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

    const createButton = page.getByTestId("workspace-main-header-actions").getByRole("button", { name: "Create automation" });
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
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("List all open issues labeled bug");
    await expect(page.getByText("Weekdays at 09:00")).toBeVisible();
    await expect(page.getByRole("button", { name: /Track as issue/ })).toBeVisible();
    await page.getByRole("button", { name: /Track as issue/ }).click();
    await expect(page.getByRole("button", { name: /Send to chat/ })).toBeEnabled();
    await page.getByRole("button", { name: /Send to chat/ }).click();
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("relevant Rudder chat conversation");
    await expect(page.getByRole("button", { name: /Create automation/ })).toBeDisabled();

    await page.screenshot({
      path: testInfo.outputPath("automations-template-composer.png"),
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

    const chatRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Daily digest",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = (await chatRes.json()) as { id: string };

    const automationRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Daily digest",
        description: "Summarize the latest organization updates.",
        assigneeAgentId: agent.id,
        priority: "medium",
        outputMode: "chat_output",
        chatConversationId: chat.id,
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = (await automationRes.json()) as { id: string };

    const runRes = await page.request.post(`${E2E_BASE_URL}/api/automations/${automation.id}/run`, {
      data: { source: "manual" },
    });
    expect(runRes.ok()).toBe(true);
    const run = (await runRes.json()) as { linkedIssueId: string | null; linkedChatConversationId: string | null };
    expect(run.linkedIssueId).toBeTruthy();
    expect(run.linkedChatConversationId).toBe(chat.id);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await expect(page.getByText("From automation").first()).toBeVisible();
    await expect(page.getByText("Daily digest", { exact: true }).first()).toBeVisible();
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
    await page.getByRole("button", { name: /日会/ }).click();

    await expect(page.getByPlaceholder("Automation title")).toHaveValue("日会");
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("上一个工作日以来更新的进行中任务");
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("发送到相关 Rudder chat");
    await expect(page.getByRole("button", { name: /Send to chat/ })).toBeEnabled();

    await page.screenshot({
      path: testInfo.outputPath("automations-zh-narrow-composer.png"),
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

    await page.getByTestId("workspace-main-header-actions").getByRole("button", { name: "Create automation" }).click();
    await page.getByPlaceholder("Automation title").fill("Composer mention menu interaction");

    const assigneePill = page.getByRole("button", { name: /^Assignee$/ });
    await assigneePill.click();
    await page.getByRole("button", { name: /Mention Builder/ }).click();
    await page.keyboard.press("Escape");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.click();
    await page.keyboard.type("Use $advisor");

    const mentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
    await expect(mentionMenu).toHaveAttribute("role", "listbox");
    await expect(mentionMenu).toHaveClass(/scrollbar-auto-hide/);

    const menuBox = await mentionMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.width).toBeLessThanOrEqual(540);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1440 - 12 + 1);

    await composer.focus();
    await page.keyboard.press("ArrowDown");

    const selectedOption = mentionMenu.locator('[aria-selected="true"]');
    await expect(selectedOption).toContainText("advisor-skill-01");

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
