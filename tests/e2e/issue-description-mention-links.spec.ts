import { expect, test, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function installLocalFilePreviewStub(page: Page, targetPath: string, content: string) {
  await page.addInitScript(({ filePath, fileContent }) => {
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: async () => [],
        openPath: async () => {},
        previewLocalFile: async (requestedPath: string) => {
          if (requestedPath !== filePath) throw new Error(`Unexpected local file path: ${requestedPath}`);
          return {
            canonicalPath: filePath,
            fileName: filePath.split("/").at(-1) ?? filePath,
            parentPath: filePath.slice(0, filePath.lastIndexOf("/")),
            contentType: "text/markdown; charset=utf-8",
            previewKind: "markdown",
            content: fileContent,
            base64: null,
            sizeBytes: fileContent.length,
            modifiedAt: "2026-09-02T00:00:00.000Z",
            truncated: false,
            writeCapability: null,
          };
        },
        setBadgeCount: async () => {},
        setSidePanelCloseShortcutActive: async () => {},
      },
    });
  }, { filePath: targetPath, fileContent: content });
}

test("issue description special mention links stay inside the active organization route", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Description-Mention-Links-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const targetIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Target issue for special mention navigation",
      description: "The source issue links here through an issue:// mention.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(targetIssueRes.ok()).toBe(true);
  const targetIssue = await targetIssueRes.json() as { id: string; identifier: string | null };
  const targetIssueRef = targetIssue.identifier ?? targetIssue.id;

  const workspaceFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: "docs/reference-map.md",
      content: "# Reference map\n\nOpened from an issue description reference.",
    },
  });
  expect(workspaceFileRes.ok()).toBe(true);

  const sourceIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Source issue with special mention link",
      description: [
        `Review [${targetIssueRef}](issue://${targetIssue.id}) before closing this issue.`,
        "Open [Reference map](library-file://file?p=docs%2Freference-map.md) for context.",
      ].join("\n\n"),
      status: "todo",
      priority: "medium",
    },
  });
  expect(sourceIssueRes.ok()).toBe(true);
  const sourceIssue = await sourceIssueRes.json() as { id: string; identifier: string | null };
  const sourceIssueRef = sourceIssue.identifier ?? sourceIssue.id;

  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);

  const descriptionLink = page.getByRole("link", { name: targetIssueRef }).first();
  await expect(descriptionLink).toBeVisible();
  await expect(descriptionLink).toHaveAttribute("href", `issue://${targetIssue.id}`);
  await expect(page.locator(".rudder-issue-description-surface .rudder-milkdown-scope"))
    .toHaveAttribute("data-inline-token-click-mode", "plain");
  const activeOrganizationPrefix = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
  expect(activeOrganizationPrefix).toBeTruthy();

  const libraryFileLink = page.getByRole("link", { name: "Reference map" }).first();
  await expect(libraryFileLink).toHaveAttribute(
    "href",
    "library-file://file?p=docs%2Freference-map.md",
  );
  await libraryFileLink.click();
  await expect(page).toHaveURL(
    new RegExp(`/${activeOrganizationPrefix}/library\\?path=docs%2Freference-map\\.md$`),
  );
  await expect(page.getByTestId("org-workspaces-markdown-editor")).toContainText(
    "Opened from an issue description reference.",
  );

  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);
  await descriptionLink.click();
  await expect(page).toHaveURL(new RegExp(`/${activeOrganizationPrefix}/issues/${targetIssue.id}$`));
  await expect(page.locator("main").getByRole("heading", {
    name: "Target issue for special mention navigation",
  })).toBeVisible();
});

test("ordinary issue description Markdown links open from the live preview", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Description-Ordinary-Link-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue with an ordinary Markdown link",
      description: `Open [Messenger](/${organization.issuePrefix}/messenger) to continue reviewing the work.`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/issues/${issue.identifier ?? issue.id}`);

  const editor = page
    .locator(".rudder-issue-description-surface")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  const messengerLink = editor.locator(
    `[data-markdown-link-href="/${organization.issuePrefix}/messenger"]`,
  );
  await expect(messengerLink).toBeVisible();
  await messengerLink.click();

  await expect(page).toHaveURL(
    new RegExp(`/${organization.issuePrefix}/messenger(?:/|$)`),
  );
  await expect(page.getByTestId("chat-main-workspace-card")).toBeVisible();
  await page.screenshot({
    path: join(tmpdir(), "rudder-issue-markdown-link-open.png"),
  });
});

test("opens an absolute local Markdown link from the issue description in the Side Panel", async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  const localFilePath = "/Users/zeeland/projects/uranus/rudder/proposals/2026-08-20-rudder-actix-web-backend-migration-proposal.md";
  const originalDescription = `Review [Proposal](${localFilePath}) before continuing.`;
  await installLocalFilePreviewStub(
    page,
    localFilePath,
    "# Proposal\n\nOpened from an absolute local Markdown link in an Issue description.",
  );

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Description-Local-File-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey?: string };
  const organizationRouteKey = organization.urlKey ?? organization.issuePrefix;
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue with an absolute local Markdown link",
      description: originalDescription,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as {
    id: string;
    identifier: string | null;
    updatedAt: string;
  };

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organizationRouteKey}/issues/${issue.identifier ?? issue.id}`);

  const editor = page.locator(
    ".rudder-issue-description-surface [data-editor-engine='codemirror-live-preview']",
  );
  const localFileLink = editor.locator("[data-markdown-link-href]").filter({ hasText: "Proposal" });
  await expect(localFileLink).toBeVisible();
  await expect(localFileLink).toHaveAttribute("href", localFilePath);
  await expect(localFileLink).toHaveAttribute("data-local-file-icon", "document");
  const issueUrl = page.url();
  await localFileLink.click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-local-file-view")).toContainText(
    "Opened from an absolute local Markdown link in an Issue description.",
  );
  await expect(sidePanel.getByText("2026-08-20-rudder-actix-web-backend-migration-proposal.md", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(issueUrl);

  await page.screenshot({
    path: testInfo.outputPath("issue-description-local-file-side-panel.png"),
    fullPage: true,
  });

  await sidePanel.getByRole("button", { name: "Close Side Panel" }).click();
  await expect(sidePanel).toBeHidden();
  await localFileLink.focus();
  await expect(localFileLink).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-local-file-view")).toContainText(
    "Opened from an absolute local Markdown link in an Issue description.",
  );
  await expect(page).toHaveURL(issueUrl);
  await expect(editor.locator('[data-markdown-preview-state="preview"]')).toBeVisible();
  await expect(editor.locator('[data-markdown-preview-state="source"]')).toHaveCount(0);

  await sidePanel.getByRole("button", { name: "Close Side Panel" }).click();
  await expect(sidePanel).toBeHidden();

  const modifierPopupPromise = page.waitForEvent("popup");
  await localFileLink.click({ modifiers: ["Meta"] });
  const modifierPopup = await modifierPopupPromise;
  await modifierPopup.waitForLoadState("domcontentloaded");
  expect(new URL(modifierPopup.url()).pathname).toBe(localFilePath);
  await modifierPopup.close();
  await expect(page).toHaveURL(issueUrl);

  const middlePopupPromise = page.waitForEvent("popup");
  await localFileLink.click({ button: "middle" });
  const middlePopup = await middlePopupPromise;
  await middlePopup.waitForLoadState("domcontentloaded");
  expect(new URL(middlePopup.url()).pathname).toBe(localFilePath);
  await middlePopup.close();
  await expect(page).toHaveURL(issueUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  await localFileLink.click();

  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByText("2026-08-20-rudder-actix-web-backend-migration-proposal.md", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(issueUrl);
  await page.screenshot({
    path: testInfo.outputPath("issue-description-local-file-side-panel-mobile.png"),
    fullPage: true,
  });

  const issueReadback = await page.request.get(`/api/issues/${issue.id}`);
  expect(issueReadback.ok(), await issueReadback.text()).toBe(true);
  const persistedIssue = await issueReadback.json() as {
    description: string | null;
    updatedAt: string;
  };
  expect(persistedIssue.description).toBe(originalDescription);
  expect(persistedIssue.updatedAt).toBe(issue.updatedAt);
  expect(runtimeErrors).toEqual([]);
});
