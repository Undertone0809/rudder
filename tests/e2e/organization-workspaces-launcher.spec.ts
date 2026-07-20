import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveE2EOrganizationWorkspaceRoot } from "./support/organization-storage";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

function createSimplePdf() {
  const stream = "BT /F1 18 Tf 36 96 Td (Rudder PDF preview) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

test.use({ serviceWorkers: "block" });

test("opens workspace launcher options from the Library sidebar", async ({ page, request }) => {
  await page.addInitScript(() => {
    const openedWorkspaces: Array<{ rootPath: string; targetId?: string }> = [];
    const openedWorkspaceFiles: Array<{ rootPath: string; filePath: string; ideId?: string }> = [];
    Object.defineProperty(window, "__rudderOpenedWorkspaces", {
      configurable: true,
      value: openedWorkspaces,
      writable: false,
    });
    Object.defineProperty(window, "__rudderOpenedWorkspaceFiles", {
      configurable: true,
      value: openedWorkspaceFiles,
      writable: false,
    });

    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: async () => [
          { id: "cursor", label: "Cursor", kind: "ide" },
          { id: "vscode", label: "VS Code", kind: "ide" },
          { id: "commandPrompt", label: "Command Prompt", kind: "terminal" },
          { id: "powershell", label: "PowerShell", kind: "terminal" },
          { id: "finder", label: "Folder", kind: "folder" },
        ],
        openWorkspace: async (rootPath: string, targetId?: string) => {
          openedWorkspaces.push({ rootPath, targetId });
        },
        openPath: async () => {},
        listAvailableIdes: async () => [{ id: "cursor", label: "Cursor" }],
        openWorkspaceFileInIde: async (rootPath: string, filePath: string, ideId?: string) => {
          openedWorkspaceFiles.push({ rootPath, filePath, ideId });
        },
        copyText: async () => {},
        getBootState: async () => ({}),
        onBootState: () => () => {},
        setAppearance: async () => {},
        restart: async () => {},
        getAppVersion: async () => "0.0.0-test",
        checkForUpdates: async () => ({
          status: "unavailable",
          channel: "stable",
          currentVersion: "0.0.0-test",
          checkedAt: "1970-01-01T00:00:00.000Z",
        }),
        sendFeedback: async () => {},
        openExternal: async () => {},
        openNotificationSettings: async () => ({ opened: false, platform: "darwin" }),
        setBadgeCount: async () => {},
        showNotification: async () => {},
        pickPath: async () => ({ canceled: true, path: null }),
      },
    });
  });

  const orgRes = await request.post("/api/orgs", {
    data: { name: `Library-Launcher-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: "projects/launcher-proof/README.md",
      content: "# Launcher proof\n",
    },
  });
  expect(fileRes.ok()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1280, height: 760 });
  const filePath = "projects/launcher-proof/README.md";
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const sidebarLauncher = page.getByTestId("org-workspaces-sidebar-launcher");
  await expect(sidebarLauncher).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("org-workspaces-editor-launcher")).toHaveCount(0);

  const fileRow = page.locator(`[data-workspace-entry-path="${filePath}"]`).first();
  await expect(fileRow).toBeVisible({ timeout: 15_000 });
  await fileRow.hover();
  await page.getByTestId(`org-workspaces-entry-more-${filePath}`).click();

  const parentContent = page.locator("[data-slot='dropdown-menu-content']").first();
  await expect(parentContent).toBeVisible();
  await page.getByTestId(`org-workspaces-entry-open-submenu-${filePath}`).hover();

  const subContent = page.locator("[data-slot='dropdown-menu-sub-content']").first();
  await expect(subContent).toBeVisible();
  const parentBox = await parentContent.boundingBox();
  const subBox = await subContent.boundingBox();
  expect(parentBox).not.toBeNull();
  expect(subBox).not.toBeNull();
  expect(subBox!.x).toBeGreaterThanOrEqual(parentBox!.x + parentBox!.width - 1);

  await expect(page.getByTestId(`org-workspaces-entry-open-target-${filePath}-cursor`)).toContainText("Cursor");
  await expect(page.getByTestId(`org-workspaces-entry-open-target-${filePath}-vscode`)).toContainText("VS Code");
  await expect(page.getByTestId(`org-workspaces-entry-open-target-${filePath}-commandPrompt`)).toHaveCount(0);
  await expect(page.getByTestId(`org-workspaces-entry-open-target-${filePath}-powershell`)).toHaveCount(0);
  await expect(page.getByTestId(`org-workspaces-entry-open-target-${filePath}-finder`)).toHaveCount(0);

  await page.getByTestId(`org-workspaces-entry-open-target-${filePath}-vscode`).click();
  await expect.poll(async () =>
    page.evaluate(() => (window as typeof window & {
      __rudderOpenedWorkspaceFiles?: Array<{ rootPath: string; filePath: string; ideId?: string }>;
    }).__rudderOpenedWorkspaceFiles ?? []),
  ).toEqual([
    expect.objectContaining({ filePath, ideId: "vscode" }),
  ]);

  await sidebarLauncher.click();
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-cursor")).toContainText("Cursor");
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-vscode")).toContainText("VS Code");
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-commandPrompt")).toContainText("Command Prompt");
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-powershell")).toContainText("PowerShell");
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-finder")).toContainText("Folder");

  await page.getByTestId("org-workspaces-sidebar-launch-target-cursor").click();
  await expect.poll(async () =>
    page.evaluate(() => (window as typeof window & {
      __rudderOpenedWorkspaces?: Array<{ rootPath: string; targetId?: string }>;
    }).__rudderOpenedWorkspaces ?? []),
  ).toEqual([
    expect.objectContaining({ targetId: "cursor" }),
  ]);
});

test("launches unsupported Library files while preserving supported presentations", async ({ page, request }) => {
  await page.addInitScript(() => {
    const openedWorkspaceFiles: Array<{ rootPath: string; filePath: string; targetId?: string }> = [];
    const openedFileLocations: Array<{ rootPath: string; filePath: string; targetId: string }> = [];
    Object.defineProperty(window, "__rudderOpenedWorkspaceFiles", { configurable: true, value: openedWorkspaceFiles });
    Object.defineProperty(window, "__rudderOpenedFileLocations", { configurable: true, value: openedFileLocations });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: async () => [
          { id: "vscode", label: "VS Code", kind: "ide" },
          { id: "xcode", label: "Xcode", kind: "ide" },
          { id: "terminal", label: "Terminal", kind: "terminal" },
          { id: "warp", label: "Warp", kind: "terminal" },
          { id: "finder", label: "Finder", kind: "folder" },
        ],
        listAvailableIdes: async () => [{ id: "vscode", label: "VS Code" }],
        openWorkspace: async () => {},
        openWorkspaceFileInIde: async (rootPath: string, filePath: string, targetId?: string) => {
          openedWorkspaceFiles.push({ rootPath, filePath, targetId });
        },
        openWorkspaceFileLocation: async (rootPath: string, filePath: string, targetId: string) => {
          openedFileLocations.push({ rootPath, filePath, targetId });
          if (targetId === "warp") throw new Error("Warp rejected the request");
        },
      },
    });
  });

  const orgRes = await request.post("/api/orgs", {
    data: { name: `Library-Unsupported-Launcher-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const workspaceRoot = resolveE2EOrganizationWorkspaceRoot(organization.id);
  const fixtureDirectory = path.join(workspaceRoot, "launcher-proof");
  await fs.mkdir(fixtureDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(fixtureDirectory, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x00])),
    fs.writeFile(path.join(fixtureDirectory, "model.bin"), Buffer.from([0x00, 0x61, 0x62, 0xff, 0x00])),
    fs.writeFile(path.join(fixtureDirectory, "preview.png"), ONE_BY_ONE_PNG),
    fs.writeFile(path.join(fixtureDirectory, "brief.pdf"), createSimplePdf()),
    fs.writeFile(path.join(fixtureDirectory, "notes.md"), "# Supported editor\n", "utf8"),
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.setViewportSize({ width: 1280, height: 760 });

  const firstUnsupportedPath = "launcher-proof/archive.zip";
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(firstUnsupportedPath)}`);
  await expect(page.getByText("This file can’t be previewed or edited in Rudder.")).toBeVisible({ timeout: 15_000 });
  const primary = page.getByTestId("org-workspaces-unsupported-file-open-current");
  const chooseUnsupportedTarget = async (targetId: string) => {
    const target = page.getByTestId(`org-workspaces-unsupported-file-target-${targetId}`);
    await page.getByTestId("org-workspaces-unsupported-file-launcher").click();
    await expect(target).toBeVisible();
    await target.click();
    await expect(target).toHaveCount(0);
  };
  await expect(primary).toHaveAttribute("aria-label", "Open file with Default app");
  await page.screenshot({ path: "/tmp/rudder-library-unsupported-desktop.png", fullPage: true });
  await page.evaluate(() => window.localStorage.setItem("rudder.theme", "dark"));
  await page.reload();
  await expect(page.getByText("This file can’t be previewed or edited in Rudder.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: "/tmp/rudder-library-unsupported-desktop-dark.png", fullPage: true });
  await page.evaluate(() => window.localStorage.setItem("rudder.theme", "light"));
  await page.reload();
  await expect(primary).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await primary.click();
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __rudderOpenedWorkspaceFiles?: Array<{ filePath: string; targetId?: string }>;
  }).__rudderOpenedWorkspaceFiles ?? [])).toEqual([
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "defaultApp" }),
  ]);

  await chooseUnsupportedTarget("vscode");
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __rudderOpenedWorkspaceFiles?: Array<{ filePath: string; targetId?: string }>;
  }).__rudderOpenedWorkspaceFiles ?? [])).toEqual([
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "defaultApp" }),
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "vscode" }),
  ]);

  await chooseUnsupportedTarget("terminal");
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __rudderOpenedFileLocations?: Array<{ filePath: string; targetId: string }>;
  }).__rudderOpenedFileLocations ?? [])).toEqual([
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "terminal" }),
  ]);

  await chooseUnsupportedTarget("warp");
  await expect(page.getByText("Warp rejected the request")).toBeVisible();
  await expect(page.getByTestId("org-workspaces-unsupported-file-open-current"))
    .toHaveAttribute("aria-label", "Open file with Terminal");
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __rudderOpenedFileLocations?: Array<{ filePath: string; targetId: string }>;
  }).__rudderOpenedFileLocations ?? [])).toEqual([
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "terminal" }),
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "warp" }),
  ]);

  const finderTarget = page.getByTestId("org-workspaces-unsupported-file-target-finder");
  await page.getByTestId("org-workspaces-unsupported-file-launcher").click();
  await expect(finderTarget).toBeVisible();
  await expect(page.getByTestId("org-workspaces-unsupported-file-target-xcode")).toHaveCount(0);
  await finderTarget.click();
  await expect(finderTarget).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __rudderOpenedFileLocations?: Array<{ filePath: string; targetId: string }>;
  }).__rudderOpenedFileLocations ?? [])).toEqual([
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "terminal" }),
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "warp" }),
    expect.objectContaining({ filePath: firstUnsupportedPath, targetId: "finder" }),
  ]);

  const secondUnsupportedPath = "launcher-proof/model.bin";
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(secondUnsupportedPath)}`);
  await expect(page.getByText("This file can’t be previewed or edited in Rudder.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("org-workspaces-unsupported-file-open-current"))
    .toHaveAttribute("aria-label", "Open file with Finder");
  await page.getByTestId("org-workspaces-unsupported-file-open-current").click();
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __rudderOpenedFileLocations?: Array<{ filePath: string; targetId: string }>;
  }).__rudderOpenedFileLocations ?? [])).toEqual([
    expect.objectContaining({ filePath: secondUnsupportedPath, targetId: "finder" }),
  ]);

  for (const [filePath, testId] of [
    ["launcher-proof/preview.png", "org-workspaces-image-preview"],
    ["launcher-proof/brief.pdf", "org-workspaces-pdf-preview"],
    ["launcher-proof/notes.md", "org-workspaces-markdown-editor"],
  ] as const) {
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("This file can’t be previewed or edited in Rudder.")).toHaveCount(0);
  }
});

test("degrades the unsupported Library file fallback honestly outside Desktop", async ({ page, request }) => {
  const orgRes = await request.post("/api/orgs", {
    data: { name: `Library-Unsupported-Web-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const filePath = "launcher-proof/web-only.bin";
  const absoluteFilePath = path.join(resolveE2EOrganizationWorkspaceRoot(organization.id), filePath);
  await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
  await fs.writeFile(absoluteFilePath, Buffer.from([0x00, 0x72, 0x75, 0x64, 0xff]));

  await page.goto("/");
  await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  await expect(page.getByText("This file can’t be previewed or edited in Rudder.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("org-workspaces-unsupported-file-launcher")).toHaveCount(0);
  await expect(page.getByTestId("org-workspaces-unsupported-file-open-current")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/rudder-library-unsupported-web.png", fullPage: true });
});
