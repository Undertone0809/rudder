import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { E2E_BASE_URL, E2E_CODEX_STUB } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function createOrganization(request: APIRequestContext, label: string) {
  const response = await request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `${label}-${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as { id: string; issuePrefix: string };
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((selectedOrganizationId) => {
    window.localStorage.setItem(
      "rudder.selectedOrganizationId",
      selectedOrganizationId,
    );
  }, organizationId);
}

async function createWorkspaceFile(
  request: APIRequestContext,
  organizationId: string,
  filePath: string,
  content: string,
) {
  const response = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organizationId}/workspace/file`,
    { data: { filePath, content } },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function readWorkspaceFile(
  request: APIRequestContext,
  organizationId: string,
  filePath: string,
) {
  const response = await request.get(
    `${E2E_BASE_URL}/api/orgs/${organizationId}/workspace/file?path=${encodeURIComponent(filePath)}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as { content: string | null };
}

async function dispatchTextPaste(locator: Locator, text: string) {
  await locator.evaluate((element, pastedText) => {
    const data = new DataTransfer();
    data.setData("text/plain", pastedText);
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, text);
}

async function dispatchImagePaste(locator: Locator, names: string[]) {
  await locator.evaluate((element, fileNames) => {
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
      (character) => character.charCodeAt(0),
    );
    const data = new DataTransfer();
    for (const name of fileNames) {
      data.items.add(new File([bytes], name, { type: "image/png" }));
    }
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, names);
}

async function replaceCodeMirrorDocument(
  page: Page,
  editor: Locator,
  markdown: string,
) {
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(markdown);
}

async function blurCodeMirror(editor: Locator) {
  await editor.locator(".cm-content").evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
}

function activeRuntimeSurface(page: Page, owner: "main" | "side") {
  return page.locator(
    `[data-testid="live-surface-runtime-host"][data-owner-id^="${owner}:"][aria-hidden="false"]`,
  );
}

test("Library live preview reveals source, creates smart links, renders favicons, and preserves exact Markdown", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request, "Markdown-Live-Library");
  const filePath = "docs/live-preview.md";
  const secondFilePath = "docs/second.md";
  const initialMarkdown = [
    "# Live Preview",
    "",
    `Read [OpenAI](https://openai.com) and [Second file](library-file://file?p=${encodeURIComponent(secondFilePath)}).`,
  ].join("\n");
  await createWorkspaceFile(
    request,
    organization.id,
    filePath,
    initialMarkdown,
  );
  await createWorkspaceFile(
    request,
    organization.id,
    secondFilePath,
    "# Second file\n\nSwitch target.\n",
  );
  await selectOrganization(page, organization.id);

  const metadataPurposes: string[] = [];
  await page.route("**/api/website-metadata?*", async (route) => {
    const url = new URL(route.request().url());
    const purpose = url.searchParams.get("purpose") ?? "preview";
    metadataPurposes.push(purpose);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        url: url.searchParams.get("url"),
        siteName: "GitHub",
        pageTitle: "openai/codex",
        iconUrl: null,
      }),
    });
  });

  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`,
  );

  const editor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  const headingPreview = editor.locator(
    '[data-markdown-preview-state="preview"][data-source-line-start="1"]',
  );
  const websitePreview = editor.locator(
    '[data-markdown-preview-state="preview"][data-source-line-start="3"]',
  );
  await expect(headingPreview).toContainText("Live Preview");
  await expect(headingPreview).not.toContainText("# Live Preview");
  await expect(
    websitePreview.locator("[data-website-icon]").first(),
  ).toBeVisible();
  expect(metadataPurposes).not.toContain("preview");

  await websitePreview.locator(".rudder-cm-markdown-link").first().click();
  const websiteSource = editor.locator(
    '[data-markdown-preview-state="source"][data-source-line-start="3"]',
  );
  await expect(websiteSource).toContainText(
    "Read [OpenAI](https://openai.com)",
  );
  await expect(websiteSource.locator("[data-website-icon]")).toHaveCount(0);

  await editor.locator(".cm-content").press("End");
  await editor.locator(".cm-content").press("Enter");
  const pastedUrl = "https://github.com/openai/codex";
  await dispatchTextPaste(editor.locator(".cm-content"), pastedUrl);
  const pastedSource = editor.locator(
    '[data-markdown-preview-state="source"][data-source-line-start="4"]',
  );
  await expect(pastedSource).toContainText(
    "[openai/codex](https://github.com/openai/codex)",
  );
  expect(metadataPurposes).toEqual(["authoring"]);

  await blurCodeMirror(editor);
  const pastedPreview = editor.locator(
    '[data-markdown-preview-state="preview"][data-source-line-start="4"]',
  );
  await expect(pastedPreview).toContainText("openai/codex");
  await expect(
    pastedPreview.locator("[data-website-icon]").first(),
  ).toBeVisible();

  const expectedMarkdown = `${initialMarkdown}\n[openai/codex](${pastedUrl})`;
  await expect.poll(async () => (
    await readWorkspaceFile(request, organization.id, filePath)
  ).content).toBe(expectedMarkdown);

  await page.reload();
  await expect(
    page
      .getByTestId("org-workspaces-markdown-editor")
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "openai/codex" }),
  ).toBeVisible();

  let releaseFirstSave!: () => void;
  let markFirstSaveStarted!: () => void;
  const firstSaveGate = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const firstSaveStarted = new Promise<void>((resolve) => {
    markFirstSaveStarted = resolve;
  });
  await page.route("**/api/orgs/*/workspace/file?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      route.request().method() === "PATCH"
      && requestUrl.searchParams.get("path") === filePath
    ) {
      markFirstSaveStarted();
      await firstSaveGate;
    }
    await route.continue();
  });

  const reloadedEditor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await reloadedEditor.locator(".cm-content").click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.insertText("\nQueued before tab switch.");
  await firstSaveStarted;
  await reloadedEditor.getByText("second.md", { exact: true }).click();
  await expect(
    page.getByTestId("org-workspaces-editor-tabs").locator("[role='tab'][aria-selected='true']"),
  ).toContainText("second.md");
  await page.getByTestId(`org-workspaces-editor-tab-${filePath}`).click();
  await expect(reloadedEditor).toContainText("Queued before tab switch.");
  releaseFirstSave();
  await page.unroute("**/api/orgs/*/workspace/file?*");

  const savedAfterSwitch = `${expectedMarkdown}\nQueued before tab switch.`;
  await expect.poll(async () => (
    await readWorkspaceFile(request, organization.id, filePath)
  ).content).toBe(savedAfterSwitch);
  await expect(
    page.getByText("This file changed since it was opened. Reload it before saving again."),
  ).toHaveCount(0);
  await expect(reloadedEditor).toBeVisible();

  let transientPatchCount = 0;
  const transientRoutePattern = "**/api/orgs/*/workspace/file?*";
  const transientRouteHandler = async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (
      route.request().method() === "PATCH"
      && requestUrl.searchParams.get("path") === filePath
    ) {
      transientPatchCount += 1;
      if (transientPatchCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary save failure" }),
        });
        return;
      }
    }
    await route.continue();
  };
  await page.route(transientRoutePattern, transientRouteHandler);
  const savedAfterTransient = `${savedAfterSwitch}\nRetried unchanged draft.`;
  await replaceCodeMirrorDocument(page, reloadedEditor, savedAfterTransient);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(transientPatchCount).toBe(1);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(async () => (
    await readWorkspaceFile(request, organization.id, filePath)
  ).content).toBe(savedAfterTransient);
  expect(transientPatchCount).toBe(2);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.unroute(transientRoutePattern, transientRouteHandler);

  const concurrentMarkdown = "# Concurrent server edit\n\nKeep this revision.\n";
  const concurrentWrite = await request.patch(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
    { data: { content: concurrentMarkdown, expectedContent: savedAfterTransient } },
  );
  expect(concurrentWrite.ok(), await concurrentWrite.text()).toBe(true);

  let conflictPatchCount = 0;
  const conflictRoutePattern = "**/api/orgs/*/workspace/file?*";
  const conflictRouteHandler = async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (
      route.request().method() === "PATCH"
      && requestUrl.searchParams.get("path") === filePath
    ) {
      conflictPatchCount += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "This file changed since it was opened. Reload it before saving again.",
        }),
      });
      return;
    }
    await route.continue();
  };
  await page.route(conflictRoutePattern, conflictRouteHandler);
  await replaceCodeMirrorDocument(
    page,
    reloadedEditor,
    `${savedAfterTransient}\nLocal conflicting edit.`,
  );
  await expect(page.getByRole("button", { name: "Reload latest" })).toBeVisible();
  expect(conflictPatchCount).toBe(1);
  expect((
    await readWorkspaceFile(request, organization.id, filePath)
  ).content).toBe(concurrentMarkdown);

  await page.unroute(conflictRoutePattern, conflictRouteHandler);
  await page.getByRole("button", { name: "Reload latest" }).click();
  await expect(
    reloadedEditor
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "Concurrent server edit" }),
  ).toBeVisible();
});

test("Library Main Workbench edits with CodeMirror and round-trips exact Markdown", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request, "Markdown-Live-Workbench");
  const filePath = "workbench-live-preview.md";
  const initialMarkdown = "# Workbench Library\n\nInitial body.\n";
  await createWorkspaceFile(
    request,
    organization.id,
    filePath,
    initialMarkdown,
  );
  const groupResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/messenger/groups`,
    { data: { name: "Workbench review" } },
  );
  expect(groupResponse.ok(), await groupResponse.text()).toBe(true);
  await selectOrganization(page, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click({ force: true });
  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(
    sidePanel.getByTestId("chat-side-panel-empty-state"),
  ).toBeVisible({ timeout: 15_000 });
  await sidePanel.getByTestId("chat-side-panel-empty-library-target").click();
  const directoryView = activeRuntimeSurface(page, "side").getByTestId(
    "chat-side-panel-library-directory-view",
  );
  await expect(directoryView).toBeVisible();
  await directoryView.getByRole("button", { name: filePath, exact: true }).click();
  await expect(
    activeRuntimeSurface(page, "side").getByTestId(
      "chat-side-panel-library-file-view",
    ),
  ).toBeVisible();

  await sidePanel.getByTestId("chat-side-panel-keep-in-messenger").click();
  await page.getByRole("menuitem", { name: "Workbench review" }).evaluate(
    (element) => (element as HTMLElement).click(),
  );
  await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
  const workbench = page.getByTestId("messenger-main-workbench");
  await expect(
    workbench.getByRole("tab", { name: filePath }),
  ).toHaveAttribute("aria-selected", "true");
  const editor = activeRuntimeSurface(page, "main").locator(
    '[data-editor-engine="codemirror-live-preview"]',
  );
  await expect(editor).toBeVisible();
  await expect(
    editor.locator('[data-markdown-preview-state="preview"]').filter({
      hasText: "Workbench Library",
    }),
  ).toBeVisible();

  const exactMarkdown = "\n  ## Workbench Exact Source  \n\n- preserved\n";
  await replaceCodeMirrorDocument(page, editor, exactMarkdown);
  await blurCodeMirror(editor);
  await expect.poll(async () => (
    await readWorkspaceFile(request, organization.id, filePath)
  ).content).toBe(exactMarkdown);
});

test("Issue description switches between preview and source and round-trips exact Markdown", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request, "Markdown-Live-Issue");
  const issueResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/issues`,
    {
      data: {
        title: "Exact Markdown issue",
        description: "# Existing issue\n\nInitial body.",
        status: "todo",
        priority: "medium",
      },
    },
  );
  expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
  const issue = await issueResponse.json() as {
    id: string;
    identifier: string | null;
  };
  await selectOrganization(page, organization.id);
  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`,
  );

  const editor = page
    .locator(".rudder-issue-description-surface")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  await blurCodeMirror(editor);
  const existingPreview = editor
    .locator('[data-markdown-preview-state="preview"]')
    .filter({ hasText: "Existing issue" });
  await expect(existingPreview).toBeVisible();
  await existingPreview.dispatchEvent("mousedown", { button: 0 });
  await expect(
    editor.locator('[data-markdown-preview-state="source"]').first(),
  ).toContainText("# Existing issue");

  const exactMarkdown = "\n  # Exact Issue Source  \n\n\\*escaped\\*\n";
  await replaceCodeMirrorDocument(page, editor, exactMarkdown);
  await blurCodeMirror(editor);

  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/issues/${issue.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(exactMarkdown);

  await page.reload();
  await expect(
    page
      .locator(".rudder-issue-description-surface")
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "Exact Issue Source" }),
  ).toBeVisible();
});

test("Automation instructions use live preview and preserve exact Markdown through autosave", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(
    request,
    "Markdown-Live-Automation",
  );
  const agentResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/agents`,
    {
      data: {
        name: "Markdown Automation Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    },
  );
  expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
  const agent = await agentResponse.json() as { id: string };
  const automationResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/automations`,
    {
      data: {
        title: "Exact instruction automation",
        description: [
          "# Existing instructions",
          "",
          "| Step | Owner |",
          "| --- | --- |",
          "| Run safely | Agent |",
        ].join("\n"),
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    },
  );
  expect(automationResponse.ok(), await automationResponse.text()).toBe(true);
  const automation = await automationResponse.json() as { id: string };
  await selectOrganization(page, organization.id);
  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/automations/${automation.id}`,
  );

  const editor = page
    .getByTestId("automation-detail-shell")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  const instructionsPreview = editor
    .locator('[data-markdown-preview-state="preview"]')
    .filter({ hasText: "Existing instructions" });
  await expect(instructionsPreview).toBeVisible();
  await instructionsPreview.dispatchEvent("mousedown", { button: 0 });
  await expect(
    editor.locator('[data-markdown-preview-state="source"]').first(),
  ).toContainText("# Existing instructions");

  await blurCodeMirror(editor);
  const runCell = editor.getByRole("cell", { name: "Run safely" });
  await runCell.hover();
  await expect(page.getByRole("button", { name: "Open block actions for line 5" })).toBeVisible();
  await runCell.dispatchEvent("mousedown", { button: 0 });
  const runCellEditor = page.getByRole("textbox", { name: "Edit table cell row 2 column 1" });
  await expect(runCellEditor).toBeVisible();
  await runCellEditor.fill("Review safely");
  await expect(runCellEditor).toHaveValue("Review safely");
  await runCellEditor.press("Enter");
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/automations/${automation.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toContain("| Review safely | Agent |");
  await expect(editor.getByRole("cell", { name: "Review safely" })).toBeVisible();
  await expect(editor.getByRole("cell", { name: "Agent" })).toBeVisible();

  await editor.getByRole("cell", { name: "Review safely" }).dispatchEvent("mousedown", { button: 0 });
  const boundaryCellEditor = page.getByRole("textbox", { name: "Edit table cell row 2 column 1" });
  await boundaryCellEditor.fill(String.raw`Review||safe\\|ly`);
  await boundaryCellEditor.press("Tab");
  const ownerCellEditor = page.getByRole("textbox", { name: "Edit table cell row 2 column 2" });
  await expect(ownerCellEditor).toHaveValue("Agent");
  await ownerCellEditor.fill("Operator");
  await page.getByRole("textbox", { name: "Automation title" }).click();
  await expect(editor.getByRole("cell", { name: String.raw`Review||safe\|ly` })).toBeVisible();
  await expect(editor.getByRole("cell", { name: "Operator" })).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/automations/${automation.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toContain(String.raw`| Review\|\|safe\\\|ly | Operator |`);

  await editor.getByRole("cell", { name: "Operator" }).dispatchEvent("mousedown", { button: 0 });
  const cancelledCellEditor = page.getByRole("textbox", { name: "Edit table cell row 2 column 2" });
  await cancelledCellEditor.fill("Cancelled");
  await cancelledCellEditor.press("Escape");
  await expect(editor.getByRole("cell", { name: "Operator" })).toBeVisible();
  await expect(editor.getByRole("cell", { name: "Cancelled" })).toHaveCount(0);

  const exactMarkdown = "\n  ## Exact Automation Source  \n\n`literal`\n";
  await replaceCodeMirrorDocument(page, editor, exactMarkdown);

  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/automations/${automation.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(exactMarkdown);

  await blurCodeMirror(editor);
  await expect(
    editor
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "Exact Automation Source" }),
  ).toBeVisible();

  const markdownBeforeImages = `${exactMarkdown}\n`;
  await replaceCodeMirrorDocument(page, editor, markdownBeforeImages);
  await dispatchImagePaste(editor.locator(".cm-content"), ["first.png", "second.png"]);
  await expect(editor.locator('img[alt="first.png"]')).toBeVisible();
  await expect(editor.locator('img[alt="second.png"]')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/automations/${automation.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toMatch(/!\[first\.png\]\([^\n]+\)\n!\[second\.png\]\([^\n]+\)$/u);

  await editor.locator(".cm-content").click();
  await page.keyboard.press(`${modifier}+z`);
  await expect(editor.locator('img[alt="first.png"]')).toHaveCount(0);
  await expect(editor.locator('img[alt="second.png"]')).toHaveCount(0);
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/automations/${automation.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(markdownBeforeImages);
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect(editor.locator('img[alt="first.png"]')).toBeVisible();
  await expect(editor.locator('img[alt="second.png"]')).toBeVisible();

  await editor.locator('img[alt="first.png"]').click();
  await expect(page.getByTestId("markdown-body-image-preview-dialog")).toBeVisible();
  await expect(editor.locator('img[alt="first.png"]')).toBeVisible();
  await expect(editor.locator('img[alt="second.png"]')).toBeVisible();
  await expect(
    editor.locator('[data-markdown-preview-state="source"]').filter({ hasText: "![first.png]" }),
  ).toHaveCount(0);
  await expect(
    editor.locator('[data-markdown-preview-state="source"]').filter({ hasText: "![second.png]" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await replaceCodeMirrorDocument(page, editor, markdownBeforeImages);
  await page.route("**/api/orgs/*/assets/images", async (route) => {
    const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
    if (body.includes("broken.png")) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Upload unavailable"}' });
      return;
    }
    await route.continue();
  });
  await dispatchImagePaste(editor.locator(".cm-content"), ["first-ok.png", "broken.png", "third-ok.png"]);
  await expect(editor.locator('img[alt="first-ok.png"]')).toBeVisible();
  await expect(editor.locator('img[alt="third-ok.png"]')).toBeVisible();
  await expect(editor.locator('img[alt="broken.png"]')).toHaveCount(0);
  await expect(editor.getByText(/1 of 3 images failed to upload\./u)).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/automations/${automation.id}?_=${Date.now()}`,
    );
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toMatch(/!\[first-ok\.png\]\([^\n]+\)\n!\[third-ok\.png\]\([^\n]+\)$/u);
  await page.unroute("**/api/orgs/*/assets/images");
});

test("Goal descriptions use live preview and round-trip exact Markdown", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request, "Markdown-Live-Goal");
  const goalResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/goals`,
    {
      data: {
        title: "Exact Markdown goal",
        description: "# Existing goal\n\nInitial goal body.",
        status: "active",
        level: "team",
      },
    },
  );
  expect(goalResponse.ok(), await goalResponse.text()).toBe(true);
  const goal = await goalResponse.json() as { id: string };
  await selectOrganization(page, organization.id);
  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/goals/${goal.id}`,
  );

  const editor = page.locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  await expect(
    editor.locator('[data-markdown-preview-state="preview"]').filter({
      hasText: "Existing goal",
    }),
  ).toBeVisible();

  const exactMarkdown = "\n  ## Exact Goal Source  \n\n- preserve\n- spacing\n";
  await replaceCodeMirrorDocument(page, editor, exactMarkdown);
  await blurCodeMirror(editor);

  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/goals/${goal.id}?_=${Date.now()}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(exactMarkdown);

  await page.reload();
  await expect(
    page
      .locator('[data-editor-engine="codemirror-live-preview"]')
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "Exact Goal Source" }),
  ).toBeVisible();
});

test("Project descriptions use live preview and round-trip exact Markdown", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request, "Markdown-Live-Project");
  const projectResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/projects`,
    {
      data: {
        name: "Exact Markdown project",
        description: "# Existing project\n\nInitial project body.",
        status: "in_progress",
      },
    },
  );
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = await projectResponse.json() as {
    id: string;
    urlKey?: string | null;
  };
  await selectOrganization(page, organization.id);
  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/projects/${project.urlKey ?? project.id}/configuration`,
  );

  const editor = page.locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  await expect(
    editor.locator('[data-markdown-preview-state="preview"]').filter({
      hasText: "Existing project",
    }),
  ).toBeVisible();

  const exactMarkdown = "\n  ## Exact Project Source  \n\n\\*literal\\*\n";
  await replaceCodeMirrorDocument(page, editor, exactMarkdown);
  await blurCodeMirror(editor);

  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/projects/${project.id}?orgId=${organization.id}&_=${Date.now()}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(exactMarkdown);

  await page.reload();
  await expect(
    page
      .locator('[data-editor-engine="codemirror-live-preview"]')
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "Exact Project Source" }),
  ).toBeVisible();
});

test("New Goal and New Project preserve exact CodeMirror descriptions", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(
    request,
    "Markdown-Live-Create-Goal-Project",
  );
  await selectOrganization(page, organization.id);
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/goals`);

  await page.getByRole("button", { name: "Add Goal" }).click();
  const goalDialog = page
    .locator('[data-slot="dialog-content"]')
    .filter({ has: page.getByText("New goal", { exact: true }) })
    .first();
  await expect(goalDialog).toBeVisible();
  await goalDialog.getByPlaceholder("Goal title").fill("Created Markdown goal");
  const exactGoalMarkdown = "  ## Created Goal Source  \n\n- exact\n";
  await replaceCodeMirrorDocument(
    page,
    goalDialog.locator('[data-editor-engine="codemirror-live-preview"]'),
    exactGoalMarkdown,
  );
  const goalCreateResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/orgs/${organization.id}/goals`)
    && response.ok()
  ));
  await goalDialog.getByRole("button", { name: "Create goal" }).click();
  const createdGoal = await (await goalCreateResponse).json() as {
    id: string;
    description: string | null;
  };
  expect(createdGoal.description).toBe(exactGoalMarkdown);
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/goals/${createdGoal.id}?_=${Date.now()}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as { description: string | null }).description;
  }).toBe(exactGoalMarkdown);

  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
  await page
    .getByTestId("primary-rail")
    .getByRole("button", { name: "Create" })
    .click();
  await page.getByRole("menuitem", { name: "Create new project" }).click();
  const projectDialog = page
    .locator('[data-slot="dialog-content"]')
    .filter({ has: page.getByText("New project", { exact: true }) })
    .first();
  await expect(projectDialog).toBeVisible();
  await projectDialog
    .getByPlaceholder("Project name")
    .fill("Created Markdown project");
  const exactProjectMarkdown = "  ## Created Project Source  \n\n\\*literal\\*\n";
  await replaceCodeMirrorDocument(
    page,
    projectDialog.locator('[data-editor-engine="codemirror-live-preview"]'),
    exactProjectMarkdown,
  );
  const projectCreateResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/orgs/${organization.id}/projects`)
    && response.ok()
  ));
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  const createdProject = await (await projectCreateResponse).json() as {
    id: string;
    description: string | null;
  };
  expect(createdProject.description).toBe(exactProjectMarkdown);
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/projects/${createdProject.id}?orgId=${organization.id}&_=${Date.now()}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as { description: string | null }).description;
  }).toBe(exactProjectMarkdown);
});

test("Chat paste remains plain text and never enables document live preview", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request, "Markdown-Live-Chat");
  const agentResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/agents`,
    {
      data: {
        name: "Plain Text Chat Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    },
  );
  expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
  const agent = await agentResponse.json() as { id: string };
  const chatResponse = await request.post(
    `${E2E_BASE_URL}/api/orgs/${organization.id}/chats`,
    {
      data: {
        title: "Plain URL paste",
        preferredAgentId: agent.id,
        initialMessage: { body: "Chat plain-text regression setup." },
      },
    },
  );
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  const chat = await chatResponse.json() as { id: string };
  await selectOrganization(page, organization.id);

  const metadataRequests: string[] = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.url().includes("/api/website-metadata")) {
      metadataRequests.push(browserRequest.url());
    }
  });
  await page.goto(
    `${E2E_BASE_URL}/${organization.issuePrefix}/messenger/chat/${chat.id}`,
  );

  await expect(
    page.locator('[data-editor-engine="codemirror-live-preview"]'),
  ).toHaveCount(0);
  const composer = page
    .getByTestId("chat-composer-editor-scroll")
    .locator('[contenteditable="true"]')
    .first();
  await expect(composer).toBeVisible();
  const pastedUrl = "https://github.com/openai/codex";
  await composer.focus();
  await dispatchTextPaste(composer, pastedUrl);

  await expect(composer).toContainText(pastedUrl);
  await expect(composer).not.toContainText(`[GitHub](${pastedUrl})`);
  await expect(composer.locator("[data-website-icon]")).toHaveCount(0);
  expect(metadataRequests).toHaveLength(0);

  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled({ timeout: 15_000 });
  await sendButton.click();
  await expect.poll(async () => {
    const response = await request.get(
      `${E2E_BASE_URL}/api/chats/${chat.id}/messages`,
    );
    expect(response.ok()).toBe(true);
    const messages = await response.json() as Array<{
      role: string;
      body: string;
    }>;
    return messages
      .filter((message) => message.role === "user")
      .at(-1)?.body ?? null;
  }).toBe(pastedUrl);
  await expect(
    page.getByTestId("chat-user-message-bubble").filter({ hasText: pastedUrl }),
  ).toBeVisible();
});
