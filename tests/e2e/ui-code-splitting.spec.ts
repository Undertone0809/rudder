import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function createOrganization(page: Page, suffix: string) {
  const response = await page.request.post("/api/orgs", {
    data: { name: `UI-Code-Splitting-${suffix}-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string; urlKey?: string | null }>;
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrganizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrganizationId);
  }, organizationId);
}

function assetBasename(url: string) {
  const pathname = new URL(url).pathname;
  return pathname.slice(pathname.lastIndexOf("/") + 1);
}

test.describe("Production UI code splitting", () => {
  test("loads routes, editors, and the Side Panel on demand while preserving the shell", async ({ page }) => {
    const organization = await createOrganization(page, "journey");
    const routeKey = organization.urlKey ?? organization.issuePrefix;
    const requestedAssets: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/assets/")) requestedAssets.push(assetBasename(request.url()));
    });

    await selectOrganization(page, organization.id);
    await page.goto(`/${routeKey}/dashboard`);
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    await expect(page.getByTestId("primary-rail")).toBeVisible();
    await expect.poll(() => requestedAssets.some((asset) => /^Dashboard-.*\.js$/u.test(asset))).toBe(true);
    expect(requestedAssets).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^Chat\.side-panel-.*\.js$/u),
      expect.stringMatching(/^LegacyMarkdownEditor-.*\.js$/u),
      expect.stringMatching(/^MilkdownMarkdownEditor-.*\.js$/u),
      expect.stringMatching(/^CodeMirrorMarkdownEditor-.*\.js$/u),
      expect.stringMatching(/^Messenger-.*\.js$/u),
      expect.stringMatching(/^Issues-.*\.js$/u),
    ]));

    await page.goto(`/${routeKey}/messenger/issues`);
    await expect(page.getByText("No tracked issues")).toBeVisible();
    await expect.poll(() => requestedAssets.some((asset) => /^Messenger-.*\.js$/u.test(asset))).toBe(true);
    expect(requestedAssets.some((asset) => /^Chat-[^-].*\.js$/u.test(asset))).toBe(false);

    let releaseIssuesChunk!: () => void;
    const issuesChunkGate = new Promise<void>((resolve) => {
      releaseIssuesChunk = resolve;
    });
    let issuesChunkDelayed = false;
    await page.route(/\/assets\/Issues-[^/]+\.js$/u, async (route) => {
      issuesChunkDelayed = true;
      await issuesChunkGate;
      await route.continue();
    });

    await page.getByTestId("primary-rail").getByRole("link", { name: "Issue", exact: true }).click();
    await expect.poll(() => issuesChunkDelayed).toBe(true);
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    await expect(page.getByTestId("primary-rail")).toBeVisible();
    await expect(page.locator('#main-content [data-slot="skeleton"]').first()).toBeVisible();
    releaseIssuesChunk();
    await expect(page.getByRole("heading", { name: "Issue Tracker" })).toBeVisible();

    let releaseEditorChunk!: () => void;
    const editorChunkGate = new Promise<void>((resolve) => {
      releaseEditorChunk = resolve;
    });
    let editorChunkDelayed = false;
    await page.route(/\/assets\/CodeMirrorMarkdownEditor-[^/]+\.js$/u, async (route) => {
      editorChunkDelayed = true;
      await editorChunkGate;
      await route.continue();
    });

    await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
    await page.getByRole("menuitem", { name: "Create new issue" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => editorChunkDelayed).toBe(true);
    const issueTitle = page.getByPlaceholder("Issue title");
    await issueTitle.focus();
    await expect(issueTitle).toBeFocused();
    await issueTitle.press("Enter");
    releaseEditorChunk();
    await expect.poll(() => requestedAssets.some((asset) => /^CodeMirrorMarkdownEditor-.*\.js$/u.test(asset))).toBe(true);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    await expect(page.getByTestId("side-panel-stable-host")).toHaveAttribute("data-side-panel-state", "docked");
    await expect.poll(() => requestedAssets.some((asset) => /^Chat\.side-panel-.*\.js$/u.test(asset))).toBe(true);
  });

  test("surfaces a recoverable UI failure when a route chunk cannot load", async ({ page }) => {
    const organization = await createOrganization(page, "failure");
    const routeKey = organization.urlKey ?? organization.issuePrefix;
    await selectOrganization(page, organization.id);
    await page.goto(`/${routeKey}/dashboard`);
    await expect(page.getByTestId("workspace-shell")).toBeVisible();

    await page.route(/\/assets\/Issues-[^/]+\.js$/u, (route) => route.abort("failed"));
    await page.getByTestId("primary-rail").getByRole("link", { name: "Issue", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Rudder hit a UI failure." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload UI" })).toBeVisible();
  });
});
