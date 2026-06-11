import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("Library command-f searches the current editor tab content", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Find-Shortcut-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const filePath = `projects/find-shortcut-${suffix}/current.md`;
  const needle = `FindLibraryNeedle${suffix}`;
  const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: `# Searchable Library doc\n\nThis active Library tab contains ${needle} for keyword search.\n`,
    },
  });
  expect(fileRes.ok()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);
  await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("current.md", { timeout: 15_000 });
  await expect(page.getByText(needle)).toBeVisible();

  const editor = page.getByTestId("org-workspaces-markdown-editor").locator("[contenteditable='true']");
  await expect(editor).toBeVisible();
  await editor.click();
  await expect.poll(async () => page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && Boolean(active.closest("[data-testid='org-workspaces-markdown-editor']"));
  })).toBe(true);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");

  const findUi = page.getByRole("search", { name: "Find in Library" });
  await expect(findUi).toBeVisible();

  const input = findUi.getByRole("textbox", { name: "Find in Library" });
  await input.fill(needle);

  await expect(findUi).toContainText("1 of 1");
  await expect.poll(async () => page.evaluate(() => {
    const highlights = (CSS as unknown as {
      highlights?: { get: (name: string) => { size?: number } | undefined };
    }).highlights;
    return highlights?.get("rudder-issue-find-highlight")?.size ?? 0;
  })).toBe(1);
  await expect.poll(async () => page.evaluate(() => {
    const highlights = (CSS as unknown as {
      highlights?: { get: (name: string) => { size?: number } | undefined };
    }).highlights;
    return highlights?.get("rudder-issue-find-highlight-active")?.size ?? 0;
  })).toBe(1);

  await input.press("Escape");
  await expect(findUi).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const highlights = (CSS as unknown as {
      highlights?: { get: (name: string) => { size?: number } | undefined };
    }).highlights;
    return highlights?.get("rudder-issue-find-highlight")?.size ?? 0;
  })).toBe(0);
});

test("Library markdown file links open as retained editor tabs", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Library-Tabs-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const sourcePath = `projects/tab-proof-${suffix}/current.md`;
  const linkedPath = `projects/tab-proof-${suffix}/linked.md`;
  const fillerPaths = Array.from(
    { length: 10 },
    (_, index) => `projects/tab-proof-${suffix}/filler-${String(index + 1).padStart(2, "0")}.md`,
  );
  const files = [
    {
      filePath: sourcePath,
      content: `# Current\n\nOpen [Linked doc](library-file://file?p=${encodeURIComponent(linkedPath)}&t=linked.md) from this document.\n`,
    },
    ...fillerPaths.map((filePath) => ({
      filePath,
      content: `# ${filePath}\n\nFiller retained tab.\n`,
    })),
    {
      filePath: linkedPath,
      content: "# Linked doc\n\nThis should open in a retained Library tab.\n",
    },
  ];

  for (const file of files) {
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: file,
    });
    expect(fileRes.ok()).toBe(true);
  }

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(sourcePath)}`);

  const tabStrip = page.getByTestId("org-workspaces-editor-tabs");
  const tabScroller = page.getByTestId("org-workspaces-editor-tab-scroller");
  await expect(tabStrip).toContainText("current.md", { timeout: 15_000 });
  await expect(tabStrip).not.toContainText("linked.md");

  for (const fillerPath of fillerPaths) {
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(fillerPath)}`);
    await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText(fillerPath.split("/").at(-1)!);
  }

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(sourcePath)}`);
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("current.md");

  await page.getByText("Linked doc", { exact: true }).click();

  await expect(tabStrip).toContainText("current.md");
  await expect(tabStrip).toContainText("linked.md");
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("linked.md");
  await expect(async () => {
    const scrollerBox = await tabScroller.boundingBox();
    const linkedTabBox = await page.getByTestId(`org-workspaces-editor-tab-${linkedPath}`).boundingBox();
    expect(scrollerBox).not.toBeNull();
    expect(linkedTabBox).not.toBeNull();
    expect(linkedTabBox!.x).toBeGreaterThanOrEqual(scrollerBox!.x - 1);
    expect(linkedTabBox!.x + linkedTabBox!.width).toBeLessThanOrEqual(scrollerBox!.x + scrollerBox!.width + 1);
  }).toPass();

  await page.reload({ waitUntil: "networkidle" });
  await expect(tabStrip).toContainText("current.md");
  await expect(tabStrip).toContainText("linked.md");
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("linked.md");
});

test("Library legacy document links open without restoring retained editor tabs", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Library-Legacy-Doc-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const retainedPath = `projects/legacy-doc-${suffix}/retained.md`;
  const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: retainedPath,
      content: "# Retained tab\n\nThis file should not reopen over a legacy document link.\n",
    },
  });
  expect(fileRes.ok()).toBe(true);

  const documentRes = await page.request.post(`/api/orgs/${organization.id}/library/documents`, {
    data: {
      title: "Legacy linked plan",
      format: "markdown",
      body: "# Legacy linked plan\n\nOpened from Chat or E-SCO without workspace tab restoration.",
    },
  });
  expect(documentRes.ok()).toBe(true);
  const document = await documentRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(retainedPath)}`);
  const tabStrip = page.getByTestId("org-workspaces-editor-tabs");
  await expect(tabStrip).toContainText("retained.md", { timeout: 15_000 });

  await page.goto(`/${organization.issuePrefix}/library?doc=${encodeURIComponent(document.id)}`);

  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?doc=${document.id}$`));
  await expect(page.getByTestId("org-workspaces-legacy-document")).toContainText("Legacy linked plan");
  await expect(page.getByTestId("org-workspaces-legacy-document")).toContainText(
    "Opened from Chat or E-SCO without workspace tab restoration.",
  );
  await expect(page.getByTestId("org-workspaces-editor-tabs")).toHaveCount(0);
});

test("Library command-w closes the current editor tab instead of the Rudder page", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Library-Close-Shortcut-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const firstPath = `projects/close-shortcut-${suffix}/first.md`;
  const secondPath = `projects/close-shortcut-${suffix}/second.md`;
  for (const file of [
    { filePath: firstPath, content: "# First\n" },
    { filePath: secondPath, content: "# Second\n" },
  ]) {
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: file,
    });
    expect(fileRes.ok()).toBe(true);
  }

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(firstPath)}`);
  const tabStrip = page.getByTestId("org-workspaces-editor-tabs");
  await expect(tabStrip).toContainText("first.md", { timeout: 15_000 });

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(secondPath)}`);
  await expect(tabStrip).toContainText("first.md");
  await expect(tabStrip).toContainText("second.md");
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("second.md");

  await page.keyboard.press("ControlOrMeta+W");

  await expect(tabStrip).toContainText("first.md");
  await expect(tabStrip).not.toContainText("second.md");
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("first.md");
  expect(page.isClosed()).toBe(false);
});
