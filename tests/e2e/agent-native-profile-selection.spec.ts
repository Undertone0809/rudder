import { expect, test } from "@playwright/test";

for (const runtime of ["claude_local", "cursor", "pi_local", "opencode_local"]) {
  test(`creates and edits the native Profile for ${runtime} without changing other settings`, async ({ page }) => {
    const organizationResponse = await page.request.post("/api/orgs", {
      data: { name: `Native-Profile-${runtime}-${Date.now()}` },
    });
    expect(organizationResponse.ok()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
    const operator = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: { name: "Existing operator", role: "ceo", agentRuntimeType: "codex_local", agentRuntimeConfig: {} },
    });
    expect(operator.ok()).toBe(true);
    await page.addInitScript((orgId: string) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/new?agentRuntimeType=${runtime}`);
    await page.getByPlaceholder("Agent name").fill(`Native ${runtime} Profile`);
    await page.getByRole("button", { name: "Advanced options", exact: true }).first().click();
    const profile = page.getByRole("combobox", { name: "Native Chat Profile", exact: true });
    await expect(profile).toHaveValue("operator-default");
    await profile.selectOption("default");
    await profile.selectOption("operator-default");
    const creation = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/orgs/${organization.id}/agent-hires`);
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    const response = await creation;
    expect(response.ok()).toBe(true);
    const { agent } = await response.json() as { agent: { id: string; agentRuntimeType: string; agentRuntimeConfig: Record<string, unknown> } };
    expect(agent.agentRuntimeType).toBe(runtime);
    expect(agent.agentRuntimeConfig.profileId).toBe("operator-default");
    const originalModel = agent.agentRuntimeConfig.model;

    // A saved custom selector must survive opening the form. Changing only
    // the Profile then persists without silently replacing the chosen model.
    const custom = await page.request.patch(`/api/agents/${agent.id}?orgId=${organization.id}`, {
      data: { agentRuntimeConfig: { ...agent.agentRuntimeConfig, profileId: "team-profile" } },
    });
    expect(custom.ok()).toBe(true);
    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/configuration`);
    await page.getByRole("button", { name: "Advanced options", exact: true }).first().click();
    await expect(profile).toHaveValue("team-profile");
    await profile.selectOption("team-profile");
    const customSave = page.waitForResponse(value => value.request().method() === "PATCH"
      && new URL(value.url()).pathname === `/api/agents/${agent.id}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await customSave).ok()).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "Advanced options", exact: true }).first().click();
    await expect(profile).toHaveValue("team-profile");
    await profile.selectOption("default");
    const saved = page.waitForResponse(value => value.request().method() === "PATCH"
      && new URL(value.url()).pathname === `/api/agents/${agent.id}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const persisted = await page.request.get(`/api/agents/${agent.id}?orgId=${organization.id}`);
    expect(persisted.ok()).toBe(true);
    const persistedConfig = (await persisted.json()).agentRuntimeConfig;
    expect(persistedConfig.profileId).toBe("default");
    expect(persistedConfig.model).toBe(originalModel);
    await page.reload();
    await page.getByRole("button", { name: "Advanced options", exact: true }).first().click();
    await expect(profile).toHaveValue("default");
  });
}
