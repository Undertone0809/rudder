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

  test("uses the saved nickname for current-user activity labels", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Profile Nickname ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const profileRes = await page.request.patch("/api/instance/settings/profile", {
      data: {
        nickname: "Wanhu",
      },
    });
    expect(profileRes.ok()).toBe(true);

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Nickname activity label",
        description: "Activity should use the operator nickname.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);

    await page.goto(`/${organization.issuePrefix}/activity`);

    const activityRow = page.getByRole("link", { name: /Wanhu created .*Nickname activity label/ });
    await expect(activityRow).toBeVisible({ timeout: 15_000 });
    await expect(activityRow).toContainText("Wanhu");
    await expect(activityRow).toContainText("created");
    await expect(activityRow).not.toContainText("You");
  });
});
