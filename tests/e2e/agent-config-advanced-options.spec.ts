import { expect, test } from "@playwright/test";

test.describe("Agent configuration advanced options", () => {
  test("keeps model and thinking effort visible while hiding lower-frequency runtime settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Config-Advanced-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Naomi",
        role: "ceo",
        title: "CEO",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: "codex",
          model: "gpt-5.5",
          modelFallbacks: [{
            agentRuntimeType: "codex_local",
            model: "gpt-5.6-terra",
            config: {
              model: "gpt-5.6-terra",
              modelReasoningEffort: "ultra",
            },
          }],
          modelReasoningEffort: "",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.route(`**/api/orgs/${organization.id}/adapters/availability`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            agentRuntimeType: "claude_local",
            status: "available",
            command: "claude",
            resolvedCommand: "/tmp/rudder-e2e/bin/claude",
            message: "Claude Code CLI is available.",
            checkedAt: "2026-07-07T00:00:00.000Z",
          },
          {
            agentRuntimeType: "codex_local",
            status: "available",
            command: "codex",
            resolvedCommand: "/tmp/rudder-e2e/bin/codex",
            message: "Codex CLI is available.",
            checkedAt: "2026-07-07T00:00:00.000Z",
          },
          {
            agentRuntimeType: "gemini_local",
            status: "unavailable",
            command: "gemini",
            resolvedCommand: null,
            message: "Gemini CLI default command was not found on PATH.",
            hint: "Install the gemini CLI, or set a custom command path in Advanced options and run Test runtime chain.",
            checkedAt: "2026-07-07T00:00:00.000Z",
          },
          {
            agentRuntimeType: "openclaw_gateway",
            status: "unknown",
            command: null,
            resolvedCommand: null,
            message: "This runtime does not use a local CLI command probe.",
            checkedAt: "2026-07-07T00:00:00.000Z",
          },
        ]),
      });
    });

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/configuration`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Naomi", exact: true })).toBeVisible();
    await expect(page.getByText("Permissions & Configuration", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test runtime chain", exact: true })).toBeVisible();
    await expect(page.getByText("Primary", { exact: true })).toBeVisible();
    await expect(page.getByText("Fallback 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Model", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "GPT-5.5", exact: true })).toBeVisible();
    const fallbackModelButton = page.getByTestId("agent-fallback-model-1");
    const fallbackCard = page.locator('[data-runtime-chain-item="fallback-0"]');
    await expect(fallbackModelButton).toContainText("GPT-5.6-terra");
    await expect(fallbackCard.getByRole("button", { name: "Ultra", exact: true })).toBeVisible();

    await fallbackModelButton.click();
    await page.locator("[data-radix-popper-content-wrapper]").last()
      .getByRole("button", { name: "GPT-5.4", exact: true })
      .click();
    await expect(fallbackModelButton).toContainText("GPT-5.4");
    const fallbackThinkingEffortButton = fallbackCard.getByRole("button", { name: "Auto", exact: true });
    await expect(fallbackThinkingEffortButton).toBeVisible();
    await fallbackThinkingEffortButton.click();
    const fallbackThinkingEffortPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(fallbackThinkingEffortPopover.getByText("Low", { exact: true })).toBeVisible();
    await expect(fallbackThinkingEffortPopover.getByText("Light", { exact: true })).toHaveCount(0);
    await expect(fallbackThinkingEffortPopover.getByText("Max", { exact: true })).toHaveCount(0);
    await expect(fallbackThinkingEffortPopover.getByText("Ultra", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByTestId("agent-primary-model").click();
    const primaryModelPopover = page.locator("[data-radix-popper-content-wrapper]").last();
    const primaryModelOptions = primaryModelPopover.getByRole("button");
    await expect(primaryModelOptions).toHaveCount(8);
    expect(await primaryModelOptions.allTextContents()).toEqual([
      "Default",
      "GPT-5.6-sol",
      "GPT-5.6-terra",
      "GPT-5.6-luna",
      "GPT-5.5",
      "GPT-5.4",
      "GPT-5.4 Mini",
      "GPT-5.2",
    ]);
    await primaryModelPopover.getByRole("button", { name: "GPT-5.6-sol", exact: true }).click();
    await expect(page.getByTestId("agent-primary-model")).toContainText("GPT-5.6-sol");

    await expect(page.getByText("Add fallback model", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Codex (local)", exact: true }).first().click();
    const runtimeTypePopover = page.locator("[data-radix-popper-content-wrapper]").last();
    await expect(runtimeTypePopover.getByText("Ready on this machine", { exact: true })).toBeVisible();
    await expect(runtimeTypePopover.getByText("Needs setup", { exact: true })).toBeVisible();
    await expect(runtimeTypePopover.getByText("Claude Code (local)", { exact: true })).toBeVisible();
    await expect(runtimeTypePopover.getByText("Ready", { exact: true }).first()).toBeVisible();
    await expect(runtimeTypePopover.getByText("Gemini CLI (local)", { exact: true })).toBeVisible();
    await expect(runtimeTypePopover.getByText("Default CLI missing", { exact: true }).first()).toBeVisible();
    await expect(runtimeTypePopover.getByText("OpenClaw Gateway", { exact: true })).toBeVisible();
    await expect(runtimeTypePopover.getByText("Process", { exact: true })).toHaveCount(0);
    await expect(runtimeTypePopover.getByText("HTTP", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByText("Thinking effort", { exact: true }).first()).toBeVisible();
    const primaryThinkingEffortButton = page.getByRole("button", { name: "Auto", exact: true }).first();
    await expect(primaryThinkingEffortButton).toBeVisible();
    await primaryThinkingEffortButton.click();
    const thinkingEffortPopover = page.locator('[data-radix-popper-content-wrapper]').last();
    await expect(thinkingEffortPopover.getByText("Light", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("Extra High", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("Max", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("Ultra", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("Low", { exact: true })).toHaveCount(0);
    await thinkingEffortPopover.getByText("Ultra", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Ultra", exact: true }).first()).toBeVisible();
    const runConcurrencyInput = page.getByRole("spinbutton", { name: "Agent run concurrency" });
    await expect(runConcurrencyInput).toBeVisible();
    await expect(runConcurrencyInput).toHaveValue("3");
    await expect(page.getByRole("switch", { name: "Preflight before timer run", exact: true })).toBeChecked();

    const advancedButton = page.getByRole("button", { name: "Advanced options", exact: true }).first();
    await expect(advancedButton).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Command", { exact: true }).first()).toBeHidden();
    await expect(page.getByText("Environment variables", { exact: true }).first()).toBeHidden();
    await expect(page.getByText("Bypass sandbox", { exact: true }).first()).toBeHidden();
    await expect(page.getByText("Estimate subscription usage cost", { exact: true }).first()).toBeHidden();

    await advancedButton.click();

    await expect(advancedButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Command", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Environment variables", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Bypass sandbox", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable search", exact: true })).toBeChecked();
    const countSubscriptionUsageSwitch = page.getByRole("switch", { name: "Estimate subscription usage cost", exact: true });
    await expect(countSubscriptionUsageSwitch).toBeChecked();
    await countSubscriptionUsageSwitch.click();
    await expect(countSubscriptionUsageSwitch).not.toBeChecked();

    await page.getByText("Add fallback model", { exact: true }).click();
    await expect(page.getByText("Fallback 2", { exact: true })).toBeVisible();
    await page.getByTestId("agent-fallback-model-2").click();
    await page.getByPlaceholder("Search models...").fill("openrouter/custom-model");
    await page.getByText('Use "openrouter/custom-model"', { exact: true }).click();

    await runConcurrencyInput.fill("4");
    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/agents/${agent.id}`),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saveResponse).ok()).toBe(true);

    const refreshedRes = await page.request.get(`/api/agents/${agent.id}?orgId=${organization.id}`);
    expect(refreshedRes.ok()).toBe(true);
    const refreshed = await refreshedRes.json() as {
      agentRuntimeConfig: {
        countSubscriptionUsageAsCost?: boolean;
        model?: string;
        modelFallbacks?: Array<{ agentRuntimeType: string; model: string; config?: Record<string, unknown> }>;
        modelReasoningEffort?: string;
      };
      runtimeConfig: { heartbeat?: { maxConcurrentRuns?: number; preflightEnabled?: boolean } };
    };
    expect(refreshed.agentRuntimeConfig.countSubscriptionUsageAsCost).toBe(false);
    expect(refreshed.agentRuntimeConfig.model).toBe("gpt-5.6-sol");
    expect(refreshed.agentRuntimeConfig.modelReasoningEffort).toBe("ultra");
    expect(refreshed.agentRuntimeConfig.modelFallbacks).toEqual([
      expect.objectContaining({ agentRuntimeType: "codex_local", model: "gpt-5.4" }),
      expect.objectContaining({
        agentRuntimeType: "claude_local",
        model: "openrouter/custom-model",
      }),
    ]);
    expect(refreshed.agentRuntimeConfig.modelFallbacks?.[0]?.config ?? {})
      .not.toHaveProperty("modelReasoningEffort");
    expect(refreshed.runtimeConfig.heartbeat?.maxConcurrentRuns).toBe(4);
    expect(refreshed.runtimeConfig.heartbeat?.preflightEnabled ?? true).toBe(true);
  });

  test("saves and clears Codex thinking effort", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Config-Thinking-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Naomi",
        role: "ceo",
        title: "CEO",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: "codex",
          model: "gpt-5.5",
          modelFallbacks: [],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/configuration`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Naomi", exact: true })).toBeVisible();
    const primaryThinkingEffortButton = page.getByRole("button", { name: "Auto", exact: true }).first();
    await expect(primaryThinkingEffortButton).toBeVisible();
    await primaryThinkingEffortButton.click();
    await page.locator("[data-radix-popper-content-wrapper]").last().getByText("High", { exact: true }).click();

    const saveHighResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/agents/${agent.id}`),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const savedHighResponse = await saveHighResponse;
    expect(savedHighResponse.ok()).toBe(true);
    const savedHigh = await savedHighResponse.json() as { agentRuntimeConfig: Record<string, unknown> };
    expect(savedHigh.agentRuntimeConfig.modelReasoningEffort).toBe("high");
    expect(savedHigh.agentRuntimeConfig).not.toHaveProperty("reasoningEffort");

    const highThinkingEffortButton = page.getByRole("button", { name: "High", exact: true }).first();
    await expect(highThinkingEffortButton).toBeVisible();
    await highThinkingEffortButton.click();
    await page.locator("[data-radix-popper-content-wrapper]").last().getByText("Auto", { exact: true }).click();

    const saveAutoResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/agents/${agent.id}`),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const savedAutoResponse = await saveAutoResponse;
    expect(savedAutoResponse.ok()).toBe(true);
    const savedAuto = await savedAutoResponse.json() as { agentRuntimeConfig: Record<string, unknown> };
    expect(savedAuto.agentRuntimeConfig).not.toHaveProperty("modelReasoningEffort");
    expect(savedAuto.agentRuntimeConfig).not.toHaveProperty("reasoningEffort");
  });

  test("shows warning-only runtime environment results as setup guidance", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Config-Warn-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Naomi",
        role: "ceo",
        title: "CEO",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: "codex",
          model: "gpt-5.5",
          modelFallbacks: [],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.route(`**/api/orgs/${organization.id}/adapters/codex_local/test-environment`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "warn",
          testedAt: "2026-04-29T00:00:00.000Z",
          checks: [
            {
              code: "auth_optional",
              level: "warn",
              message: "Auth is optional",
            },
          ],
        }),
      });
    });

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/configuration`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Naomi", exact: true })).toBeVisible();
    const testButton = page.getByRole("button", { name: "Test runtime chain", exact: true });
    const testResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/orgs/${organization.id}/adapters/codex_local/test-environment`),
    );
    await testButton.click();
    expect((await testResponse).ok()).toBe(true);

    await expect(page.getByText("Env needs setup", { exact: true })).toBeVisible();
    await expect(page.getByText(/Primary .*: Needs setup/)).toBeVisible();
    await expect(page.getByText("Auth is optional", { exact: true })).toBeVisible();
  });
});
