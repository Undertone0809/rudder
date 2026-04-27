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
    await expect(page.getByText("Permissions & Configuration", { exact: true })).toBeVisible();
    await expect(page.getByText("Model", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "gpt-5.5", exact: true })).toBeVisible();
    await expect(page.getByText("Thinking effort", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Auto", exact: true })).toBeVisible();
    const runConcurrencyInput = page.getByRole("spinbutton", { name: "Agent run concurrency" });
    await expect(runConcurrencyInput).toBeVisible();
    await expect(runConcurrencyInput).toHaveValue("3");

    const advancedButton = page.getByRole("button", { name: "Advanced options", exact: true });
    await expect(advancedButton).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Command", { exact: true })).toBeHidden();
    await expect(page.getByText("Environment variables", { exact: true })).toBeHidden();
    await expect(page.getByText("Bypass sandbox", { exact: true })).toBeHidden();

    await advancedButton.click();

    await expect(advancedButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Command", { exact: true })).toBeVisible();
    await expect(page.getByText("Environment variables", { exact: true })).toBeVisible();
    await expect(page.getByText("Bypass sandbox", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable search", exact: true })).toBeChecked();

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
      runtimeConfig: { heartbeat?: { maxConcurrentRuns?: number } };
    };
    expect(refreshed.runtimeConfig.heartbeat?.maxConcurrentRuns).toBe(4);
  });
});
