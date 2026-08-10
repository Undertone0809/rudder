import { expect, test } from "@playwright/test";

test("adds recent local sources through the progressive Sources dialog", async ({ page }) => {
  const dialogAccessibilityMessages: string[] = [];
  page.on("console", (message) => {
    if (
      (message.type() === "error" || message.type() === "warning")
      && /DialogContent.*(?:DialogTitle|Description|aria-describedby)/s.test(message.text())
    ) {
      dialogAccessibilityMessages.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1_440, height: 960 });
  const uniqueSuffix = Date.now().toString(36).slice(-6).toUpperCase();
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `New-Project-Sources-${Date.now()}`,
      issuePrefix: `PS${uniqueSuffix}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const resourceResponses = await Promise.all(
    Array.from({ length: 18 }, (_, index) => page.request.post(`/api/orgs/${organization.id}/resources`, {
      data: {
        name: `Recent local source ${String(index + 1).padStart(2, "0")}`,
        kind: index % 2 === 0 ? "directory" : "file",
        locator: `/tmp/recent-local-source-${index + 1}${index % 2 === 0 ? "" : ".md"}`,
      },
    })),
  );
  expect(resourceResponses.every((response) => response.ok())).toBe(true);

  const urlResource = await page.request.post(`/api/orgs/${organization.id}/resources`, {
    data: {
      name: "Remote source that does not belong in local recents",
      kind: "url",
      locator: "https://example.com/reference",
    },
  });
  expect(urlResource.ok()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/dashboard`);

  await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
  await page.getByRole("menuitem", { name: "Create new project" }).click();

  const projectDialog = page.locator('[data-slot="dialog-content"]').filter({
    has: page.getByText("New project", { exact: true }),
  });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByPlaceholder("Project name").fill("Recent Sources Project");
  await expect(projectDialog.getByText("Project Sources", { exact: true })).toBeVisible();
  await expect(projectDialog.getByText("Project Context", { exact: true })).toHaveCount(0);
  await projectDialog.getByRole("button", { name: "Add sources" }).click();

  const sourcesDialog = page.getByTestId("new-project-add-sources-dialog");
  await expect(sourcesDialog).toBeVisible();
  await expect(sourcesDialog.getByRole("button", { name: /Add from library/ })).toBeVisible();
  await expect(sourcesDialog.getByRole("button", { name: /Select from local/ })).toBeVisible();
  await expect(sourcesDialog.getByRole("button", { name: /Add from URL/ })).toBeVisible();
  await expect(sourcesDialog.getByPlaceholder("Search Library or paste relative path")).toHaveCount(0);
  await expect(sourcesDialog.getByText("Recent sources", { exact: true })).toHaveCount(0);

  await sourcesDialog.getByRole("button", { name: /Select from local/ }).click();
  await expect(sourcesDialog.getByText("Recent sources", { exact: true })).toBeVisible();
  const chooseFile = sourcesDialog.getByRole("button", { name: "Choose file" });
  const scroller = sourcesDialog.getByTestId("new-project-local-sources-scroll");
  await expect(chooseFile).toBeVisible();
  await expect(scroller).toBeVisible();
  await expect(sourcesDialog.getByText("Remote source that does not belong in local recents")).toHaveCount(0);
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const chooseFileBeforeBox = await chooseFile.boundingBox();
  const sourcesDialogBeforeBox = await sourcesDialog.boundingBox();
  expect(chooseFileBeforeBox).not.toBeNull();
  expect(sourcesDialogBeforeBox).not.toBeNull();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => scroller.evaluate((element) => Math.round(
    element.scrollHeight - element.scrollTop - element.clientHeight,
  ))).toBeLessThanOrEqual(1);
  await expect(chooseFile).toBeInViewport();
  const chooseFileAfterBox = await chooseFile.boundingBox();
  const sourcesDialogAfterBox = await sourcesDialog.boundingBox();
  expect(chooseFileAfterBox).not.toBeNull();
  expect(sourcesDialogAfterBox).not.toBeNull();
  const chooseFileOffsetBefore = chooseFileBeforeBox!.y - sourcesDialogBeforeBox!.y;
  const chooseFileOffsetAfter = chooseFileAfterBox!.y - sourcesDialogAfterBox!.y;
  expect(Math.abs(chooseFileOffsetAfter - chooseFileOffsetBefore)).toBeLessThanOrEqual(1);

  const firstSource = sourcesDialog.getByText("Recent local source 01", { exact: true });
  const secondSource = sourcesDialog.getByText("Recent local source 02", { exact: true });
  await firstSource.scrollIntoViewIfNeeded();
  await firstSource.locator("xpath=ancestor::label").click();
  await secondSource.locator("xpath=ancestor::label").click();
  await expect(sourcesDialog.getByText("2 sources selected", { exact: true })).toBeVisible();
  await sourcesDialog.getByRole("button", { name: "Add sources", exact: true }).click();

  await expect(sourcesDialog).toHaveCount(0);
  await expect(projectDialog.getByText("Recent local source 01", { exact: true })).toBeVisible();
  await expect(projectDialog.getByText("Recent local source 02", { exact: true })).toBeVisible();
  await expect(projectDialog.getByText("2 sources queued", { exact: true })).toBeVisible();

  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/orgs/${organization.id}/projects`)
    && response.ok(),
  );
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  const created = await (await createResponse).json() as {
    id: string;
    urlKey: string | null;
    resources: Array<{ resource: { name: string; locator: string } }>;
  };
  expect(created.resources.map((attachment) => attachment.resource.name).sort()).toEqual([
    "Recent local source 01",
    "Recent local source 02",
  ]);

  const detailResponse = await page.request.get(`/api/projects/${created.id}?orgId=${organization.id}`);
  expect(detailResponse.ok()).toBe(true);
  const detail = await detailResponse.json() as {
    resources: Array<{ resource: { name: string; locator: string } }>;
  };
  expect(detail.resources.map((attachment) => attachment.resource.name).sort()).toEqual([
    "Recent local source 01",
    "Recent local source 02",
  ]);

  await page.goto(`/${organization.issuePrefix}/projects/${created.urlKey ?? created.id}/resources`);
  await expect(page.getByText("Project Sources", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add sources", exact: true })).toBeVisible();
  await expect(page.getByText("Recent local source 01", { exact: true })).toBeVisible();
  await expect(page.getByText("Recent local source 02", { exact: true })).toBeVisible();
  expect(dialogAccessibilityMessages).toEqual([]);
});

test("adds a URL in its own focused source step", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 820 });
  const uniqueSuffix = Date.now().toString(36).slice(-6).toUpperCase();
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `New-Project-URL-Source-${Date.now()}`,
      issuePrefix: `PU${uniqueSuffix}`,
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

  const projectDialog = page.locator('[data-slot="dialog-content"]').filter({
    has: page.getByText("New project", { exact: true }),
  });
  await projectDialog.getByPlaceholder("Project name").fill("URL Source Project");
  await projectDialog.getByRole("button", { name: "Add sources" }).click();
  const sourcesDialog = page.getByTestId("new-project-add-sources-dialog");
  await sourcesDialog.getByRole("button", { name: /Add from URL/ }).click();

  const urlInput = sourcesDialog.getByLabel("URL");
  await expect(urlInput).toBeVisible();
  await expect(sourcesDialog.getByText("Recent sources", { exact: true })).toHaveCount(0);
  await expect(sourcesDialog.getByPlaceholder("Search Library or paste relative path")).toHaveCount(0);
  await urlInput.fill("not-a-url");
  await expect(sourcesDialog.getByText("Enter a valid http:// or https:// URL.")).toBeVisible();
  await expect(sourcesDialog.getByRole("button", { name: "Add source", exact: true })).toBeDisabled();
  await urlInput.fill("https://example.com/reference");
  await sourcesDialog.getByRole("button", { name: "Add source", exact: true }).click();

  await expect(sourcesDialog).toHaveCount(0);
  await expect(projectDialog.getByText("reference", { exact: true })).toBeVisible();
  await expect(projectDialog.getByText("1 source queued", { exact: true })).toBeVisible();

  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/orgs/${organization.id}/projects`)
    && response.ok(),
  );
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  const created = await (await createResponse).json() as {
    id: string;
    resources: Array<{ resource: { name: string; kind: string; locator: string } }>;
  };
  expect(created.resources).toEqual([
    expect.objectContaining({
      resource: expect.objectContaining({
        name: "reference",
        kind: "url",
        locator: "https://example.com/reference",
      }),
    }),
  ]);

  const detailResponse = await page.request.get(`/api/projects/${created.id}?orgId=${organization.id}`);
  expect(detailResponse.ok()).toBe(true);
  const detail = await detailResponse.json() as {
    resources: Array<{ resource: { name: string; kind: string; locator: string } }>;
  };
  expect(detail.resources[0]?.resource).toEqual(expect.objectContaining({
    name: "reference",
    kind: "url",
    locator: "https://example.com/reference",
  }));
});
