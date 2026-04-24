import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Settings sidebar", () => {
  test("keeps fixed light mode even when the system prefers dark", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Fixed Light Theme ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await modal.getByRole("button", { name: "Light" }).click();

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
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.keyboard.press("ControlOrMeta+,");

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/organization/settings$`));
    await expect(page.getByTestId("settings-modal-shell")).toBeVisible();
  });

  test("shows org switching and system settings inside one sidebar", async ({ page }) => {
    const firstOrganizationName = `Alpha Sidebar ${Date.now()}`;
    const secondOrganizationName = `Beta Sidebar ${Date.now()}`;
    const createRes = await page.request.post("/api/orgs", {
      data: {
        name: firstOrganizationName,
      },
    });

    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json() as { id: string; issuePrefix: string };
    const secondOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: secondOrganizationName,
      },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json() as { id: string; issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);

    await page.getByRole("button", { name: "System settings" }).click();
    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/organization/settings$`));
    await expect(modalSidebar.locator('a[href$="/organization/settings"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/org"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/skills"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/costs"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/activity"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/instance/settings/profile"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/general"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/notifications"]')).toBeVisible();
    await expect(modalSidebar.locator('a[href$="/instance/settings/about"]')).toBeVisible();

    await modalSidebar.locator('a[href$="/instance/settings/general"]').click();

    await expect(page).toHaveURL(/\/instance\/settings\/general$/);
    await expect(modalSidebar.locator('a[href$="/organization/settings"]')).toHaveCount(0);
    await expect(modalSidebar.locator('a[href$="/instance/settings/profile"]')).toBeVisible();
    await expect(modal.getByRole("button", { name: firstOrganizationName })).toBeVisible();
    await expect(modal.getByRole("button", { name: secondOrganizationName })).toBeVisible();
    await modal.getByRole("button", { name: secondOrganizationName }).click();
    await expect(page).toHaveURL(new RegExp(`/${secondOrganization.issuePrefix}/organization/settings$`));
    await expect(modal).toBeVisible();
    const organizationNameInput = modal.locator('input[type="text"]').first();
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

  test("uses a compact modal with sentence-case labels and closes on outside click", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Modal Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

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
    await expect(modal.getByText("System settings")).toHaveCount(0);

    const modalBox = await modal.boundingBox();
    const viewport = page.viewportSize();
    expect(modalBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(modalBox!.width).toBeGreaterThan(940);
    expect(modalBox!.width).toBeLessThan(viewport!.width - 120);
    expect(modalBox!.y).toBeLessThan(viewport!.height * 0.4);

    const textTransform = await personalLabel.evaluate((element) => getComputedStyle(element).textTransform);
    expect(textTransform).not.toBe("uppercase");
    const backdropFilter = await backdrop.evaluate((element) => getComputedStyle(element).backdropFilter);
    expect(backdropFilter).not.toBe("none");

    const clickX = Math.max(8, modalBox!.x - 20);
    const clickY = modalBox!.y + 24;
    await page.mouse.click(clickX, clickY);

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`));
    await expect(modal).toHaveCount(0);
  });

  test("closes the settings modal on Escape", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Escape Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/organization/settings$`));
    await expect(modal).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`));
    await expect(modal).toHaveCount(0);
  });

  test("routes organization management through system settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Settings Organizations ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await modalSidebar.locator('a[href$="/instance/settings/organizations"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/organizations$/);
    await expect(modal.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "New Organization" })).toBeVisible();

    await page.goto(`/${organization.issuePrefix}/organizations`);
    await expect(page).toHaveURL(/\/instance\/settings\/organizations$/);
    await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();
  });

  test("plugin manager no longer lists the hello world example plugin", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Plugin Manager Examples ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const modalSidebar = modal.getByTestId("workspace-sidebar");

    await modalSidebar.locator('a[href$="/instance/settings/plugins"]').click();

    await expect(page).toHaveURL(/\/instance\/settings\/plugins$/);
    await expect(page.getByRole("heading", { name: "Plugin Manager" })).toBeVisible();
    await expect(page.getByText("File Browser (Example)", { exact: true })).toBeVisible();
    await expect(page.getByText("Kitchen Sink (Example)", { exact: true })).toBeVisible();
    await expect(page.getByText("Hello World Widget (Example)", { exact: true })).toHaveCount(0);
  });

  test("keeps the settings modal height stable across sidebar navigation", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Stable Settings Height ${Date.now()}`,
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

  test("shows the shared organization workspace as a fixed org path in organization settings", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Workspace Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/organization/settings$`));
    await expect(modal.getByText("Shared organization workspace")).toBeVisible();
    await expect(modal.getByText(/system-managed per organization/i)).toBeVisible();
    await expect(modal.getByText(/use workspaces to browse shared files, plans, and skill packages/i)).toBeVisible();
    await expect(modal.getByText(/use resources for canonical repos, docs, urls, and connectors/i)).toBeVisible();
    await expect(modal.getByPlaceholder("https://github.com/org/repo")).toHaveCount(0);
    await expect(modal.getByPlaceholder("/absolute/path/to/workspace")).toHaveCount(0);
    await expect(modal.getByRole("link", { name: "Open workspaces" })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("settings-org-workspace.png"),
      fullPage: true,
    });

    await modal.getByRole("link", { name: "Open workspaces" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/workspaces$`));
  });

  test("shows the about page with version and lifecycle actions", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `About Settings ${Date.now()}`,
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
    await expect(modal.getByText("App version")).toBeVisible();
    await expect(modal.locator("div").filter({ hasText: /^Environment$/ }).first()).toBeVisible();
    await expect(modal.locator("div").filter({ hasText: /^Instance ID$/ }).first()).toBeVisible();
    await expect(modal.getByRole("button", { name: "Check for updates" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Send Feedback" })).toBeVisible();
  });

  test("shows system permissions and keeps notification debug controls hidden", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `System Permissions Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    const notificationState = {
      desktopInboxNotifications: true,
      desktopDockBadge: true,
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
        };

        notificationState.desktopInboxNotifications =
          patch.desktopInboxNotifications ?? notificationState.desktopInboxNotifications;
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
    await expect(modal.getByText("Full Disk Access")).toBeVisible();
    await expect(modal.getByText("Accessibility")).toBeVisible();
    await expect(modal.getByText("Automation")).toBeVisible();
    await expect(modal.getByText("Notifications")).toBeVisible();
    await expect(modal.getByText("App icon badge")).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Toggle app icon badge" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Send test notification" })).toHaveCount(0);

    const inboxToggle = modal.getByRole("switch", { name: "Toggle inbox notifications" });
    await expect(inboxToggle).toHaveAttribute("aria-checked", "true");

    const saveInboxResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/notifications")
      && response.ok(),
    );
    await inboxToggle.click();
    await saveInboxResponse;
    await expect(inboxToggle).toHaveAttribute("aria-checked", "false");
  });

  test("saves local Langfuse settings and shows restart-required state", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Langfuse Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    const langfuseState = {
      enabled: false,
      baseUrl: "http://localhost:3000",
      publicKey: "",
      environment: "",
      secretKeyConfigured: false,
      managedByEnv: false,
    };
    await page.route("**/api/instance/settings/langfuse", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(langfuseState),
        });
        return;
      }

      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as {
          enabled?: boolean;
          baseUrl?: string;
          publicKey?: string;
          secretKey?: string;
          environment?: string;
          clearSecretKey?: boolean;
        };

        langfuseState.enabled = patch.enabled ?? langfuseState.enabled;
        langfuseState.baseUrl = patch.baseUrl ?? langfuseState.baseUrl;
        langfuseState.publicKey = patch.publicKey ?? langfuseState.publicKey;
        langfuseState.environment = patch.environment ?? langfuseState.environment;
        if (patch.clearSecretKey === true) {
          langfuseState.secretKeyConfigured = false;
        } else if (typeof patch.secretKey === "string" && patch.secretKey.trim().length > 0) {
          langfuseState.secretKeyConfigured = true;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(langfuseState),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");

    await sidebar.locator('a[href$="/instance/settings/langfuse"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/langfuse$/);
    await expect(modal.getByRole("heading", { name: "Langfuse", exact: true })).toBeVisible();

    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/instance/settings/langfuse")
      && response.ok(),
    );

    await modal.locator("#langfuse-base-url").fill("https://cloud.langfuse.com");
    await modal.locator("#langfuse-public-key").fill("pk-lf-e2e");
    await modal.locator("#langfuse-secret-key").fill("sk-lf-e2e");
    await modal.locator("#langfuse-environment").fill("playwright");
    await expect(modal.getByText("Automatic trace tags")).toBeVisible();
    await expect(modal.getByText(/instance:/)).toBeVisible();
    await expect(modal.getByText(/release:/)).toBeVisible();
    await modal.getByRole("button", { name: "Enable Langfuse tracing" }).click();
    await modal.getByRole("button", { name: "Save Langfuse settings" }).click();
    await saveResponse;

    await expect(modal.getByRole("heading", { name: "Restart required", exact: true })).toBeVisible();

    await sidebar.locator('a[href$="/instance/settings/general"]').click();
    await expect(modal.getByRole("heading", { name: "General" })).toBeVisible();
    await sidebar.locator('a[href$="/instance/settings/langfuse"]').click();

    await expect(modal.locator("#langfuse-base-url")).toHaveValue("https://cloud.langfuse.com");
    await expect(modal.locator("#langfuse-public-key")).toHaveValue("pk-lf-e2e");
    await expect(modal.locator("#langfuse-environment")).toHaveValue("playwright");
    await expect(modal.locator("#langfuse-secret-key")).toHaveValue("");
    await expect(modal.getByText("A secret key is already stored for this instance.")).toBeVisible();
  });

  test("shows Langfuse as env-managed and read-only when runtime env overrides are present", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Langfuse Env Managed ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.route("**/api/instance/settings/langfuse", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "blocked" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          baseUrl: "https://cloud.langfuse.com",
          publicKey: "pk-lf-env",
          environment: "env",
          secretKeyConfigured: true,
          managedByEnv: true,
        }),
      });
    });

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");
    await sidebar.locator('a[href$="/instance/settings/langfuse"]').click();

    await expect(modal.getByText("Managed by environment")).toBeVisible();
    await expect(modal.locator("#langfuse-base-url")).toBeDisabled();
    await expect(modal.locator("#langfuse-public-key")).toBeDisabled();
    await expect(modal.locator("#langfuse-secret-key")).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Save Langfuse settings" })).toBeDisabled();
  });

  test("opens the modal shell immediately and shows a skeleton while profile settings load", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Profile Settings Skeleton ${Date.now()}`,
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

  test("returns to the original workspace org after closing settings viewed on another org", async ({ page }) => {
    const firstOrganizationName = `Alpha Close ${Date.now()}`;
    const secondOrganizationName = `Beta Close ${Date.now()}`;
    const firstOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: firstOrganizationName,
      },
    });
    expect(firstOrgRes.ok()).toBe(true);
    const firstOrganization = await firstOrgRes.json() as { id: string; issuePrefix: string };

    const secondOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: secondOrganizationName,
      },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json() as { issuePrefix: string };

    await page.goto(`/${firstOrganization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await modal.getByRole("button", { name: secondOrganizationName }).click();
    await expect(page).toHaveURL(new RegExp(`/${secondOrganization.issuePrefix}/organization/settings$`));
    await expect.poll(async () =>
      page.evaluate(() => window.localStorage.getItem("rudder.selectedOrganizationId")),
    ).toBe(firstOrganization.id);

    const modalBox = await modal.boundingBox();
    expect(modalBox).not.toBeNull();
    const clickX = Math.max(8, modalBox!.x - 20);
    const clickY = modalBox!.y + 24;
    await page.mouse.click(clickX, clickY);

    await expect(page).toHaveURL(new RegExp(`/${firstOrganization.issuePrefix}/dashboard$`));
    await expect(modal).toHaveCount(0);
    await expect.poll(async () =>
      page.evaluate(() => window.localStorage.getItem("rudder.selectedOrganizationId")),
    ).toBe(firstOrganization.id);
  });

  test("keeps heartbeat actions fully visible inside the settings modal and allows disabling a heartbeat", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Heartbeat Settings ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

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
      },
    });
    expect(firstOrgRes.ok()).toBe(true);
    const firstOrganization = await firstOrgRes.json() as { id: string; issuePrefix: string };

    const secondOrgRes = await page.request.post("/api/orgs", {
      data: {
        name: secondOrganizationName,
      },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json() as { id: string; issuePrefix: string };

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

    await expect(page).toHaveURL(new RegExp(`/${secondOrganization.issuePrefix}/heartbeats$`));
    await expect(page.getByRole("link", { name: secondAgentName })).toBeVisible();
    await expect(page.getByTestId("settings-modal-shell")).toHaveCount(0);
  });

  test("hides the system-managed Rudder Copilot row from heartbeat settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Heartbeat Copilot Hidden ${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

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

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("Wake up the default copilot once.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Rudder Copilot", {
      timeout: 15_000,
    });

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
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/organization/settings$`));
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
