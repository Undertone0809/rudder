import { expect, test } from "@playwright/test";

test.describe("Profile context import", () => {
  test("imports reviewed AI provider context into the operator profile", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Profile Import ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await modal.locator('a[href$="/instance/settings/profile"]').click();
    await expect(modal.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();

    await modal.getByRole("button", { name: "Import from another AI" }).click();

    const providerExport = [
      "```markdown",
      "## Instructions",
      "[unknown] - Prefer concise, direct engineering feedback.",
      "",
      "## Projects",
      "[2026-05-05] - Rudder: orchestration and control platform for agent work.",
      "```",
    ].join("\n");

    await page.getByLabel("Imported profile context").fill(providerExport);
    await expect(page.getByLabel("Profile draft")).toHaveValue(/Instructions:/);
    await expect(page.getByLabel("Profile draft")).toHaveValue(/Projects:/);

    await page.getByRole("button", { name: "Apply to profile" }).click();

    const profileTextarea = modal.locator("#profile-more-about-you");
    await expect(profileTextarea).toHaveValue(/Prefer concise, direct engineering feedback\./);
    await expect(profileTextarea).toHaveValue(/Rudder: orchestration and control platform for agent work\./);

    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/profile")
      && response.ok(),
    );
    await modal.getByRole("button", { name: "Save profile" }).click();
    const response = await saveResponse;
    const savedProfile = await response.json() as { moreAboutYou: string };

    expect(savedProfile.moreAboutYou).toContain("Instructions:");
    expect(savedProfile.moreAboutYou).toContain("Prefer concise, direct engineering feedback.");
    expect(savedProfile.moreAboutYou).toContain("Projects:");
  });
});
