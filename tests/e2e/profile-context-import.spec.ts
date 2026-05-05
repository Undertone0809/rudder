import { expect, test } from "@playwright/test";

test.describe("Profile context import", () => {
  test("saves pasted AI provider context through More about you", async ({ page }) => {
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

    await expect(modal.getByText("Import memories from another AI")).toBeVisible();
    await expect(modal.getByText(/paste the exported memory below/i)).toBeVisible();
    await expect(modal.getByRole("button", { name: "Copy memory import prompt" })).toBeVisible();

    const providerExport = [
      "```markdown",
      "## Instructions",
      "[unknown] - Prefer concise, direct engineering feedback.",
      "",
      "## Projects",
      "[2026-05-05] - Rudder: orchestration and control platform for agent work.",
      "```",
    ].join("\n");

    const profileTextarea = modal.locator("#profile-more-about-you");
    await profileTextarea.fill(providerExport);
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

    expect(savedProfile.moreAboutYou).toContain("## Instructions");
    expect(savedProfile.moreAboutYou).toContain("Prefer concise, direct engineering feedback.");
    expect(savedProfile.moreAboutYou).toContain("## Projects");
  });
});
