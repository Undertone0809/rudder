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
      "[2026-05-05] - Rudder: assign, run, review, and improve agent work.",
      "```",
    ].join("\n");

    const profileTextarea = modal.locator("#profile-more-about-you");
    await profileTextarea.fill(providerExport);
    await expect(profileTextarea).toHaveValue(/Prefer concise, direct engineering feedback\./);
    await expect(profileTextarea).toHaveValue(/Rudder: assign, run, review, and improve agent work\./);

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

  test("uses the signed-in user's account avatar in activity", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Profile Avatar ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const accessRes = await page.request.get("/api/cli-auth/me");
    expect(accessRes.ok()).toBe(true);
    const access = await accessRes.json() as { user?: { id: string } | null; userId: string };
    const userId = access.user?.id ?? access.userId;
    const avatar = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIzMiIgZmlsbD0iIzE0YjhhNiIvPjx0ZXh0IHg9IjMyIiB5PSI0MiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjgiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNmZmZmZmYiPkE8L3RleHQ+PC9zdmc+";

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Account avatar activity label",
        description: "Activity should use the account avatar.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);

    await page.addInitScript(({ accountId, image }) => {
      const account = { id: accountId, email: "avatar@example.com", name: "Avatar User", image };
      const state = { status: "signed-in", account, deviceId: "activity-avatar-device" };
      Object.defineProperty(window, "desktopIdentity", {
        configurable: true,
        value: {
          getState: async () => state,
          getProfile: async () => account,
          onStateChanged: () => () => undefined,
        },
      });
    }, { accountId: userId, image: avatar });

    await page.goto(`/${organization.issuePrefix}/activity`);

    const activityRow = page.getByRole("link", { name: /created .*Account avatar activity label/ });
    await expect(activityRow).toBeVisible({ timeout: 15_000 });
    await expect(activityRow.locator(`img[src="${avatar}"]`)).toBeVisible();
  });
});
