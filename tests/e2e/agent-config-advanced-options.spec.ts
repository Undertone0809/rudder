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
          modelFallbacks: [{ agentRuntimeType: "codex_local", model: "gpt-5.4" }],
          modelReasoningEffort: "",
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
    await expect(page.getByText("Permissions & Configuration", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test runtime chain", exact: true })).toBeVisible();
    await expect(page.getByText("Primary", { exact: true })).toBeVisible();
    await expect(page.getByText("Fallback 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Model", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "gpt-5.5", exact: true })).toBeVisible();
    await expect(page.getByTestId("agent-fallback-model-1")).toContainText("gpt-5.4");
    await expect(page.getByText("Add fallback", { exact: true })).toBeVisible();
    await expect(page.getByText("Thinking effort", { exact: true }).first()).toBeVisible();
    const primaryThinkingEffortButton = page.getByRole("button", { name: "Auto", exact: true }).first();
    await expect(primaryThinkingEffortButton).toBeVisible();
    await primaryThinkingEffortButton.click();
    const thinkingEffortPopover = page.locator('[data-radix-popper-content-wrapper]').last();
    await expect(thinkingEffortPopover.getByText("Extra High", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("xhigh", { exact: true })).toBeVisible();
    await expect(thinkingEffortPopover.getByText("Minimal", { exact: true })).toHaveCount(0);
    const runConcurrencyInput = page.getByRole("spinbutton", { name: "Agent run concurrency" });
    await expect(runConcurrencyInput).toBeVisible();
    await expect(runConcurrencyInput).toHaveValue("3");

    const advancedButton = page.getByRole("button", { name: "Advanced options", exact: true }).first();
    await expect(advancedButton).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Command", { exact: true }).first()).toBeHidden();
    await expect(page.getByText("Environment variables", { exact: true }).first()).toBeHidden();
    await expect(page.getByText("Bypass sandbox", { exact: true }).first()).toBeHidden();

    await advancedButton.click();

    await expect(advancedButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Command", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Environment variables", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Bypass sandbox", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable search", exact: true })).toBeChecked();

    await page.getByText("Add fallback", { exact: true }).click();
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
      agentRuntimeConfig: { modelFallbacks?: Array<{ agentRuntimeType: string; model: string; config?: Record<string, unknown> }> };
      runtimeConfig: { heartbeat?: { maxConcurrentRuns?: number } };
    };
    expect(refreshed.agentRuntimeConfig.modelFallbacks).toEqual([
      { agentRuntimeType: "codex_local", model: "gpt-5.4" },
      expect.objectContaining({
        agentRuntimeType: "claude_local",
        model: "openrouter/custom-model",
      }),
    ]);
    expect(refreshed.runtimeConfig.heartbeat?.maxConcurrentRuns).toBe(4);
  });

  test("suppresses warning-only runtime environment results in the visible UI", async ({ page }) => {
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

    await expect(page.getByText("Env passed", { exact: true })).toBeVisible();
    await expect(page.getByText(/Primary .*: Passed/)).toBeVisible();
    await expect(page.getByText("Auth is optional", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Warnings", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Env warnings", { exact: true })).toHaveCount(0);
  });
});
