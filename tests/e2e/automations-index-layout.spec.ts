import { expect, test, type Locator, type Page } from "@playwright/test";

import { E2E_BASE_URL, E2E_CODEX_STUB } from "./support/e2e-env";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
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
    await expect(page.getByRole("button", { name: /Create custom automation/ })).toBeVisible();
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
    await expect(page.getByPlaceholder("Automation name")).toBeVisible();
    await expect(page.getByText("Run output")).toBeVisible();
    await expect(page.getByText("Every day at 09:00")).toBeVisible();
    await expect(page.getByTestId("automation-composer-shell")).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("automations-index-layout.png"),
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
    await page.getByPlaceholder("Automation name").fill("Composer selector interaction");

    const assigneePill = page.getByTestId("automation-composer-assignee-pill");
    const projectPill = page.getByTestId("automation-composer-project-pill");

    await assigneePill.locator(":scope > button").click();
    await assertOpenSelectorScrolls(page);
    await page.getByRole("button", { name: /Auto Agent 00/ }).click();
    await expect(assigneePill).toContainText("Auto Agent 00");
    await expect.poll(() => directChildSvgCount(assigneePill)).toBe(0);

    if ((await page.locator('[data-slot="popover-content"][data-state="open"]').count()) === 0) {
      await projectPill.locator(":scope > button").click();
    }
    await assertOpenSelectorScrolls(page);
    await page.getByRole("button", { name: "Auto Project 00" }).click();
    await expect(projectPill).toContainText("Auto Project 00");
    await expect.poll(() => directChildSvgCount(projectPill)).toBe(0);

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

    await expect(page.getByPlaceholder("Automation name")).toHaveValue("Bug triage");
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("List all open issues labeled bug");
    await expect(page.getByText("Weekdays at 09:00")).toBeVisible();
    await expect(page.getByRole("button", { name: /Track as issue/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Send to chat/ })).toBeEnabled();
    await page.getByRole("button", { name: /Send to chat/ }).click();
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText("relevant Rudder chat conversation");
    await expect(page.getByRole("button", { name: /Create automation/ })).toBeDisabled();

    await page.screenshot({
      path: testInfo.outputPath("automations-template-composer.png"),
      fullPage: true,
    });
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

    await expect(page.getByPlaceholder("Automation name")).toHaveValue("日会");
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
    await page.getByPlaceholder("Automation name").fill("Composer mention menu interaction");

    const assigneePill = page.getByTestId("automation-composer-assignee-pill");
    await assigneePill.locator(":scope > button").click();
    await page.getByRole("button", { name: /Mention Builder/ }).click();

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Use $advisor");

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
