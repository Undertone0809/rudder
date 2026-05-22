import { expect, test } from "@playwright/test";

test.describe("Organization intelligence profiles", () => {
  test("creates a Fast profile from settings with a fallback chain", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Intelligence Profiles ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; id: string };

    await page.goto(`/${organization.issuePrefix}/organization/settings`);

    const panel = page.getByTestId("organization-intelligence-profiles");
    await expect(panel).toBeVisible();

    const fast = page.getByTestId("intelligence-profile-lightweight");
    await expect(fast.getByText("Fast", { exact: true })).toBeVisible();
    await expect(fast.getByText("Not configured", { exact: true })).toBeVisible();
    await expect(fast.getByText("gpt-5.4-mini", { exact: true })).toBeVisible();

    await fast.getByRole("button", { name: "Add fallback model" }).click();
    await expect(fast.getByText("Fallback 1", { exact: true })).toBeVisible();

    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().includes(`/api/orgs/${organization.id}/intelligence-profiles/lightweight`)
      && response.ok(),
    );
    await fast.getByRole("button", { name: "Create", exact: true }).click();
    const response = await saveResponse;
    const profile = await response.json() as {
      status: string;
      agentRuntimeConfig: Record<string, unknown>;
    };

    expect(profile.status).toBe("configured");
    expect(profile.agentRuntimeConfig.model).toBe("gpt-5.4-mini");
    expect(profile.agentRuntimeConfig.modelFallbacks).toEqual([
      expect.objectContaining({
        agentRuntimeType: "claude_local",
      }),
    ]);
    expect(profile.agentRuntimeConfig).not.toHaveProperty("promptTemplate");
    expect(profile.agentRuntimeConfig).not.toHaveProperty("instructionsFilePath");
    expect(profile.agentRuntimeConfig).not.toHaveProperty("cwd");

    await expect(fast.getByText("Ready", { exact: true })).toBeVisible();
    await expect(fast.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
    await expect(fast.getByText("Fallback 1", { exact: true })).toBeVisible();
  });
});
