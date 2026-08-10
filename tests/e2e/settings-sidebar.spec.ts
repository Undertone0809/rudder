import { expect, test } from "@playwright/test";

let issuePrefixSequence = 0;

function uniqueIssuePrefix() {
  issuePrefixSequence += 1;
  return `S${Date.now().toString(36).slice(-7)}${issuePrefixSequence.toString(36)}`
    .toUpperCase()
    .slice(0, 12);
}

test.describe("Settings sidebar", () => {
  test("does not reopen settings from stale Organization rail and workspace memory", async ({ page }) => {
    const otherOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Legacy Organization Rail Source ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(otherOrgRes.ok()).toBe(true);
    const otherOrganization = await otherOrgRes.json() as {
      id: string;
      name: string;
      urlKey: string;
    };
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Legacy Organization Rail ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      name: string;
      issuePrefix: string;
      urlKey: string;
    };

    await page.goto(`/${otherOrganization.urlKey}/messenger`);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.lastWorkspacePath", "/org?legacy=1#old");
      window.localStorage.setItem("rudder.primaryRailLastPaths", JSON.stringify({
        [orgId]: { organization: "/org?legacy=1#old" },
      }));
      window.localStorage.setItem("rudder.organizationPaths", JSON.stringify({
        [orgId]: "/org?legacy=1#old",
      }));
    }, organization.id);
    await page.reload();

    await page.getByRole("button", { name: "Organization menu" }).click();
    const organizationMenuItem = page
      .getByRole("menu", { name: "Organization menu" })
      .getByRole("menuitem")
      .filter({ hasText: organization.name });
    await expect(organizationMenuItem).toBeVisible();
    await organizationMenuItem.click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/messenger$`));
    await expect(page.getByTestId("settings-modal-shell")).toHaveCount(0);

    await page.getByTestId("primary-rail").getByRole("link", { name: "Organization" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/dashboard$`));
    await expect(page.getByTestId("settings-modal-shell")).toHaveCount(0);

    await page.evaluate(() => {
      window.localStorage.setItem("rudder.lastWorkspacePath", "/org?legacy=1#old");
    });
    await page.goto(`/${organization.urlKey}/org?legacy=1#old`);
    const modal = page.getByTestId("settings-modal-shell");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Close settings" }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/messenger(?:/chat)?(?:[/?#]|$)`));
    await expect(modal).toHaveCount(0);
  });

  test("keeps organization import and export in settings after Structure removal", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Portability Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
      urlKey: string;
    };

    await page.goto(`/${organization.issuePrefix}/organization/settings`);

    const settingsPage = page.getByTestId("organization-settings-page");
    await expect(settingsPage).toBeVisible();
    await settingsPage.getByRole("tab", { name: "Access & data" }).click();
    await expect(settingsPage.getByRole("link", { name: "Export", exact: true })).toBeVisible();
    await expect(settingsPage.getByRole("link", { name: "Import", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-sidebar").getByRole("link", { name: "Structure" })).toHaveCount(0);

    await page.goto(`/${organization.issuePrefix}/org`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await expect(page.getByTestId("organization-settings-page")).toBeVisible();

    const removedTreeResponse = await page.request.get(`/api/orgs/${organization.id}/org`);
    expect(removedTreeResponse.status()).toBe(404);

    await page.goto(`/${organization.issuePrefix}/agents/new`);
    await expect(page.getByText("Reports to", { exact: true })).toHaveCount(0);

    const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Independent Agent",
        role: "general",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      },
    });
    expect(agentResponse.ok()).toBe(true);
    const agent = await agentResponse.json() as Record<string, unknown>;
    expect(agent).not.toHaveProperty("reportsTo");
  });

  test("keeps fixed light mode even when the system prefers dark", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Fixed Light Theme ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await modal.locator('a[href$="/instance/settings/appearance"]').click();
    await modal.getByRole("button", { name: /^Light Warm paper surfaces$/ }).click();

    await expect.poll(async () =>
      page.evaluate(() => ({
        theme: window.localStorage.getItem("rudder.theme"),
        darkClass: document.documentElement.classList.contains("dark"),
        colorScheme: document.documentElement.style.colorScheme,
      })),
    ).toEqual({
      theme: "light",
      darkClass: false,
      colorScheme: "light",
    });
  });

  test("opens settings from keyboard shortcut on all platforms", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Settings Shortcut ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.keyboard.press("ControlOrMeta+,");

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await expect(page.getByTestId("settings-modal-shell")).toBeVisible();
  });

  test("shows org switching and system settings inside one sidebar", async ({ page }) => {
    const firstOrganizationName = `Alpha Sidebar ${Date.now()}`;
    const secondOrganizationName = `Beta Sidebar ${Date.now()}`;
    const createRes = await page.request.post("/api/orgs", {
      data: {
        name: firstOrganizationName,
        issuePrefix: uniqueIssuePrefix(),
      },
    });

    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json() as { id: string; issuePrefix: string; urlKey: string };
    const secondOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: secondOrganizationName,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);

    await page.getByRole("button", { name: "System settings" }).click();
    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await expect(modalSidebar.locator('a[href$="/organization/settings"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/org"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/skills"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/costs"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/activity"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/instance/settings/profile"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/shortcuts"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/general"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/notifications"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/organizations"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/instance/settings/about"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/experimental"]')).toHaveCount(0);

    await modalSidebar.locator('a[href$="/instance/settings/general"]').click();

    await expect(page).toHaveURL(/\/instance\/settings\/general$/);
    await expect(modalSidebar.locator('a[href$="/organization/settings"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/instance/settings/profile"]')).toBeVisible();
    await expect(modal.getByRole("button", { name: firstOrganizationName })).toBeVisible();
    await expect(modal.getByRole("button", { name: secondOrganizationName })).toBeVisible();
    await modal.getByRole("button", { name: secondOrganizationName }).click();
    await expect(page).toHaveURL(new RegExp(`/${secondOrganization.urlKey}/organization/settings$`));
    await expect(modal).toBeVisible();
    await modal.getByRole("tab", { name: "General", exact: true }).click();
    const organizationNameInput = modal.getByRole("textbox", { name: "Organization name", exact: true });
    await expect(organizationNameInput).toHaveValue(secondOrganizationName);
    await expect.poll(async () =>
      page.evaluate(() => window.localStorage.getItem("rudder.selectedOrganizationId")),
    ).toBe(organization.id);

    const renamedSecondOrganization = `${secondOrganizationName} Renamed`;
    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${secondOrganization.id}`)
      && response.ok(),
    );
    await organizationNameInput.fill(renamedSecondOrganization);
    await modal.getByRole("button", { name: "Save changes" }).click();
    await saveResponse;
    await expect(organizationNameInput).toHaveValue(renamedSecondOrganization);
    await expect.poll(async () =>
      page.evaluate(() => window.localStorage.getItem("rudder.selectedOrganizationId")),
    ).toBe(organization.id);
  });

  test("scrolls a long organization list inside the settings modal sidebar", async ({ page }) => {
    const organizationNames = Array.from(
      { length: 14 },
      (_, index) => `Scrollable Settings ${Date.now()} ${index.toString().padStart(2, "0")}`,
    );
    const organizations: Array<{ issuePrefix: string }> = [];

    for (const name of organizationNames) {
      const response = await page.request.post("/api/orgs", {
        data: {
          name,
          issuePrefix: uniqueIssuePrefix(),
        },
      });
      expect(response.ok()).toBe(true);
      organizations.push(await response.json() as { issuePrefix: string });
    }

    await page.goto(`/${organizations[0]!.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const navigation = modal.getByTestId("workspace-sidebar").locator("nav");
    const lastOrganization = modal.getByRole("button", {
      name: organizationNames.at(-1)!,
    });

    await expect(lastOrganization).toBeAttached();
    await expect.poll(
      () => navigation.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    expect(await navigation.evaluate((element) => element.scrollTop)).toBe(0);

    await navigation.hover();
    await page.mouse.wheel(0, 10_000);

    await expect.poll(() => navigation.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(lastOrganization).toBeVisible();
  });

  test("uses a compact modal with sentence-case labels and closes on outside click", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Modal Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('aside a[href$="/instance/settings/general"]').click();

    const modal = page.getByTestId("settings-modal-shell");
    const backdrop = page.getByTestId("settings-modal-backdrop");
    const workspaceShell = page.getByTestId("workspace-shell");
    const personalLabel = page.getByText("Personal").first();

    await expect(modal).toBeVisible();
    await expect(backdrop).toBeVisible();
    await expect(workspaceShell).toBeVisible();
    await expect(personalLabel).toBeVisible();
    await expect(modal.getByRole("heading", { name: "System settings", exact: true })).toHaveClass(/sr-only/);

    const modalBox = await modal.boundingBox();
    const viewport = page.viewportSize();
    expect(modalBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(modalBox!.width).toBeGreaterThan(940);
    expect(modalBox!.width).toBeLessThanOrEqual(Math.min(1440, viewport!.width - 32));
    expect(modalBox!.y).toBeLessThan(viewport!.height * 0.4);

    const textTransform = await personalLabel.evaluate((element) => getComputedStyle(element).textTransform);
    expect(textTransform).not.toBe("uppercase");
    const backdropFilter = await backdrop.evaluate((element) => getComputedStyle(element).backdropFilter);
    expect(backdropFilter).toContain("blur(30px)");
    await expect(workspaceShell).toBeVisible();

    const clickX = Math.max(8, modalBox!.x - 20);
    const clickY = modalBox!.y + 24;
    await page.mouse.click(clickX, clickY);

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/dashboard$`));
    await expect(modal).toHaveCount(0);
  });

  test("persists developer diagnostics from general settings", async ({ page }) => {
    await page.request.patch("/api/instance/settings/general", {
      data: { showDeveloperDiagnostics: false },
    });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Developer Diagnostics ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('aside a[href$="/instance/settings/general"]').click();

    const modal = page.getByTestId("settings-modal-shell");
    const diagnosticsSwitch = modal.getByRole("switch", { name: "Toggle developer diagnostics" });
    await expect(modal.getByText("Show developer diagnostics")).toBeVisible();
    await expect(diagnosticsSwitch).toHaveAttribute("aria-checked", "false");

    const updateResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/general")
      && response.ok(),
    );
    await diagnosticsSwitch.click();
    await updateResponse;

    await expect(diagnosticsSwitch).toHaveAttribute("aria-checked", "true");
    const settingsResponse = await page.request.get("/api/instance/settings/general");
    expect(settingsResponse.ok()).toBe(true);
    expect(await settingsResponse.json()).toMatchObject({
      showDeveloperDiagnostics: true,
    });
  });

  test("closes the settings modal on Escape", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Escape Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await expect(modal).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/dashboard$`));
    await expect(modal).toHaveCount(0);
  });

  test("redirects legacy organizations routes to organization settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Settings Organizations ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await expect(modalSidebar.locator('a[href$="/instance/settings/organizations"]')).toHaveCount(0);

    await page.goto(`/${organization.issuePrefix}/organizations`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await expect(page.getByRole("heading", { name: "Organization Settings", exact: true })).toBeVisible();
  });

  test("plugin manager no longer lists the hello world example plugin", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Plugin Manager Examples ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await modalSidebar.locator('a[href$="/instance/settings/plugins"]').click();

    await expect(page).toHaveURL(/\/instance\/settings\/plugins$/);
    await expect(page.getByRole("heading", { name: "Plugin Manager" })).toBeVisible();
    await expect(page.getByText("File Browser (Example)", { exact: true })).toBeVisible();
    await expect(page.getByText("Kitchen Sink (Example)", { exact: true })).toBeVisible();
    const linearRow = page.locator("li").filter({ hasText: "@rudderhq/plugin-linear" }).first();
    await expect(linearRow).toBeVisible();
    await expect(linearRow.getByText("Example", { exact: true })).toHaveCount(0);
    await expect(linearRow.getByRole("button", { name: "Install Example" })).toHaveCount(0);
    await expect(page.getByText("Hello World Widget (Example)", { exact: true })).toHaveCount(0);
  });

  test("keeps the settings modal height stable across sidebar navigation", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Stable Settings Height ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await modalSidebar.locator('a[href$="/instance/settings/profile"]').click();
    await expect(modal.getByRole("heading", { name: "Profile" })).toBeVisible();
    const profileBox = await modal.boundingBox();

    await modalSidebar.locator('a[href$="/instance/settings/about"]').click();
    await expect(modal.getByRole("heading", { name: "About" })).toBeVisible();
    const aboutBox = await modal.boundingBox();

    await modalSidebar.locator('a[href$="/instance/settings/general"]').click();
    await expect(modal.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(modal.getByText("Theme behavior", { exact: true })).toHaveCount(0);
    await expect(
      modal.getByText(
        "Theme changes are stored locally in your browser. Auto follows the operating system appearance instead of forcing a fixed light or dark mode.",
        { exact: true },
      ),
    ).toHaveCount(0);
    const generalBox = await modal.boundingBox();

    expect(profileBox).not.toBeNull();
    expect(aboutBox).not.toBeNull();
    expect(generalBox).not.toBeNull();

    const referenceHeight = Math.round(profileBox!.height);
    expect(Math.round(aboutBox!.height)).toBe(referenceHeight);
    expect(Math.round(generalBox!.height)).toBe(referenceHeight);
  });

  test("shows the shared organization Library as a fixed org path in organization settings", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await modal.getByRole("tab", { name: "Workspace", exact: true }).click();
    await expect(modal.getByRole("heading", { name: "Shared organization Library", exact: true })).toBeVisible();
    await expect(modal.getByText(/system-managed per organization/i)).toBeVisible();
    await expect(modal.getByText(/use Library to browse shared files, plans, and skill packages/i)).toBeVisible();
    await expect(modal.getByPlaceholder("https://github.com/org/repo")).toHaveCount(0);
    await expect(modal.getByPlaceholder("/absolute/path/to/workspace")).toHaveCount(0);
    await expect(modal.getByRole("link", { name: "Open Library" })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("settings-org-workspace.png"),
      fullPage: true,
    });

    await modal.getByRole("link", { name: "Open Library" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/library$`));
  });

  test("shows the about page with version and lifecycle actions", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `About Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/about"]').click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(/\/instance\/settings\/about$/);
    await expect(modal.getByRole("heading", { name: "About" })).toBeVisible();
    await expect(modal.locator("div").filter({ hasText: /^Version$/ }).first()).toBeVisible();
    await expect(modal.locator("div").filter({ hasText: /^Environment$/ }).first()).toBeVisible();
    await expect(modal.locator("div").filter({ hasText: /^Instance ID$/ }).first()).toBeVisible();
    await expect(modal.getByRole("button", { name: "Check for updates" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Send Feedback" })).toBeVisible();
  });

  test("shows a download-style toast when a desktop update is available", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          getBootState: async () => ({
            runtime: { version: "0.2.24", mode: "owned", ownerKind: "desktop" },
            paths: { instanceRoot: "/tmp/rudder-e2e" },
          }),
          onBootState: () => () => {},
          getAppVersion: async () => "0.2.24",
          checkForUpdates: async () => ({
            status: "update-available",
            channel: "stable",
            currentVersion: "0.2.24",
            latestVersion: "0.2.25",
            checkedAt: "2026-05-06T00:00:00.000Z",
          }),
          installUpdate: async (version: string) => {
            (window as typeof window & { __rudderInstallUpdateCalls?: string[] }).__rudderInstallUpdateCalls = [
              ...((window as typeof window & { __rudderInstallUpdateCalls?: string[] }).__rudderInstallUpdateCalls ?? []),
              version,
            ];
            return { status: "started", version };
          },
          openExternal: async () => {},
          sendFeedback: async () => {},
        },
      });
    });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Desktop Update Toast ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/about"]').click();

    await page.getByRole("button", { name: "Check for updates" }).click();

    const toast = page.locator("aside").filter({ hasText: "New version available" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("v0.2.25 is ready to download.");
    await expect(toast).toHaveClass(/bottom-4/);
    await expect(toast).toHaveClass(/right-4/);

    await toast.getByRole("button", { name: "Download update" }).click();

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderInstallUpdateCalls?: string[] }).__rudderInstallUpdateCalls ?? []
    ))).toEqual(["0.2.25"]);
  });

  test("shows a queued update toast when active runs defer installation", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          getBootState: async () => ({
            runtime: { version: "0.2.24", mode: "owned", ownerKind: "desktop" },
            paths: { instanceRoot: "/tmp/rudder-e2e" },
          }),
          onBootState: () => () => {},
          getAppVersion: async () => "0.2.24",
          checkForUpdates: async () => ({
            status: "update-available",
            channel: "stable",
            currentVersion: "0.2.24",
            latestVersion: "0.2.25",
            checkedAt: "2026-05-06T00:00:00.000Z",
          }),
          installUpdate: async () => ({
            status: "waiting",
            version: "0.2.25",
            totalRuns: 2,
            message: "Rudder is downloading v0.2.25 and will update after 2 active runs finish.",
          }),
          openExternal: async () => {},
          sendFeedback: async () => {},
        },
      });
    });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Desktop Deferred Update ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/about"]').click();

    await page.getByRole("button", { name: "Check for updates" }).click();
    const availableToast = page.locator("aside").filter({ hasText: "New version available" });
    await expect(availableToast).toBeVisible();
    await availableToast.getByRole("button", { name: "Download update" }).click();

    const queuedToast = page.locator("aside").filter({ hasText: "Update queued" });
    await expect(queuedToast).toBeVisible();
    await expect(queuedToast).toContainText("after 2 active run(s) finish");
  });


  test("shows system permissions and keeps notification debug controls hidden", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `System Permissions Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    const notificationState = {
      desktopInboxNotifications: true,
      desktopDockBadge: true,
      desktopIssueNotifications: true,
      desktopChatNotifications: true,
    };

    await page.route("**/api/instance/settings/notifications", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(notificationState),
        });
        return;
      }

      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as {
          desktopInboxNotifications?: boolean;
          desktopDockBadge?: boolean;
          desktopIssueNotifications?: boolean;
          desktopChatNotifications?: boolean;
        };

        notificationState.desktopIssueNotifications =
          patch.desktopIssueNotifications ?? patch.desktopInboxNotifications ?? notificationState.desktopIssueNotifications;
        notificationState.desktopChatNotifications =
          patch.desktopChatNotifications ?? notificationState.desktopChatNotifications;
        notificationState.desktopInboxNotifications =
          patch.desktopInboxNotifications ?? patch.desktopIssueNotifications ?? notificationState.desktopInboxNotifications;
        notificationState.desktopDockBadge =
          patch.desktopDockBadge ?? notificationState.desktopDockBadge;

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(notificationState),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");

    await sidebar.locator('a[href$="/instance/settings/notifications"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/notifications$/);
    await expect(modal.getByRole("heading", { name: "System permissions", exact: true })).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Full Disk Access", exact: true })).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Accessibility", exact: true })).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Automation", exact: true })).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
    await expect(modal.getByText("System notification access")).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Issue notifications", exact: true })).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Chat notifications", exact: true })).toBeVisible();
    await expect(modal.getByText("Checking")).toHaveCount(0);
    await expect(modal.getByText("Per app")).toHaveCount(0);
    await expect(modal.getByText("Unknown")).toHaveCount(0);
    await expect(modal.getByText("System managed")).toHaveCount(0);
    await expect(modal.getByText("App icon badge")).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Toggle app icon badge" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Send test notification" })).toHaveCount(0);

    const issueToggle = modal.getByRole("switch", { name: "Toggle issue notifications" });
    const chatToggle = modal.getByRole("switch", { name: "Toggle chat notifications" });
    await expect(issueToggle).toHaveAttribute("aria-checked", "true");
    await expect(chatToggle).toHaveAttribute("aria-checked", "true");

    const saveIssueResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/notifications")
      && response.ok(),
    );
    await issueToggle.click();
    await saveIssueResponse;
    await expect(issueToggle).toHaveAttribute("aria-checked", "false");
  });

  test("shows plugins as the only built-in integration setting", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Integration Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");
    const integrationSection = sidebar.getByText("Integrations", { exact: true }).locator("..");

    await expect(integrationSection.getByRole("link", { name: "Plugins", exact: true })).toBeVisible();
    await expect(integrationSection.getByRole("link")).toHaveCount(1);
  });

  test("opens the modal shell immediately and shows a skeleton while profile settings load", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Profile Settings Skeleton ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    let releaseProfileResponse: (() => void) | null = null;
    await page.route("**/api/instance/settings/profile", async (route) => {
      await new Promise<void>((resolve) => {
        releaseProfileResponse = resolve;
      });
      await route.continue();
    });

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(modal).toBeVisible();
    await modal.locator('a[href$="/instance/settings/profile"]').click();

    await expect(page).toHaveURL(/\/instance\/settings\/profile$/);
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId("settings-page-skeleton")).toBeVisible();

    expect(releaseProfileResponse).not.toBeNull();
    releaseProfileResponse?.();

    await expect(modal.getByRole("button", { name: "Save" })).toBeVisible();
  });

  test("combines profile and account settings under one Personal destination", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Combined Profile Account ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");
    const profileLink = sidebar.locator('a[href$="/instance/settings/profile"]');

    await expect(profileLink).toHaveText("Profile");
    await expect(sidebar.locator('a[href$="/instance/settings/account"]')).toHaveCount(0);
    await profileLink.click();

    await expect(modal.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
    await expect(modal.getByText("About you", { exact: true })).toBeVisible();
    await expect(modal.getByText("Rudder Account", { exact: true })).toBeVisible();
    await expect(modal.getByText("Manage your operator profile, Rudder Account, and signed-in devices.")).toHaveCount(0);
    await expect(modal.getByText(/Use the same lightweight profile structure/)).toHaveCount(0);
    await expect(modal.getByText(/preferred form of address in chat/)).toHaveCount(0);

    await page.evaluate(() => {
      const currentState = window.history.state as {
        idx?: number;
        key?: string;
        usr?: unknown;
      } | null;
      const nextState = {
        ...currentState,
        idx: (currentState?.idx ?? 0) + 1,
      };
      window.history.pushState(nextState, "", "/instance/settings/account?source=legacy#devices");
      window.dispatchEvent(new PopStateEvent("popstate", { state: nextState }));
    });

    await expect(page).toHaveURL(/\/instance\/settings\/profile\?source=legacy#devices$/);
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();

    await modal.getByRole("button", { name: "Close settings" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/dashboard$`, "i"));
    await expect(modal).toHaveCount(0);
  });

  test("returns to the original workspace org after closing settings viewed on another org", async ({ page }) => {
    const firstOrganizationName = `Alpha Close ${Date.now()}`;
    const secondOrganizationName = `Beta Close ${Date.now()}`;
    const firstOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: firstOrganizationName,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(firstOrgRes.ok()).toBe(true);
    const firstOrganization = await firstOrgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const secondOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: secondOrganizationName,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json() as { issuePrefix: string; urlKey: string };

    await page.goto(`/${firstOrganization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await modal.getByRole("button", { name: secondOrganizationName }).click();
    await expect(page).toHaveURL(new RegExp(`/${secondOrganization.urlKey}/organization/settings$`));
    await expect.poll(async () =>
      page.evaluate(() => window.localStorage.getItem("rudder.selectedOrganizationId")),
    ).toBe(firstOrganization.id);

    const modalBox = await modal.boundingBox();
    expect(modalBox).not.toBeNull();
    const clickX = Math.max(8, modalBox!.x - 20);
    const clickY = modalBox!.y + 24;
    await page.mouse.click(clickX, clickY);

    await expect(page).toHaveURL(new RegExp(`/${firstOrganization.urlKey}/dashboard$`));
    await expect(modal).toHaveCount(0);
    await expect.poll(async () =>
      page.evaluate(() => window.localStorage.getItem("rudder.selectedOrganizationId")),
    ).toBe(firstOrganization.id);
  });

  test("keeps heartbeat actions fully visible inside the settings modal and allows disabling a heartbeat", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Heartbeat Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const agentName = `Heartbeat Toggle Agent ${Date.now()}`;
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: agentName,
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          heartbeat: {
            enabled: true,
            intervalSec: 300,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/heartbeats"]').click();

    const row = page.locator('[data-testid="heartbeat-agent-row"]').filter({
      has: page.getByRole("link", { name: agentName }),
    });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "On" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Off" })).toBeVisible();
    const rowOverflow = await row.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(rowOverflow).toBeLessThanOrEqual(1);

    const disableResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/agents/${agent.id}`)
      && response.ok(),
    );
    await row.getByRole("button", { name: "Off" }).click();
    await disableResponse;
    await expect(row.getByText("Disabled")).toBeVisible();
  });

  test("opens the selected organization's heartbeat page from the settings heartbeat group header", async ({ page }, testInfo) => {
    const firstOrganizationName = `Heartbeat Link Alpha ${Date.now()}`;
    const secondOrganizationName = `Heartbeat Link Beta ${Date.now()}`;
    const firstAgentName = `Heartbeat Link Agent A ${Date.now()}`;
    const secondAgentName = `Heartbeat Link Agent B ${Date.now()}`;

    const firstOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: firstOrganizationName,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(firstOrgRes.ok()).toBe(true);
    const firstOrganization = await firstOrgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const secondOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: secondOrganizationName,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const firstAgentRes = await page.request.post(`/api/orgs/${firstOrganization.id}/agents`, {
      data: {
        name: firstAgentName,
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          heartbeat: {
            enabled: true,
            intervalSec: 300,
          },
        },
      },
    });
    expect(firstAgentRes.ok()).toBe(true);

    const secondAgentRes = await page.request.post(`/api/orgs/${secondOrganization.id}/agents`, {
      data: {
        name: secondAgentName,
        role: "designer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          heartbeat: {
            enabled: true,
            intervalSec: 300,
          },
        },
      },
    });
    expect(secondAgentRes.ok()).toBe(true);

    await page.goto(`/${firstOrganization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/heartbeats"]').click();

    const targetHeaderLink = page.getByRole("link", { name: secondOrganizationName }).first();
    await expect(targetHeaderLink).toBeVisible();
    await targetHeaderLink.hover();
    await page.screenshot({
      path: testInfo.outputPath("settings-heartbeats-org-link.png"),
      fullPage: true,
    });

    await targetHeaderLink.click();

    await expect(page).toHaveURL(new RegExp(`/${secondOrganization.urlKey}/heartbeats$`));
    await expect(page.getByRole("link", { name: secondAgentName })).toBeVisible();
    await expect(page.getByTestId("settings-modal-shell")).toHaveCount(0);
  });

  test("hides legacy system-managed chat agents from heartbeat settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Heartbeat Hidden Chat Agent ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const agentName = `Visible Heartbeat Agent ${Date.now()}`;
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: agentName,
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          heartbeat: {
            enabled: true,
            intervalSec: 300,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);

    const hiddenAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Rudder Copilot (system)",
        title: "System-managed chat copilot",
        role: "general",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          heartbeat: {
            enabled: true,
            intervalSec: 300,
          },
        },
        metadata: { hidden: true, systemManaged: "rudder_copilot" },
      },
    });
    expect(hiddenAgentRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    await page.locator('a[href$="/instance/settings/heartbeats"]').click();

    const visibleRow = page.locator('[data-testid="heartbeat-agent-row"]').filter({
      has: page.getByRole("link", { name: agentName }),
    });
    await expect(visibleRow).toBeVisible();
    await expect(page.getByText("Rudder Copilot (system)", { exact: true })).toHaveCount(0);
    await expect(page.getByText("System-managed chat copilot", { exact: true })).toHaveCount(0);
  });

  test("manages issue labels from organization settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Label Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/organization/settings$`));
    await modal.getByRole("tab", { name: "Workspace", exact: true }).click();
    await expect(modal.getByText("Issue label management")).toBeVisible();

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/labels`)
      && response.ok(),
    );
    await modal.getByPlaceholder("New label").fill("Operations");
    await modal.getByRole("button", { name: "Add label" }).click();
    await createResponse;

    const operationsInput = modal.getByRole("textbox", { name: "Label name for Operations" });
    await expect(operationsInput).toBeVisible();
    await expect(modal.getByRole("button", { name: "Save label Operations" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Delete label Operations" })).toBeVisible();

    const updateResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && /\/api\/labels\/.+/.test(response.url())
      && response.ok(),
    );
    await operationsInput.fill("Ops");
    await expect(modal.getByRole("button", { name: "Save label Ops" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Delete label Operations" })).toHaveCount(0);
    await modal.getByRole("button", { name: "Save label Ops" }).click();
    await updateResponse;
    await expect(modal.getByRole("textbox", { name: "Label name for Ops" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Save label Ops" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Delete label Ops" })).toBeVisible();

    const deleteResponse = page.waitForResponse((response) =>
      response.request().method() === "DELETE"
      && /\/api\/labels\/.+/.test(response.url())
      && response.ok(),
    );
    await modal.getByRole("button", { name: "Delete label Ops" }).click();
    await deleteResponse;
    await expect(modal.getByRole("textbox", { name: "Label name for Ops" })).toHaveCount(0);
  });

});
