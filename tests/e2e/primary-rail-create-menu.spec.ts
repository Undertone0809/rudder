import { expect, test, type Locator, type Page } from "@playwright/test";
import { resolveOrganizationStorageKey } from "../../packages/agent-runtime-utils/src/organization-storage.ts";

async function addUrlProjectSource(page: Page, dialog: Locator, url: string) {
  await dialog.getByRole("button", { name: "Add sources", exact: true }).click();
  const sourcesDialog = page.getByTestId("new-project-add-sources-dialog");
  await sourcesDialog.getByRole("button", { name: /Add from URL/ }).click();
  await sourcesDialog.getByLabel("URL").fill(url);
  await sourcesDialog.getByRole("button", { name: "Add source", exact: true }).click();
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
      id: string;
      workspaces: unknown[];
      primaryWorkspace: unknown | null;
      codebase: { scope: string; repoUrl: string | null; localFolder: string | null };
    };

    expect(created.workspaces).toEqual([]);
    expect(created.primaryWorkspace).toBeNull();
    expect(created.codebase.scope).toBe("organization");
    expect(created.codebase.repoUrl).toBeNull();
    expect(created.codebase.localFolder).toContain(`/organizations/${resolveOrganizationStorageKey(organization.id)}/workspaces`);
    await expect(page).toHaveURL(
      new RegExp(`/${organization.issuePrefix}/issues\\?projectId=${created.id}$`),
    );
    await expect(page.getByRole("heading", { name: "Issue Tracker" })).toBeVisible();
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

  test("creates a project with a URL source from the new project dialog", async ({ page }) => {
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
    const resourceHelpText = "Project Sources are the codebases, Library files, local files, and URLs agents can use for this project.";
    await expect(dialog.getByText(resourceHelpText)).toHaveCount(0);
    await expect(dialog.getByText("No project-specific resources yet. You can still create the project now and attach resources later.")).toHaveCount(0);

    await dialog.getByRole("button", { name: "About project sources" }).hover();
    await expect(page.getByText(resourceHelpText)).toBeVisible();
    await addUrlProjectSource(page, dialog, "https://example.com/rudder-reference");

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
        resource: { name: string; kind: string; sourceType: string; locator: string };
      }>;
    };

    expect(created.resources).toHaveLength(1);
    expect(created.resources[0]).toEqual(expect.objectContaining({
      role: "reference",
      resource: expect.objectContaining({
        name: "rudder-reference",
        kind: "url",
        sourceType: "external",
        locator: "https://example.com/rudder-reference",
      }),
    }));

    const detailRes = await page.request.get(`/api/projects/${created.id}?orgId=${organization.id}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json() as { resources: Array<{ resource: { name: string } }> };
    expect(detail.resources.map((attachment) => attachment.resource.name)).toEqual(["rudder-reference"]);
  });

  test("keeps project creation actions reachable after adding multiple external resources", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 760 });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Project-Resource-Overflow-${Date.now()}`,
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
    await dialog.getByPlaceholder("Project name").fill("Multi Resource Project");

    await addUrlProjectSource(page, dialog, "https://example.com/rudder-repo");
    await addUrlProjectSource(page, dialog, "https://example.com/company-records");

    const createProjectButton = dialog.getByRole("button", { name: "Create project" });
    await expect(createProjectButton).toBeVisible();
    await expect(createProjectButton).toBeEnabled();

    const [dialogBox, buttonBox, viewportSize] = await Promise.all([
      dialog.boundingBox(),
      createProjectButton.boundingBox(),
      page.viewportSize(),
    ]);
    expect(dialogBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(viewportSize).not.toBeNull();
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(viewportSize!.height);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height + 1);

    await page.screenshot({
      path: testInfo.outputPath("new-project-multiple-resources-footer.png"),
      fullPage: true,
    });

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/projects`)
      && response.ok(),
    );
    await createProjectButton.click();
    const created = await (await createResponse).json() as {
      resources: Array<{ resource: { name: string; locator: string } }>;
    };

    expect(created.resources.map((attachment) => attachment.resource.name)).toEqual([
      "rudder-repo",
      "company-records",
    ]);
  });

  test("creates a project with a Library file attached as a path-based library resource", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `PrimaryRail-Project-Library-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: "projects/create-menu/project-brief.md",
        content: "# Project brief\n\nUse this as project context.",
      },
    });
    expect(fileRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new project" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New project") }).first();
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("Project name").fill("Docs Context Project");

    await dialog.getByRole("button", { name: "Add sources", exact: true }).click();
    const sourcesDialog = page.getByTestId("new-project-add-sources-dialog");
    await sourcesDialog.getByRole("button", { name: /Add from library/ }).click();
    await sourcesDialog.getByRole("button", { name: /project-brief\.md/ }).click();
    await expect(dialog.getByText("Library · File · projects/create-menu/project-brief.md")).toBeVisible();

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/projects`)
      && response.ok(),
    );
    await dialog.getByRole("button", { name: "Create project" }).click();
    const created = await (await createResponse).json() as {
      resources: Array<{
        role: string;
        resource: { name: string; kind: string; sourceType: string; locator: string };
      }>;
    };

    expect(created.resources).toHaveLength(1);
    expect(created.resources[0]).toEqual(expect.objectContaining({
      role: "reference",
      resource: expect.objectContaining({
        name: "project-brief.md",
        kind: "file",
        sourceType: "library",
        locator: "projects/create-menu/project-brief.md",
      }),
    }));
  });

  test("uses the local file picker from the new project Sources dialog", async ({ page }) => {
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
    await page.route("**/api/instance/path-picker", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ cancelled: false, path: "/tmp/picked-source.md" }),
      });
    });
    await dialog.getByRole("button", { name: "Add sources", exact: true }).click();
    const sourcesDialog = page.getByTestId("new-project-add-sources-dialog");
    await sourcesDialog.getByRole("button", { name: /Select from local/ }).click();
    await sourcesDialog.getByRole("button", { name: "Choose file" }).click();

    await expect(dialog.getByText("picked-source.md", { exact: true })).toBeVisible();

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
          name: "picked-source.md",
          kind: "file",
          locator: "/tmp/picked-source.md",
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
