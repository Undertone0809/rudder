import { expect, test, type Locator, type Page } from "@playwright/test";

async function installDesktopShellStub(page: Page, pickedPath: string) {
  await page.addInitScript((selectedPath) => {
    const desktopShell = {
      getBootState: async () => ({}),
      onBootState: () => () => {},
      openPath: async () => {},
      copyText: async () => {},
      setAppearance: async () => {},
      restart: async () => {},
      getAppVersion: async () => "0.0.0-test",
      checkForUpdates: async () => ({
        status: "unavailable",
        currentVersion: "0.0.0-test",
        checkedAt: "1970-01-01T00:00:00.000Z",
      }),
      sendFeedback: async () => {},
      openExternal: async () => {},
      openNotificationSettings: async () => ({ opened: false, platform: "darwin" }),
      setBadgeCount: async () => {},
      showNotification: async () => {},
      pickPath: async () => ({ canceled: false, path: selectedPath }),
    };

    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: desktopShell,
    });
  }, pickedPath);
}

async function computedBorderRadius(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).borderRadius);
}

function parseRgbChannels(value: string): [number, number, number] {
  const match = value.match(/\d+(?:\.\d+)?/g);
  if (!match || match.length < 3) {
    throw new Error(`Unable to parse RGB value: ${value}`);
  }
  return [
    Number.parseFloat(match[0]!),
    Number.parseFloat(match[1]!),
    Number.parseFloat(match[2]!),
  ];
}

function srgbToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function perceptualLightness(value: string): number {
  if (value.startsWith("oklab(")) {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) throw new Error(`Unable to parse oklab value: ${value}`);
    return Number.parseFloat(match[0]!);
  }
  if (value.startsWith("rgb")) {
    const [r, g, b] = parseRgbChannels(value);
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }
  throw new Error(`Unsupported color format: ${value}`);
}

test.describe("Primary rail create menu", () => {
  test("shows icons for chat, issue, agent, and project creation actions", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/inbox/recent");

    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();

    const chatItem = page.getByRole("menuitem", { name: "Create new chat" });
    const issueItem = page.getByRole("menuitem", { name: "Create new issue" });
    const agentItem = page.getByRole("menuitem", { name: "Create new agent" });
    const projectItem = page.getByRole("menuitem", { name: "Create new project" });

    await expect(chatItem).toBeVisible();
    await expect(issueItem).toBeVisible();
    await expect(agentItem).toBeVisible();
    await expect(projectItem).toBeVisible();

    await expect(chatItem.locator("svg")).toHaveCount(1);
    await expect(issueItem.locator("svg")).toHaveCount(1);
    await expect(agentItem.locator("svg")).toHaveCount(1);
    await expect(projectItem.locator("svg")).toHaveCount(1);
  });

  test("opens the new issue dialog with a standard scrim instead of settings-style blur", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Dialog-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/inbox/recent");
    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    const overlay = page.locator('[data-slot="dialog-overlay"]').first();

    await expect(dialog).toBeVisible();
    await expect(overlay).toBeVisible();

    const overlayBackdropFilter = await overlay.evaluate((element) => getComputedStyle(element).backdropFilter);
    const dialogBackdropFilter = await dialog.evaluate((element) => getComputedStyle(element).backdropFilter);

    expect(overlayBackdropFilter).toBe("none");
    expect(dialogBackdropFilter).toBe("none");
  });

  test("creates a project without project-level workspace fields and reuses the org workspace", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Project-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new project" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New project") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("https://github.com/org/repo")).toHaveCount(0);
    await expect(dialog.getByPlaceholder("/absolute/path/to/workspace")).toHaveCount(0);

    await dialog.getByPlaceholder("Project name").fill("Shared Workspace Project");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/projects`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create project" }).click();
    const created = await (await createResponse).json() as {
      workspaces: unknown[];
      primaryWorkspace: unknown | null;
      codebase: { scope: string; repoUrl: string | null; localFolder: string | null };
    };

    expect(created.workspaces).toEqual([]);
    expect(created.primaryWorkspace).toBeNull();
    expect(created.codebase.scope).toBe("organization");
    expect(created.codebase.repoUrl).toBeNull();
    expect(created.codebase.localFolder).toContain(`/organizations/${organization.id}/workspaces`);
  });

  test("keeps the new project status control single-framed while preserving status selection", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Project-Status-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new project" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New project") }).first();
    await expect(dialog).toBeVisible();

    const statusTrigger = dialog.getByRole("button", { name: "planned" });
    await expect(statusTrigger).toHaveCSS("border-top-width", "0px");

    await statusTrigger.click();
    await page.getByRole("button", { name: "In Progress" }).click();
    await expect(dialog.getByRole("button", { name: "in progress" })).toBeVisible();

    await dialog.getByPlaceholder("Project name").fill("Single frame status project");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/projects`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create project" }).click();
    const created = await (await createResponse).json() as { status: string };

    expect(created.status).toBe("in_progress");
  });

  test("creates a project with an inline structured resource from the new project dialog", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Project-Resources-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new project" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New project") }).first();
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder("Project name").fill("Structured Resource Project");
    const resourceHelpText = "Attach the codebases, docs, URLs, and external systems agents should use for this project.";
    await expect(dialog.getByText(resourceHelpText)).toHaveCount(0);
    await expect(dialog.getByText("No project-specific resources yet. You can still create the project now and attach resources later.")).toHaveCount(0);

    await dialog.getByRole("button", { name: "About project resources" }).hover();
    await expect(page.getByText(resourceHelpText)).toBeVisible();

    const newResourceButton = dialog.getByRole("button", { name: "New resource" });
    await newResourceButton.click();

    const sharedControlRadius = await computedBorderRadius(newResourceButton);
    const resourceNameInput = dialog.getByPlaceholder("Rudder repo");
    const resourceKindSelect = dialog.getByLabel("Kind");
    const resourceLocatorInput = dialog.getByPlaceholder("~/projects/rudder or https://linear.app/acme/project/...");
    const resourceDescriptionInput = dialog.getByPlaceholder("What this resource contains and when agents should use it.");
    const projectRoleSelect = dialog.getByLabel("Project role");
    const projectNoteInput = dialog.getByPlaceholder("Optional guidance specific to this project");

    for (const control of [
      resourceNameInput,
      resourceKindSelect,
      resourceLocatorInput,
      resourceDescriptionInput,
      projectRoleSelect,
      projectNoteInput,
    ]) {
      expect(await computedBorderRadius(control)).toBe(sharedControlRadius);
    }

    await resourceNameInput.fill("Rudder repo");
    await resourceLocatorInput.fill("~/projects/rudder");
    await resourceDescriptionInput.fill(
      "Main monorepo checkout for implementation work.",
    );

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/projects`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create project" }).click();
    const created = await (await createResponse).json() as {
      id: string;
      resources: Array<{
        role: string;
        note: string | null;
        resource: { name: string; kind: string; locator: string; description: string | null };
      }>;
    };

    expect(created.resources).toHaveLength(1);
    expect(created.resources[0]).toEqual(expect.objectContaining({
      role: "working_set",
      note: null,
      resource: expect.objectContaining({
        name: "Rudder repo",
        kind: "directory",
        locator: "~/projects/rudder",
        description: "Main monorepo checkout for implementation work.",
      }),
    }));

    const detailRes = await page.request.get(`/api/projects/${created.id}?orgId=${organization.id}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json() as { resources: Array<{ resource: { name: string } }> };
    expect(detail.resources.map((attachment) => attachment.resource.name)).toEqual(["Rudder repo"]);
  });

  test("uses the desktop file picker for inline directory resources in the new project dialog", async ({ page }) => {
    await installDesktopShellStub(page, "/tmp/picked-repo");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Desktop-Picker-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new project" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New project") }).first();
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder("Project name").fill("Desktop Picker Project");
    await dialog.getByRole("button", { name: "New resource" }).click();
    await dialog.getByRole("button", { name: "Browse for directory" }).click();

    const locatorInput = dialog.getByDisplayValue("/tmp/picked-repo");
    await expect(locatorInput).toBeVisible();
    await expect(dialog.getByDisplayValue("picked-repo")).toBeVisible();

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/projects`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create project" }).click();
    const created = await (await createResponse).json() as {
      resources: Array<{
        resource: { name: string; kind: string; locator: string };
      }>;
    };

    expect(created.resources).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({
          name: "picked-repo",
          kind: "directory",
          locator: "/tmp/picked-repo",
        }),
      }),
    ]);
  });

  test("keeps light-mode rail items readable and visually centered against the context card", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Visual-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "light");
      document.documentElement.classList.remove("dark");
    }, { orgId: organization.id });

    await page.goto(`/${organization.issuePrefix}/messenger`);

    const contextCard = page.getByTestId("workspace-context-card");
    const dashboardItem = page.getByRole("link", { name: "Dashboard" });
    const searchButton = page.getByRole("button", { name: "Search" });
    const createButton = page.getByRole("button", { name: "Create" });
    const settingsButton = page.getByRole("button", { name: "System settings" });

    await expect(contextCard).toBeVisible();
    await expect(dashboardItem).toBeVisible();

    const navAppearance = await dashboardItem.evaluate((element) => {
      return {
        color: getComputedStyle(element).color,
      };
    });
    expect(perceptualLightness(navAppearance.color)).toBeLessThanOrEqual(0.48);

    const utilityAppearance = await searchButton.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        color: styles.color,
        background: styles.backgroundColor,
      };
    });
    expect(perceptualLightness(utilityAppearance.color)).toBeLessThanOrEqual(0.45);
    expect(perceptualLightness(utilityAppearance.background) - perceptualLightness(utilityAppearance.color)).toBeGreaterThan(0.48);

    const railBox = await dashboardItem.evaluate((element) => {
      const railElement = element.closest("aside");
      if (!railElement) throw new Error("Primary rail not found");
      const rect = railElement.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const contextCardBox = await contextCard.boundingBox();
    expect(contextCardBox).not.toBeNull();

    const visualAxis = (railBox.x + contextCardBox!.x) / 2;
    for (const locator of [searchButton, createButton, dashboardItem, settingsButton]) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      const center = box!.x + box!.width / 2;
      expect(Math.abs(center - visualAxis)).toBeLessThanOrEqual(4.5);
    }
  });
});
