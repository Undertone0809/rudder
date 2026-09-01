import { expect, test, type Page } from "@playwright/test";

const GETTING_STARTED_TITLES = [
  "👋 Welcome to Rudder — quick reference",
  "1. Run one real task",
  "2. Review the result and close the loop",
];

const LEGACY_GETTING_STARTED_TITLES = [
  "👋 Welcome to Rudder — work with agents like a team",
  "1. Understand how Rudder work happens",
  "2. Ask your agent one quick question",
  "3. Create and run your first agent issue",
  "4. Review the result and close the loop",
  "5. Create a project and add shared resources",
  "6. Add shared context your agent should remember",
  "7. Bring one real task into Rudder",
  "8. Link this work to a goal",
  "9. Capture one reusable workflow",
  "10. Add a second agent with a different role",
  "11. Set up a recurring loop or automation",
];

function onboardingHeading(page: Page, text: string) {
  return page.locator("h3", { hasText: text });
}

async function expectOnboardingStep(page: Page, text: string) {
  await expect(onboardingHeading(page, text)).toBeVisible({ timeout: 30_000 });
}

async function expectSelectedCodexModel(page: Page) {
  const modelButton = page.getByRole("button", { name: /gpt-5(?:\.\d+)?(?:-[\w.-]+)?/i });
  await expect(modelButton).toBeVisible();
  const model = (await modelButton.textContent())?.trim();
  expect(model).toMatch(/^gpt-5(?:\.\d+)?(?:-[\w.-]+)?$/i);

  await modelButton.click();
  const modelPopover = page.locator("[data-radix-popper-content-wrapper]").last();
  const modelOptions = modelPopover.getByRole("button");
  await expect(modelOptions).toHaveCount(8);
  expect(await modelOptions.allTextContents()).toEqual([
    "Default",
    "GPT-5.6-sol",
    "GPT-5.6-terra",
    "GPT-5.6-luna",
    "GPT-5.5",
    "GPT-5.4",
    "GPT-5.4 Mini",
    "GPT-5.2",
  ]);
  await modelPopover.getByRole("button", { name: model!, exact: true }).click();

  return model!.toLowerCase();
}

async function expectEvenOnboardingStepTabs(page: Page) {
  const tabs = page.getByTestId("onboarding-step-tabs");
  const organizationTab = page.getByTestId("onboarding-step-tab-1");
  const agentTab = page.getByTestId("onboarding-step-tab-2");
  const [tabsBox, organizationBox, agentBox] = await Promise.all([
    tabs.boundingBox(),
    organizationTab.boundingBox(),
    agentTab.boundingBox(),
  ]);

  expect(tabsBox).not.toBeNull();
  expect(organizationBox).not.toBeNull();
  expect(agentBox).not.toBeNull();
  expect(Math.abs(organizationBox!.width - agentBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(organizationBox!.width + agentBox!.width - tabsBox!.width)).toBeLessThanOrEqual(1);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownHref(markdown: string, label: string) {
  const escapedLabel = escapeRegExp(label);
  const match = markdown.match(new RegExp(`\\[${escapedLabel}\\]\\(([^)]+)\\)`));
  expect(match?.[1]).toBeTruthy();
  return match![1]!;
}

function createRequestGate() {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { started, signalStarted, blocked, release };
}

test.describe("Onboarding wizard", () => {
  test("keeps internal identity and mission out of organization setup", async ({ page }) => {
    const organizationName = `E2E-Name-Only-${Date.now()}`;

    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");
    await expect(page.getByTestId("onboarding-close")).toHaveCount(0);
    await expect(page.getByText("Create your first organization")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Issue key" })).toHaveCount(0);
    await expect(page.getByText("Mission / goal (optional)")).toHaveCount(0);

    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    const createOrganizationRequest = page.waitForRequest((request) =>
      request.method() === "POST" && request.url().endsWith("/api/orgs"),
    );
    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();

    expect((await createOrganizationRequest).postDataJSON()).toEqual({
      name: organizationName,
    });
    await expect((await createOrganizationResponse).json()).resolves.toMatchObject({
      name: organizationName,
      issuePrefix: "E2E",
    });
    await expectOnboardingStep(page, "Create your first agent");
    await expect(page.getByTestId("onboarding-close")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectOnboardingStep(page, "Create your first agent");

    const createdOrganization = await (await createOrganizationResponse).json() as {
      id: string;
    };
    const cleanupResponse = await page.request.delete(
      `/api/orgs/${createdOrganization.id}`,
    );
    expect(cleanupResponse.ok()).toBe(true);
  });

  test("persists Codex thinking effort selected during first-agent setup", async ({ page }) => {
    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");
    await page.locator('input[placeholder="Acme Corp"]').fill(`E2E-Reasoning-${Date.now()}`);
    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    const organization = await (await createOrganizationResponse).json() as { id: string };
    await expectOnboardingStep(page, "Create your first agent");
    await page.getByRole("button", { name: "Codex" }).click();
    await expectSelectedCodexModel(page);
    const onboardingDialog = page.getByTestId("onboarding-dialog");

    const modelButton = onboardingDialog.getByRole("button", { name: "GPT-5.6-sol", exact: true });
    await onboardingDialog.getByRole("button", { name: "Auto", exact: true }).click();
    await page.locator("[data-radix-popper-content-wrapper]").last()
      .getByText("Ultra", { exact: true }).click();
    await expect(onboardingDialog.getByRole("button", { name: "Ultra", exact: true })).toBeVisible();
    await modelButton.click();
    const modelPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await modelPopover.getByRole("button", { name: "Default", exact: true }).click();
    await expect(onboardingDialog.getByRole("button", { name: "Default", exact: true })).toBeVisible();
    await expect(onboardingDialog.getByRole("button", { name: "Ultra", exact: true })).toBeVisible();
    await onboardingDialog.getByRole("button", { name: "Ultra", exact: true }).click();
    const defaultEffortPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(defaultEffortPopover.getByText("Low", { exact: true })).toBeVisible();
    await expect(defaultEffortPopover.getByText("Ultra", { exact: true })).toBeVisible();
    await defaultEffortPopover.getByText("Ultra", { exact: true }).click();

    await onboardingDialog.getByRole("button", { name: "Default", exact: true }).click();
    await page.locator("[data-radix-popper-content-wrapper]").last()
      .getByRole("button", { name: "GPT-5.5", exact: true }).click();
    await expect(onboardingDialog.getByRole("button", { name: "Auto", exact: true })).toBeVisible();
    await onboardingDialog.getByRole("button", { name: "Auto", exact: true }).click();
    const legacyEffortPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(legacyEffortPopover.getByText("Low", { exact: true })).toBeVisible();
    await expect(legacyEffortPopover.getByText("Ultra", { exact: true })).toHaveCount(0);
    await legacyEffortPopover.getByText("Auto", { exact: true }).click();

    await onboardingDialog.getByRole("button", { name: "GPT-5.5", exact: true }).click();
    await page.locator("[data-radix-popper-content-wrapper]").last()
      .getByRole("button", { name: "GPT-5.6-sol", exact: true }).click();
    await onboardingDialog.getByRole("button", { name: "Auto", exact: true }).click();
    await page.locator("[data-radix-popper-content-wrapper]").last()
      .getByText("Ultra", { exact: true }).click();

    const createAgentResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/orgs\/[^/]+\/agents$/.test(response.url()),
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const response = await createAgentResponse;
    expect(response.ok()).toBe(true);
    const agent = await response.json() as {
      agentRuntimeType: string;
      agentRuntimeConfig: Record<string, unknown>;
    };
    expect(agent.agentRuntimeType).toBe("codex_local");
    expect(agent.agentRuntimeConfig.model).toBe("gpt-5.6-sol");
    expect(agent.agentRuntimeConfig.modelReasoningEffort).toBe("ultra");
    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 30_000 });

    const cleanupResponse = await page.request.delete(`/api/orgs/${organization.id}`);
    expect(cleanupResponse.ok()).toBe(true);
  });

  test("shows runtime-specific reasoning controls during first-agent setup", async ({ page }) => {
    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");
    await page.locator('input[placeholder="Acme Corp"]').fill(`E2E-Runtime-Effort-${Date.now()}`);
    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    const organization = await (await createOrganizationResponse).json() as { id: string };
    await page.route(`**/api/orgs/${organization.id}/adapters/opencode_local/models`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "opencode/deepseek-v4-flash-free",
            label: "DeepSeek V4 Flash Free",
            variants: ["low", "medium", "high", "max"],
          },
        ]),
      });
    });
    await page.route(`**/api/orgs/${organization.id}/adapters/pi_local/models`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "kimi-coding/kimi-for-coding",
            label: "Kimi for Coding",
            variants: ["off", "minimal", "low", "medium", "high", "xhigh"],
            capabilities: { reasoning: true },
          },
        ]),
      });
    });
    await page.route(`**/api/orgs/${organization.id}/adapters/cursor/models`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "auto", label: "auto" }]),
      });
    });

    const onboardingDialog = page.getByTestId("onboarding-dialog");
    await expectOnboardingStep(page, "Create your first agent");
    await expect(onboardingDialog.getByText("Thinking effort", { exact: true })).toHaveCount(0);

    let moreRuntimesOpened = false;
    const selectRuntime = async (runtimeLabel: string) => {
      if (runtimeLabel !== "Claude Code" && runtimeLabel !== "Codex") {
        const moreRuntimes = page.getByRole("button", { name: "More Agent Runtime Types" });
        if (!moreRuntimesOpened) {
          await moreRuntimes.click();
          moreRuntimesOpened = true;
        }
      }
      await page.getByRole("button", { name: runtimeLabel }).click();
    };

    const expectEffortOptions = async (options: string[]) => {
      const effortButton = onboardingDialog.getByRole("button", { name: /^(Auto|Off|Low|Ultra|Plan)$/ }).last();
      await effortButton.click();
      const popover = page.locator("[data-radix-popper-content-wrapper]").last();
      for (const option of options) {
        await expect(popover.getByText(option, { exact: true })).toBeVisible();
      }
      await page.keyboard.press("Escape");
    };

    const selectModel = async (modelLabel: string) => {
      const currentModelButton = onboardingDialog.getByRole("button", { name: /^(Default|Claude Opus 4\.6)$/ }).last();
      await currentModelButton.click();
      const modelPopover = page.locator("[data-radix-popper-content-wrapper]").last();
      await modelPopover.getByRole("button", { name: modelLabel, exact: true }).click();
    };

    await selectModel("Claude Opus 4.6");
    await expect(onboardingDialog.getByText("Thinking effort", { exact: true })).toBeVisible();
    await expectEffortOptions(["Low", "Medium", "High", "Extra High", "Max"]);
    await selectRuntime("Codex");
    await expectEffortOptions(["Low", "Medium", "High", "Extra High", "Max", "Ultra"]);
    await selectRuntime("OpenCode");
    await expectEffortOptions(["Low", "Medium", "High", "Max"]);
    await selectRuntime("Pi");
    await expectEffortOptions(["Off", "Minimal", "Low", "Medium", "High", "Extra High"]);
    await selectRuntime("Cursor");
    await expect(onboardingDialog.getByText("Thinking effort", { exact: true })).toHaveCount(0);
    await expect(onboardingDialog.getByText("Execution mode", { exact: true })).toBeVisible();
    await selectRuntime("Gemini CLI");
    await expect(onboardingDialog.getByText("Thinking effort", { exact: true })).toHaveCount(0);
    await expect(onboardingDialog.getByText("Execution mode", { exact: true })).toHaveCount(0);
  });

  test("keeps provider credentials in the local runtime during first-agent setup", async ({ page }) => {
    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");
    await page.locator('input[placeholder="Acme Corp"]').fill(`E2E-Runtime-Credentials-${Date.now()}`);
    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    const organization = await (await createOrganizationResponse).json() as { id: string };

    await page.route(`**/api/orgs/${organization.id}/adapters/pi_local/models`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "kimi-coding/kimi-for-coding", label: "Kimi for Coding" },
          { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
        ]),
      });
    });
    await page.route(
      `**/api/orgs/${organization.id}/adapters/pi_local/test-environment`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            agentRuntimeType: "pi_local",
            status: "pass",
            testedAt: "2026-08-31T00:00:00.000Z",
            checks: [{ code: "pi_hello_probe_passed", level: "info", message: "Pi hello probe succeeded." }],
          }),
        });
      },
    );

    await expectOnboardingStep(page, "Create your first agent");
    await expect(page.locator('input[placeholder*="API_KEY"]')).toHaveCount(0);
    await page.getByRole("button", { name: "More Agent Runtime Types" }).click();
    await page.getByRole("button", { name: "Pi" }).click();

    const onboardingDialog = page.getByTestId("onboarding-dialog");
    await onboardingDialog.getByRole("button", { name: "Kimi for Coding", exact: true }).click();
    const modelPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await modelPopover.getByRole("button", { name: "deepseek-chat", exact: true }).click();

    await expect(page.locator('input[placeholder*="API_KEY"]')).toHaveCount(0);
    await expect(onboardingDialog.getByText("Configure DeepSeek authentication in the Pi runtime", { exact: false })).toBeVisible();

    const testEnvironmentRequest = page.waitForRequest((request) =>
      request.method() === "POST"
      && request.url().endsWith(`/api/orgs/${organization.id}/adapters/pi_local/test-environment`),
    );
    await onboardingDialog.getByRole("button", { name: "Test now", exact: true }).click();
    const testBody = (await testEnvironmentRequest).postDataJSON() as {
      agentRuntimeConfig: Record<string, unknown>;
    };
    expect(testBody.agentRuntimeConfig).toMatchObject({ model: "deepseek/deepseek-chat" });
    expect(testBody.agentRuntimeConfig).not.toHaveProperty("env");
    await expect(onboardingDialog.getByText("Passed", { exact: true })).toBeVisible();

    const createAgentResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/agents`)
      && response.ok(),
    );
    await onboardingDialog.getByRole("button", { name: "Create", exact: true }).click();
    const agent = await (await createAgentResponse).json() as {
      agentRuntimeConfig: Record<string, unknown>;
    };
    expect(agent.agentRuntimeConfig).toMatchObject({ model: "deepseek/deepseek-chat" });
    expect(agent.agentRuntimeConfig).not.toHaveProperty("env");
    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 30_000 });

    const cleanupResponse = await page.request.delete(`/api/orgs/${organization.id}`);
    expect(cleanupResponse.ok()).toBe(true);
  });

  test("explains each slow setup stage while creating a starter organization", async ({
    page,
  }) => {
    const organizationGate = createRequestGate();
    const runtimeGate = createRequestGate();
    const agentGate = createRequestGate();
    const starterWorkspaceGate = createRequestGate();
    let organizationCreateRequestCount = 0;

    await page.route(/\/api\/orgs$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      organizationCreateRequestCount += 1;
      organizationGate.signalStarted();
      await organizationGate.blocked;
      await route.continue();
    });
    await page.route(
      /\/api\/orgs\/[^/]+\/adapters\/codex_local\/test-environment$/,
      async (route) => {
        runtimeGate.signalStarted();
        await runtimeGate.blocked;
        await route.continue();
      },
    );
    await page.route(/\/api\/orgs\/[^/]+\/agents$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      agentGate.signalStarted();
      await agentGate.blocked;
      await route.continue();
    });
    await page.route(
      /\/api\/orgs\/[^/]+\/onboarding\/getting-started$/,
      async (route) => {
        starterWorkspaceGate.signalStarted();
        await starterWorkspaceGate.blocked;
        await route.continue();
      },
    );

    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");
    await page
      .locator('input[placeholder="Acme Corp"]')
      .fill(`E2E-Slow-Onboarding-${Date.now()}`);
    await page.getByRole("button", { name: "Next" }).click();

    await organizationGate.started;
    await expect(
      page
        .getByTestId("onboarding-creation-progress")
        .getByRole("status", { name: "Creating organization..." }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("onboarding-creation-progress")).toBeVisible();
    await expect(page.getByTestId("onboarding-close")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Enter");
    organizationGate.release();

    await expectOnboardingStep(page, "Create your first agent");
    expect(organizationCreateRequestCount).toBe(1);
    await page.getByRole("button", { name: "Codex" }).click();
    await expect(page.locator('input[placeholder="Agent name"]')).toHaveValue(/\S+/, {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await runtimeGate.started;
    await expect(
      page
        .getByTestId("onboarding-creation-progress")
        .getByRole("status", { name: "Checking agent runtime..." }),
    ).toBeVisible();
    runtimeGate.release();

    await agentGate.started;
    await expect(
      page
        .getByTestId("onboarding-creation-progress")
        .getByRole("status", { name: "Creating agent..." }),
    ).toBeVisible();
    agentGate.release();

    await starterWorkspaceGate.started;
    await expect(
      page
        .getByTestId("onboarding-creation-progress")
        .getByRole("status", { name: "Preparing starter workspace..." }),
    ).toBeVisible();
    starterWorkspaceGate.release();

    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 30_000 });
    await expect(page.getByTestId("onboarding-creation-progress")).toHaveCount(0);
  });

  test("fresh onboarding creates a Getting Started project and opens messenger", async ({
    page,
  }) => {
    const initialOrganizationName = `E2E-Fresh-${Date.now()}`;
    const updatedOrganizationName = `${initialOrganizationName}-Updated`;
    const updatedAgentName = "Avery";

    await page.goto("/onboarding");

    await expectOnboardingStep(page, "Name your organization");
    await expect(page.getByRole("checkbox", { name: /new to Rudder/i })).toBeChecked();
    await expect(page.getByText(
      "Create two guided actions for your first real work loop. Turn this off to seed only the Welcome reference.",
    )).toBeVisible();
    await expectEvenOnboardingStepTabs(page);

    await expect(page.getByRole("button", { name: "Task", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Launch", exact: true })).toHaveCount(0);

    await page
      .locator('input[placeholder="Acme Corp"]')
      .fill(initialOrganizationName);

    await page.getByRole("button", { name: "Next" }).click();

    await expectOnboardingStep(page, "Create your first agent");
    await expectEvenOnboardingStepTabs(page);
    await page.getByRole("button", { name: "Back" }).click();
    await expectOnboardingStep(page, "Name your organization");
    await page
      .locator('input[placeholder="Acme Corp"]')
      .fill(updatedOrganizationName);
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Create your first agent");

    const onboardingNameInput = page.locator('input[placeholder="Agent name"]');
    await expect(page.getByText("Agent name", { exact: true })).toBeVisible();
    await expect(page.getByText("Agent name (optional)")).toHaveCount(0);
    await expect(onboardingNameInput).toHaveValue(/\S+/, { timeout: 15_000 });
    await page.getByRole("button", { name: "Codex" }).click();
    const selectedCodexModel = await expectSelectedCodexModel(page);
    expect(selectedCodexModel).toBe("gpt-5.6-sol");
    const thinkingEffortButton = page.getByRole("button", { name: "Auto", exact: true });
    await expect(thinkingEffortButton).toBeVisible();
    await thinkingEffortButton.click();
    const thinkingEffortPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(thinkingEffortPopover.getByText("Low", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("Ultra", { exact: true })).toBeVisible();
    await thinkingEffortPopover.getByText("Ultra", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Ultra", exact: true })).toBeVisible();
    await onboardingNameInput.fill(updatedAgentName);

    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 30_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");

    const organizationsRes = await page.request.get(`${baseUrl}/api/orgs`);
    expect(organizationsRes.ok()).toBe(true);
    const organizations = await organizationsRes.json();
    expect(
      organizations.some((org: { name: string }) => org.name === initialOrganizationName)
    ).toBe(false);
    const organization = organizations.find(
      (org: { name: string }) => org.name === updatedOrganizationName
    );
    expect(organization).toBeTruthy();
    expect(page.url()).toContain(`/${organization.urlKey}/messenger`);
    await page.goto("/");
    await expect(page).toHaveURL(
      new RegExp(`/${escapeRegExp(organization.urlKey)}/messenger(?:/chat)?$`),
      { timeout: 15_000 },
    );
    expect(organization).not.toHaveProperty("defaultChatAgentRuntimeType");
    expect(organization).not.toHaveProperty("defaultChatAgentRuntimeConfig");

    const agentsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    expect(agents).toHaveLength(1);
    const rootAgent = agents.find(
      (agent: { name: string }) => agent.name === updatedAgentName
    );
    expect(rootAgent).toBeTruthy();
    expect(rootAgent.role).toBe("ceo");
    expect(rootAgent.title).toBe("Operator Assistant");
    expect(rootAgent.agentRuntimeType).toBe("codex_local");
    expect(rootAgent.agentRuntimeConfig.model).toBe(selectedCodexModel);
    expect(rootAgent.agentRuntimeConfig.modelReasoningEffort).toBe("ultra");

    const profilesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/intelligence-profiles`,
    );
    expect(profilesRes.ok()).toBe(true);
    const profiles = await profilesRes.json() as Array<{
      purpose: string;
      agentRuntimeType: string;
      agentRuntimeConfig: Record<string, unknown>;
      status: string;
      lastVerifiedAt: string | null;
      lastError: string | null;
    } | null>;
    const profileByPurpose = new Map(
      profiles.filter(Boolean).map((profile) => [profile!.purpose, profile!]),
    );
    for (const purpose of ["lightweight", "reasoning"]) {
      const profile = profileByPurpose.get(purpose);
      expect(profile).toBeTruthy();
      expect(profile!.agentRuntimeType).toBe("codex_local");
      expect(profile!.agentRuntimeConfig.model).toBe("gpt-5.4-mini");
      expect(profile!.status).toBe("configured");
      expect(profile!.lastVerifiedAt).toBeTruthy();
      expect(profile!.lastError).toBeNull();
    }

    const projectsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = await projectsRes.json();
    const gettingStartedProjects = projects.filter(
      (project: { name: string; archivedAt?: string | null }) =>
        project.name === "Getting Started" && !project.archivedAt
    );
    expect(gettingStartedProjects).toHaveLength(1);
    const gettingStartedProject = gettingStartedProjects[0];
    expect(gettingStartedProject.description).toBe(
      "Complete one real work loop: start a small task in Chat or an Issue, inspect the result, and decide what happens next.",
    );

    const issuesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/issues?projectId=${gettingStartedProject.id}`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json() as Array<{
      title: string;
      status: string;
      priority: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      projectId: string | null;
      id: string;
      identifier?: string | null;
      description: string | null;
    }>;
    expect(issues.map((issue) => issue.title).sort()).toEqual(
      [...GETTING_STARTED_TITLES].sort()
    );
    const issueByTitle = new Map(issues.map((issue) => [issue.title, issue]));
    expect(issueByTitle.get(GETTING_STARTED_TITLES[0]!)?.status).toBe("done");
    expect(issueByTitle.get(GETTING_STARTED_TITLES[0]!)?.priority).toBe("low");
    for (const title of GETTING_STARTED_TITLES.slice(1)) {
      expect(issueByTitle.get(title)?.status).toBe("todo");
      expect(issueByTitle.get(title)?.priority).toBe("high");
    }
    const welcomeIssue = issueByTitle.get("👋 Welcome to Rudder — quick reference");
    const nextIssueSource = issueByTitle.get("1. Run one real task");
    const nextIssueTarget = issueByTitle.get("2. Review the result and close the loop");
    expect(welcomeIssue).toBeTruthy();
    expect(nextIssueSource).toBeTruthy();
    expect(nextIssueTarget).toBeTruthy();
    expect(welcomeIssue?.description).toContain(
      "Rudder moves real work through agent execution and human review",
    );
    expect(welcomeIssue?.description).toContain(
      "Chat is conversation-driven; Issues add structured ownership, status, and review",
    );
    const welcomeNextHref = extractMarkdownHref(
      welcomeIssue?.description ?? "",
      "1. Run one real task",
    );
    expect(new URL(welcomeNextHref, baseUrl).pathname).toBe(
      `/${organization.urlKey}/issues/${encodeURIComponent(nextIssueSource!.identifier ?? nextIssueSource!.id)}`,
    );
    expect(nextIssueSource?.description).toContain(
      "Choose a small, useful, low-risk task you can review today",
    );
    expect(nextIssueSource?.description).toContain(
      "Done when the agent leaves a result or clear progress update you can inspect",
    );
    expect(nextIssueTarget?.description).toContain(
      "Accept it, request a specific revision, or create a clear follow-up",
    );
    expect(nextIssueTarget?.description).toContain(
      "Done when both the result and your decision are recorded on the real work item",
    );
    const nextIssueHref = extractMarkdownHref(
      nextIssueSource?.description ?? "",
      "Review the result",
    );
    const nextIssueUrl = new URL(nextIssueHref, baseUrl);
    expect(nextIssueUrl.pathname).toBe(
      `/${organization.urlKey}/issues/${encodeURIComponent(nextIssueTarget!.identifier ?? nextIssueTarget!.id)}`,
    );
    const chatIssue = nextIssueSource;
    expect(chatIssue).toBeTruthy();
    const chatIssueDescription = chatIssue?.description ?? "";
    const chatCtaHref = extractMarkdownHref(chatIssueDescription, "Start in Chat");
    const chatCtaUrl = new URL(chatCtaHref, baseUrl);
    expect(chatCtaUrl.pathname).toBe(`/${organization.urlKey}/messenger/chat`);
    expect(chatIssueDescription).toContain(`projectId=${gettingStartedProject.id}`);
    expect(chatIssueDescription).toContain(`agentId=${rootAgent.id}`);
    expect(chatCtaUrl.searchParams.get("projectId")).toBe(gettingStartedProject.id);
    expect(chatCtaUrl.searchParams.get("agentId")).toBe(rootAgent.id);
    const expectedPrefill = chatCtaUrl.searchParams.get("prefill");
    expect(expectedPrefill).toBeTruthy();
    const issuesCtaHref = extractMarkdownHref(chatIssueDescription, "Open Issues");
    const issuesCtaUrl = new URL(issuesCtaHref, baseUrl);
    expect(issuesCtaUrl.pathname).toBe(`/${organization.urlKey}/issues`);
    expect(issuesCtaUrl.searchParams.get("projectId")).toBe(gettingStartedProject.id);
    const messengerCtaHref = extractMarkdownHref(
      nextIssueTarget?.description ?? "",
      "Open Messenger",
    );
    expect(new URL(messengerCtaHref, baseUrl).pathname).toBe(
      `/${organization.urlKey}/messenger`,
    );
    for (const issue of issues) {
      expect(issue.projectId).toBe(gettingStartedProject.id);
      expect(issue.assigneeAgentId).toBeNull();
      expect(issue.assigneeUserId).toBeTruthy();
    }

    const messengerGroupsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/messenger/groups`,
    );
    expect(messengerGroupsRes.ok()).toBe(true);
    const messengerGroups = await messengerGroupsRes.json() as {
      groups: Array<{
        name: string;
        entries: Array<{
          threadKey: string;
          thread: {
            threadKey: string;
            unreadCount: number;
            needsAttention: boolean;
            metadata?: { issueId?: string };
          };
        }>;
      }>;
    };
    const gettingStartedGroup = messengerGroups.groups.find((group) => group.name === "Getting Started");
    expect(gettingStartedGroup).toBeTruthy();
    expect(gettingStartedGroup!.entries.map((entry) => entry.threadKey)).toEqual(
      GETTING_STARTED_TITLES.map((title) => `issue:${issueByTitle.get(title)!.id}`),
    );
    expect(gettingStartedGroup!.entries.every((entry) => entry.thread.unreadCount === 0)).toBe(true);
    expect(gettingStartedGroup!.entries.every((entry) => entry.thread.needsAttention === false)).toBe(true);

    const messengerThreadsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/messenger/threads?splitIssues=true`,
    );
    expect(messengerThreadsRes.ok()).toBe(true);
    const messengerThreads = await messengerThreadsRes.json() as Array<{
      threadKey: string;
      unreadCount: number;
      needsAttention: boolean;
    }>;
    const seededIssueThreadKeys = new Set(issues.map((issue) => `issue:${issue.id}`));
    const seededIssueThreads = messengerThreads.filter((thread) => seededIssueThreadKeys.has(thread.threadKey));
    expect(seededIssueThreads).toHaveLength(issues.length);
    expect(seededIssueThreads.every((thread) => thread.unreadCount === 0)).toBe(true);
    expect(seededIssueThreads.every((thread) => thread.needsAttention === false)).toBe(true);

    const sidebarBadgesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/sidebar-badges`,
    );
    expect(sidebarBadgesRes.ok()).toBe(true);
    const sidebarBadges = await sidebarBadgesRes.json() as { unreadTouchedIssues: number; inbox: number };
    expect(sidebarBadges.unreadTouchedIssues).toBe(0);
    expect(sidebarBadges.inbox).toBe(0);

    await page.evaluate(() => {
      window.localStorage.setItem("rudder.productTour.completed.v1", "true");
      window.localStorage.removeItem("rudder.productTour.pendingAfterSetup.v1");
    });
    await page.goto(`/${organization.urlKey}/issues?projectId=${gettingStartedProject.id}`);
    await expect(page.getByRole("heading", { name: "Issue Tracker" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByText(/run one real task, inspect its result, and record your decision/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /Welcome to Rudder/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Run one real task/ }).first()).toBeVisible();

    await page.goto(
      `/${organization.urlKey}/issues/${encodeURIComponent(nextIssueSource!.identifier ?? nextIssueSource!.id)}`,
    );
    await page.evaluate(() => {
      window.localStorage.setItem("rudder.productTour.completed.v1", "true");
      window.localStorage.removeItem("rudder.productTour.pendingAfterSetup.v1");
    });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: nextIssueSource!.title })).toBeVisible({
      timeout: 15_000,
    });
    const nextIssueLink = page.locator("[data-markdown-link-href]").filter({
      hasText: "Review the result",
    });
    await expect(nextIssueLink).toHaveAttribute("data-markdown-link-href", nextIssueHref);
    await nextIssueLink.click({
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    });
    await expect(page).toHaveURL(
      new RegExp(
        `/${escapeRegExp(organization.urlKey)}/issues/${escapeRegExp(nextIssueTarget!.identifier ?? nextIssueTarget!.id)}$`,
      ),
      { timeout: 15_000 },
    );
    await expect(page.getByRole("heading", { name: nextIssueTarget!.title })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto(`/${organization.urlKey}/issues/${encodeURIComponent(chatIssue!.identifier ?? chatIssue!.id)}`);
    await expect(page.getByRole("heading", { name: chatIssue!.title })).toBeVisible({ timeout: 15_000 });
    const chatCta = page.locator("[data-markdown-link-href]").filter({ hasText: "Start in Chat" });
    await expect(chatCta).toHaveAttribute("data-markdown-link-href", chatCtaHref);
    await chatCta.click({
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    });
    await expect(page).toHaveURL(
      new RegExp(`/${escapeRegExp(organization.urlKey)}/messenger/chat(?:\\?|$)`),
      { timeout: 15_000 },
    );
    await expect(page.locator(".chat-composer")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-agent-selector")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-project-selector")).toContainText("Getting Started", { timeout: 15_000 });
    await expect(page.locator(".chat-composer [contenteditable='true']").first()).toContainText(expectedPrefill!, { timeout: 15_000 });
    await expect(page.locator(".chat-warning")).toHaveCount(0);

    await page.goto(`/${organization.urlKey}/issues/${encodeURIComponent(chatIssue!.identifier ?? chatIssue!.id)}`);
    const openIssuesCta = page.locator("[data-markdown-link-href]").filter({ hasText: "Open Issues" });
    await expect(openIssuesCta).toHaveAttribute("data-markdown-link-href", issuesCtaHref);
    await openIssuesCta.click({
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    });
    await expect(page).toHaveURL(
      new RegExp(`/${escapeRegExp(organization.urlKey)}/issues\\?projectId=${gettingStartedProject.id}$`),
      { timeout: 15_000 },
    );
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();
    const newIssueDialog = page.locator('[data-slot="dialog-content"]')
      .filter({ has: page.getByText("New issue") })
      .first();
    await expect(newIssueDialog.getByRole("button", { name: "Getting Started" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(newIssueDialog).toHaveCount(0);

    for (const guideIssue of [nextIssueSource!, nextIssueTarget!]) {
      await page.goto(
        `/${organization.urlKey}/issues/${encodeURIComponent(guideIssue.identifier ?? guideIssue.id)}`,
      );
      await page.getByRole("button", { name: "Todo", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Done", exact: true }).click();
      await page.reload({ waitUntil: "networkidle" });
      await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    }
  });

  test("getting started seed can create only the welcome issue for experienced users", async ({
    page,
  }) => {
    await page.goto("/onboarding");
    const baseUrl = new URL(page.url()).origin;

    const createRes = await page.request.post(`${baseUrl}/api/orgs`, {
      data: { name: `E2E-Experienced-${Date.now()}` },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json();

    const seedRes = await page.request.post(
      `${baseUrl}/api/orgs/${organization.id}/onboarding/getting-started`,
      { data: { includeTutorial: false } },
    );
    expect(seedRes.ok()).toBe(true);
    const seed = await seedRes.json();
    expect(seed.includeTutorial).toBe(false);
    expect(seed.issues.map((issue: { title: string }) => issue.title)).toEqual([
      "👋 Welcome to Rudder — quick reference",
    ]);

    const projectsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = await projectsRes.json();
    const gettingStartedProject = projects.find(
      (project: { name: string; archivedAt?: string | null }) =>
        project.name === "Getting Started" && !project.archivedAt
    );
    expect(gettingStartedProject).toBeTruthy();

    const issuesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/issues?projectId=${gettingStartedProject.id}`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    expect(issues.map((issue: { title: string }) => issue.title)).toEqual([
      "👋 Welcome to Rudder — quick reference",
    ]);

    const messengerGroupsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/messenger/groups`,
    );
    expect(messengerGroupsRes.ok()).toBe(true);
    const messengerGroups = await messengerGroupsRes.json() as {
      groups: Array<{ name: string; entries: Array<{ threadKey: string; thread: { unreadCount: number } }> }>;
    };
    const gettingStartedGroup = messengerGroups.groups.find((group) => group.name === "Getting Started");
    expect(gettingStartedGroup?.entries).toHaveLength(1);
    expect(gettingStartedGroup?.entries[0]?.thread.unreadCount).toBe(0);
  });

  test("v2 seed is idempotent and welcome-only can expand without deleting guides", async ({
    page,
  }) => {
    const createRes = await page.request.post("/api/orgs", {
      data: { name: `E2E-V2-Idempotent-${Date.now()}` },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json() as { id: string };
    const seedUrl = `/api/orgs/${organization.id}/onboarding/getting-started`;

    const welcomeOnlyRes = await page.request.post(seedUrl, {
      data: { includeTutorial: false },
    });
    expect(welcomeOnlyRes.status()).toBe(201);
    const welcomeOnly = await welcomeOnlyRes.json() as {
      project: { id: string };
      issues: Array<{ id: string; title: string }>;
    };
    expect(welcomeOnly.issues).toHaveLength(1);

    const repeatedWelcomeRes = await page.request.post(seedUrl, {
      data: { includeTutorial: false },
    });
    expect(repeatedWelcomeRes.status()).toBe(200);
    const repeatedWelcome = await repeatedWelcomeRes.json() as typeof welcomeOnly;
    expect(repeatedWelcome.project.id).toBe(welcomeOnly.project.id);
    expect(repeatedWelcome.issues.map((issue) => issue.id)).toEqual(
      welcomeOnly.issues.map((issue) => issue.id),
    );

    const fullSeedRes = await page.request.post(seedUrl, {
      data: { includeTutorial: true },
    });
    expect(fullSeedRes.status()).toBe(201);
    const fullSeed = await fullSeedRes.json() as typeof welcomeOnly;
    expect(fullSeed.issues.map((issue) => issue.title)).toEqual(GETTING_STARTED_TITLES);
    expect(fullSeed.issues[0]?.id).toBe(welcomeOnly.issues[0]?.id);

    const repeatedFullRes = await page.request.post(seedUrl, {
      data: { includeTutorial: true },
    });
    expect(repeatedFullRes.status()).toBe(200);
    const repeatedFull = await repeatedFullRes.json() as typeof welcomeOnly;
    expect(repeatedFull.issues.map((issue) => issue.id)).toEqual(
      fullSeed.issues.map((issue) => issue.id),
    );

    const welcomeAgainRes = await page.request.post(seedUrl, {
      data: { includeTutorial: false },
    });
    expect(welcomeAgainRes.status()).toBe(200);
    const allIssuesRes = await page.request.get(
      `/api/orgs/${organization.id}/issues?projectId=${welcomeOnly.project.id}`,
    );
    expect(allIssuesRes.ok()).toBe(true);
    const allIssues = await allIssuesRes.json() as Array<{ id: string; title: string }>;
    expect(allIssues.map((issue) => issue.title).sort()).toEqual(
      [...GETTING_STARTED_TITLES].sort(),
    );
    expect(new Set(allIssues.map((issue) => issue.id))).toEqual(
      new Set(fullSeed.issues.map((issue) => issue.id)),
    );

    const emptyProjectOrgRes = await page.request.post("/api/orgs", {
      data: { name: `E2E-V2-Empty-Project-${Date.now()}` },
    });
    expect(emptyProjectOrgRes.ok()).toBe(true);
    const emptyProjectOrg = await emptyProjectOrgRes.json() as { id: string };
    const emptyProjectRes = await page.request.post(
      `/api/orgs/${emptyProjectOrg.id}/projects`,
      {
        data: {
          name: "Getting Started",
          description: "Replace this description when v2 seeds",
          status: "planned",
        },
      },
    );
    expect(emptyProjectRes.ok()).toBe(true);
    const emptyProject = await emptyProjectRes.json() as { id: string };
    const emptyProjectSeedRes = await page.request.post(
      `/api/orgs/${emptyProjectOrg.id}/onboarding/getting-started`,
      { data: { includeTutorial: true } },
    );
    expect(emptyProjectSeedRes.status()).toBe(201);
    await expect(emptyProjectSeedRes.json()).resolves.toMatchObject({
      project: {
        id: emptyProject.id,
        description: "Complete one real work loop: start a small task in Chat or an Issue, inspect the result, and decide what happens next.",
      },
      issues: GETTING_STARTED_TITLES.map((title) => ({ title })),
      createdProject: false,
      createdIssueCount: 3,
    });
  });

  test("legacy and unrelated Getting Started projects remain byte-for-byte unchanged", async ({
    page,
  }) => {
    for (const [index, title] of [
      LEGACY_GETTING_STARTED_TITLES[0]!,
      "Operator-authored first task",
    ].entries()) {
      const createRes = await page.request.post("/api/orgs", {
        data: { name: `E2E-Frozen-Getting-Started-${index}-${Date.now()}` },
      });
      expect(createRes.ok()).toBe(true);
      const organization = await createRes.json() as { id: string };
      const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
        data: {
          name: "Getting Started",
          description: `Keep this description unchanged ${index}`,
          status: "in_progress",
        },
      });
      expect(projectRes.ok()).toBe(true);
      const project = await projectRes.json() as { id: string };
      const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          projectId: project.id,
          title,
          description: `Keep this issue unchanged ${index}`,
          status: "blocked",
          priority: "high",
          boardOrder: 7300,
        },
      });
      expect(issueRes.ok()).toBe(true);

      const beforeProjectsRes = await page.request.get(`/api/orgs/${organization.id}/projects`);
      const beforeIssuesRes = await page.request.get(
        `/api/orgs/${organization.id}/issues?projectId=${project.id}`,
      );
      const beforeGroupsRes = await page.request.get(
        `/api/orgs/${organization.id}/messenger/groups`,
      );
      const beforeProjects = await beforeProjectsRes.json();
      const beforeIssues = await beforeIssuesRes.json();
      const beforeGroups = await beforeGroupsRes.json();

      const seedRes = await page.request.post(
        `/api/orgs/${organization.id}/onboarding/getting-started`,
        { data: { includeTutorial: true } },
      );
      expect(seedRes.status()).toBe(200);
      await expect(seedRes.json()).resolves.toMatchObject({
        project: { id: project.id },
        issues: [{ title }],
        createdProject: false,
        createdIssueCount: 0,
      });

      const afterProjectsRes = await page.request.get(`/api/orgs/${organization.id}/projects`);
      const afterIssuesRes = await page.request.get(
        `/api/orgs/${organization.id}/issues?projectId=${project.id}`,
      );
      const afterGroupsRes = await page.request.get(
        `/api/orgs/${organization.id}/messenger/groups`,
      );
      expect(await afterProjectsRes.json()).toEqual(beforeProjects);
      expect(await afterIssuesRes.json()).toEqual(beforeIssues);
      expect(await afterGroupsRes.json()).toEqual(beforeGroups);
    }
  });

  test("a Getting Started project with only a hidden issue remains frozen", async ({ page }) => {
    const createRes = await page.request.post("/api/orgs", {
      data: { name: `E2E-Frozen-Hidden-Getting-Started-${Date.now()}` },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json() as { id: string };
    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Getting Started",
        description: "Hidden operator work must keep this description",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string };
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        projectId: project.id,
        title: "Hidden operator-authored first task",
        description: "Do not reveal or mutate this issue during reseed",
        status: "blocked",
        priority: "high",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string };
    const hideRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { hiddenAt: new Date().toISOString() },
    });
    expect(hideRes.ok()).toBe(true);

    const beforeProjects = await page.request.get(`/api/orgs/${organization.id}/projects`)
      .then((response) => response.json());
    const beforeIssue = await page.request.get(`/api/issues/${issue.id}`)
      .then((response) => response.json());
    const beforeGroups = await page.request.get(`/api/orgs/${organization.id}/messenger/groups`)
      .then((response) => response.json());

    const seedRes = await page.request.post(
      `/api/orgs/${organization.id}/onboarding/getting-started`,
      { data: { includeTutorial: true } },
    );
    expect(seedRes.status()).toBe(200);
    await expect(seedRes.json()).resolves.toMatchObject({
      project: { id: project.id },
      issues: [],
      createdProject: false,
      createdIssueCount: 0,
    });

    const afterProjects = await page.request.get(`/api/orgs/${organization.id}/projects`)
      .then((response) => response.json());
    const afterIssue = await page.request.get(`/api/issues/${issue.id}`)
      .then((response) => response.json());
    const afterGroups = await page.request.get(`/api/orgs/${organization.id}/messenger/groups`)
      .then((response) => response.json());
    expect(afterProjects).toEqual(beforeProjects);
    expect(afterIssue).toEqual(beforeIssue);
    expect(afterGroups).toEqual(beforeGroups);
  });

  test("a hidden v2 guide is frozen and never duplicated by reseed", async ({ page }) => {
    const createRes = await page.request.post("/api/orgs", {
      data: { name: `E2E-Frozen-Hidden-V2-${Date.now()}` },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json() as { id: string };
    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Getting Started",
        description: "Hidden v2 content remains operator-owned",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string };
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        projectId: project.id,
        title: GETTING_STARTED_TITLES[0],
        description: "Keep this hidden v2 guide unchanged",
        status: "blocked",
        priority: "high",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string };
    const hiddenAt = new Date().toISOString();
    const hideRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { hiddenAt },
    });
    expect(hideRes.ok()).toBe(true);
    const beforeIssue = await page.request.get(`/api/issues/${issue.id}`)
      .then((response) => response.json());

    const seedRes = await page.request.post(
      `/api/orgs/${organization.id}/onboarding/getting-started`,
      { data: { includeTutorial: true } },
    );
    expect(seedRes.status()).toBe(200);
    await expect(seedRes.json()).resolves.toMatchObject({
      project: { id: project.id, description: "Hidden v2 content remains operator-owned" },
      issues: [],
      createdProject: false,
      createdIssueCount: 0,
    });
    const afterIssue = await page.request.get(`/api/issues/${issue.id}`)
      .then((response) => response.json());
    expect(afterIssue).toEqual(beforeIssue);

    const unhideRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { hiddenAt: null },
    });
    expect(unhideRes.ok()).toBe(true);
    const visibleIssuesRes = await page.request.get(
      `/api/orgs/${organization.id}/issues?projectId=${project.id}`,
    );
    expect(visibleIssuesRes.ok()).toBe(true);
    const visibleIssues = await visibleIssuesRes.json() as Array<{ id: string; title: string }>;
    expect(visibleIssues).toHaveLength(1);
    expect(visibleIssues[0]).toMatchObject({ id: issue.id, title: GETTING_STARTED_TITLES[0] });
  });

  test("existing organization onboarding starts at agent and runtime test stays valid", async ({
    page,
  }) => {
    const organizationName = `E2E-Existing-${Date.now()}`;
    const createRes = await page.request.post("/api/orgs", {
      data: { name: organizationName },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json();

    const existingProjectRes = await page.request.post(
      `/api/orgs/${organization.id}/projects`,
      {
        data: {
          name: "Getting Started",
          description: "Existing operator-owned onboarding project",
          status: "in_progress",
        },
      },
    );
    expect(existingProjectRes.ok()).toBe(true);
    const existingProject = await existingProjectRes.json() as { id: string };
    const existingIssueRes = await page.request.post(
      `/api/orgs/${organization.id}/issues`,
      {
        data: {
          projectId: existingProject.id,
          title: "Existing operator-owned guide",
          description: "Do not mutate during agent onboarding",
          status: "blocked",
          priority: "high",
        },
      },
    );
    expect(existingIssueRes.ok()).toBe(true);
    const beforeProject = await existingProjectRes.json();
    const beforeIssuesRes = await page.request.get(
      `/api/orgs/${organization.id}/issues?projectId=${existingProject.id}`,
    );
    expect(beforeIssuesRes.ok()).toBe(true);
    const beforeIssues = await beforeIssuesRes.json();

    await page.goto(`/${organization.urlKey}/onboarding`);

    await expectOnboardingStep(page, "Create your first agent");
    await expect(page.getByTestId("onboarding-close")).toBeVisible();
    await page.getByTestId("onboarding-close").click();
    await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
    await page.getByRole("button", { name: "Add agent" }).click();
    await expectOnboardingStep(page, "Create your first agent");
    const onboardingNameInput = page.locator('input[placeholder="Agent name"]');
    await expect(page.getByText("Agent name", { exact: true })).toBeVisible();
    await expect(page.getByText("Agent name (optional)")).toHaveCount(0);
    await expect(onboardingNameInput).toHaveValue(/\S+/, { timeout: 15_000 });
    const agentName = await onboardingNameInput.inputValue();

    await expect(page.getByRole("button", { name: "Task", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Launch", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Codex" }).click();
    await expectSelectedCodexModel(page);

    await page.getByRole("button", { name: "Test now" }).click();
    await expect(
      page.getByText("Passed")
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Complete organization setup before testing the runtime.")
    ).toHaveCount(0);

    await page.getByText("Create", { exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${escapeRegExp(organization.urlKey)}/messenger(?:/chat)?$`),
      { timeout: 30_000 },
    );

    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const agentsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    const rootAgent = agents.find(
      (agent: { name: string }) => agent.name === agentName
    );
    expect(rootAgent).toBeTruthy();

    const afterProjectsRes = await page.request.get(`/api/orgs/${organization.id}/projects`);
    const afterProjects = await afterProjectsRes.json() as Array<{ id: string }>;
    expect(afterProjects.find((project) => project.id === existingProject.id)).toEqual(beforeProject);
    const afterIssuesRes = await page.request.get(
      `/api/orgs/${organization.id}/issues?projectId=${existingProject.id}`,
    );
    expect(await afterIssuesRes.json()).toEqual(beforeIssues);
  });

  test("new organization onboarding blocks background Escape navigation", async ({
    page,
  }) => {
    const createRes = await page.request.post("/api/orgs", {
      data: { name: `E2E-Onboarding-Modal-${Date.now()}` },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json() as {
      id: string;
      urlKey: string;
    };

    await page.goto(`/${organization.urlKey}/messenger`);
    await page.goto(`/${organization.urlKey}/dashboard`);
    const backgroundUrl = page.url();

    await page.getByRole("button", { name: "Organization menu" }).click();
    await page.getByRole("menuitem", { name: "Add organization" }).click();
    await expectOnboardingStep(page, "Name your organization");
    await expect(
      page.getByRole("dialog", { name: "Create organization onboarding" }),
    ).toBeVisible();
    await expect(page.getByTestId("onboarding-close")).toHaveCount(0);

    await page.keyboard.press("Escape");

    await expectOnboardingStep(page, "Name your organization");
    await expect(page).toHaveURL(backgroundUrl);

    const cleanupResponse = await page.request.delete(
      `/api/orgs/${organization.id}`,
    );
    expect(cleanupResponse.ok()).toBe(true);
  });

  test("new organization onboarding cannot be closed before completion", async ({
    page,
  }) => {
    const organizationName = `E2E-Required-Onboarding-${Date.now()}`;

    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");
    await expect(page.getByTestId("onboarding-close")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectOnboardingStep(page, "Name your organization");

    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Create your first agent");
    await expect(page.getByTestId("onboarding-close")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectOnboardingStep(page, "Create your first agent");
    await expect(page.getByText("Create your first organization")).toHaveCount(0);
    await expect(page.getByText("Create another organization")).toHaveCount(0);

    const createdOrganization = await (await createOrganizationResponse).json() as {
      id: string;
    };
    const cleanupResponse = await page.request.delete(
      `/api/orgs/${createdOrganization.id}`,
    );
    expect(cleanupResponse.ok()).toBe(true);
  });

  test("new organization drafts are rolled back on reload before completion", async ({
    page,
  }) => {
    const organizationName = `E2E-Draft-Reload-${Date.now()}`;

    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");

    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Create your first agent");

    await page.reload({ waitUntil: "networkidle" });
    await expectOnboardingStep(page, "Name your organization");

    await expect
      .poll(async () => {
        const organizationsRes = await page.request.get("/api/orgs");
        expect(organizationsRes.ok()).toBe(true);
        const organizations = await organizationsRes.json();
        return organizations.some(
          (organization: { name: string }) => organization.name === organizationName
        );
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(false);
  });
});
