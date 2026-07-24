import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function createOrg(page: import("@playwright/test").Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return await orgRes.json() as {
    id: string;
    issuePrefix: string;
    urlKey?: string | null;
  };
}

async function selectOrg(page: import("@playwright/test").Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organizationId);
}

async function writeWorkspaceFile(
  page: import("@playwright/test").Page,
  organizationId: string,
  filePath: string,
  content: string,
) {
  const fileRes = await page.request.post(`/api/orgs/${organizationId}/workspace/file`, {
    data: { filePath, content },
  });
  expect(fileRes.ok()).toBe(true);
}

async function revealLibraryDocumentOutline(page: import("@playwright/test").Page) {
  await expect(page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("org-workspaces-document-outline")).toBeVisible({ timeout: 15_000 });
}

test("Library markdown Agent links return to the document on Escape", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Escape");
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Asher",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };
  const filePath = "docs/agent-link.md";

  await writeWorkspaceFile(
    page,
    organization.id,
    filePath,
    `# Agent Link\n\nOpen [Asher](agent://${agent.id}) from this document.\n`,
  );
  await selectOrg(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const organizationRouteKey = organization.urlKey ?? organization.issuePrefix;
  await page.getByRole("link", { name: /Asher/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/${organizationRouteKey}/agents/[^/]+(?:/dashboard)?$`),
  );

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/${organizationRouteKey}/library\\?path=${encodeURIComponent(filePath)}`));
  await expect(page.getByTestId("org-workspaces-markdown-editor").locator("h1", { hasText: "Agent Link" })).toBeVisible();
});

test("Library markdown blank area clicks focus the editor", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Blank-Focus");
  const filePath = "docs/blank-focus.md";
  await writeWorkspaceFile(page, organization.id, filePath, "# Blank Focus\n\n");
  await selectOrg(page, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editorScroll = page.getByTestId("org-workspaces-markdown-editor");
  const editor = editorScroll.locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor.locator(".cm-content")).toBeVisible();
  const box = await editorScroll.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + 140, box!.y + box!.height - 80);
  await page.keyboard.type("Blank area text");

  await expect(editor.locator(".cm-content")).toContainText("Blank area text");
});

test("Library markdown paste parses markdown syntax and keeps code blocks readable", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Paste");
  const filePath = "docs/paste.md";
  await writeWorkspaceFile(
    page,
    organization.id,
    filePath,
    "# Paste Target\n\n```md\n# Context\n```\n",
  );
  await selectOrg(page, organization.id);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor.locator("pre")).toBeVisible();
  await expect(editor.locator("pre").first()).toHaveCSS("background-color", "rgb(27, 28, 25)");
  await page.evaluate(() => navigator.clipboard.writeText("## HEAD2"));
  const sourceEditor = editor.locator(".cm-content");
  await sourceEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await sourceEditor.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });

  await expect(editor.locator("h2", { hasText: "HEAD2" })).toBeVisible();
  await expect(editor).not.toContainText("## HEAD2");
});

test("Library markdown copied list selections keep Markdown bullet markers", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Copy-List");
  const filePath = "docs/heartbeat-copy.md";
  const checklistMarkdown = [
    "# Runtime Heartbeat Checklist Copy Fixture",
    "",
    "## 6. Exit",
    "",
    "- Comment on in_progress work before exiting.",
    "- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.",
    "- A successful `todo` or `in_progress` issue run without a close-out signal can trigger a same-agent passive follow-up.",
    "- Exit cleanly if no assignments.",
    "",
    "## Ordered Follow-up",
    "",
    "3. Read today's plan from memory.",
    "4. Review planned items.",
    "",
  ].join("\n");
  await writeWorkspaceFile(
    page,
    organization.id,
    filePath,
    checklistMarkdown,
  );
  await selectOrg(page, organization.id);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor.locator("h2", { hasText: "Exit" })).toBeVisible();
  const copyRenderedMarkdown = async (selector: string) => {
    return await editor.evaluate((element, targetSelector) => {
      const targets = Array.from(element.querySelectorAll(targetSelector));
      if (targets.length === 0) {
        throw new Error(`Expected rendered Markdown nodes: ${targetSelector}`);
      }
      return targets.map((target) => {
        const markdownBody = target.closest<HTMLElement>("[data-copy-markdown-source='true']");
        if (!markdownBody) {
          throw new Error(`Expected rendered Markdown source for: ${targetSelector}`);
        }
        const range = document.createRange();
        range.selectNode(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const clipboardData = new DataTransfer();
        const copyEvent = new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
        markdownBody.dispatchEvent(copyEvent);
        if (!copyEvent.defaultPrevented) {
          throw new Error(`Rendered Markdown copy was not handled for: ${targetSelector}`);
        }
        return clipboardData.getData("text/plain");
      }).join("\n");
    }, selector);
  };

  expect(await copyRenderedMarkdown("ul li")).toBe([
    "- Comment on in_progress work before exiting.",
    "- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.",
    "- A successful `todo` or `in_progress` issue run without a close-out signal can trigger a same-agent passive follow-up.",
    "- Exit cleanly if no assignments.",
  ].join("\n"));

  expect(await copyRenderedMarkdown("ol li")).toBe([
    "3. Read today's plan from memory.",
    "4. Review planned items.",
  ].join("\n"));

  const sourceEditor = editor.locator(".cm-content");
  await sourceEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("__rudder_clipboard_sentinel__"));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(checklistMarkdown);
});

test("Library legacy HEARTBEAT.md opens the deprecation cleanup dialog", async ({ page }) => {
  const organization = await createOrg(page, "Library-Legacy-Heartbeat-Dialog");
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Wesley",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agentsDirectoryRes = await page.request.get(
    `/api/orgs/${organization.id}/workspace/files?path=${encodeURIComponent("agents")}`,
  );
  expect(agentsDirectoryRes.ok()).toBe(true);
  const agentsDirectory = await agentsDirectoryRes.json() as {
    entries: Array<{ displayLabel?: string | null; path: string }>;
  };
  const agentWorkspace = agentsDirectory.entries.find((entry) => entry.displayLabel === "Wesley");
  expect(agentWorkspace).toBeTruthy();
  const heartbeatPath = `${agentWorkspace!.path}/instructions/HEARTBEAT.md`;
  const memoryPath = `${agentWorkspace!.path}/instructions/MEMORY.md`;
  await writeWorkspaceFile(page, organization.id, heartbeatPath, "# Legacy Heartbeat\n\nManual routine.\n");
  await writeWorkspaceFile(page, organization.id, memoryPath, "# Memory\n\nKeep this.\n");
  await selectOrg(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(heartbeatPath)}`);

  const dialog = page.getByRole("dialog", { name: "Legacy HEARTBEAT.md" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Heartbeat instructions are built into Rudder runtime now");
  await expect(page.getByTestId("org-workspaces-markdown-editor")).toHaveCount(0);

  const deleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().includes(`/api/orgs/${organization.id}/workspace/legacy-heartbeat-instructions`)
    && response.status() === 200,
  );
  await dialog.getByRole("button", { name: "Delete all legacy HEARTBEAT.md files" }).click();
  await deleteResponse;
  await expect(dialog).toHaveCount(0);

  const heartbeatRes = await page.request.get(`/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(heartbeatPath)}`);
  expect(heartbeatRes.ok()).toBe(false);
  const memoryRes = await page.request.get(`/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(memoryPath)}`);
  expect(memoryRes.ok()).toBe(true);
});

test("Library markdown pasted images are uploaded as assets before save", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Image-Upload");
  const filePath = "docs/image-upload.md";
  await writeWorkspaceFile(page, organization.id, filePath, "# Image Upload\n\n");
  await selectOrg(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor.locator("h1", { hasText: "Image Upload" })).toBeVisible();

  const uploadResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/orgs/${organization.id}/assets/images`)
    && response.status() === 201,
  );

  const sourceEditor = editor.locator(".cm-content");
  await sourceEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await sourceEditor.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context for Library image upload test");
    }
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#2563eb";
    context.fillRect(32, 32, canvas.width - 64, canvas.height - 64);
    context.fillStyle = "#ffffff";
    context.font = "bold 24px sans-serif";
    context.fillText("Library", 112, 98);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      throw new Error("Failed to create PNG blob for Library image upload test");
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([blob], "library-screenshot.png", { type: "image/png" }));

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: dataTransfer,
    });
    element.dispatchEvent(pasteEvent);
  });

  const uploadedAsset = await (await uploadResponse).json() as { contentPath: string };
  expect(uploadedAsset.contentPath).toMatch(/^\/api\/assets\/[^/]+\/content$/);
  await sourceEditor.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  await expect(editor.locator(`img[src="${uploadedAsset.contentPath}"]`)).toBeVisible();

  await expect.poll(async () => {
    const fileRes = await page.request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
    expect(fileRes.ok()).toBe(true);
    const detail = await fileRes.json() as { content: string | null };
    return detail.content ?? "";
  }).toContain(uploadedAsset.contentPath);

  const savedFileRes = await page.request.get(
    `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`,
  );
  expect(savedFileRes.ok()).toBe(true);
  const savedFile = await savedFileRes.json() as { content: string | null };
  expect(savedFile.content).toContain(`![library-screenshot.png](${uploadedAsset.contentPath})`);
  expect(savedFile.content).not.toContain("data:image");
});

test("Library markdown files reject embedded image data URLs", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Image-Data-Url");

  const createRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: "docs/data-url-create.md",
      content: "![Screenshot](data:image/svg+xml,%3Csvg%3E%3C/svg%3E)\n",
    },
  });
  expect(createRes.status()).toBe(422);
  await expect(createRes.json()).resolves.toMatchObject({
    error: expect.stringContaining("Embedded image data URLs are not allowed"),
  });

  const filePath = "docs/data-url-update.md";
  await writeWorkspaceFile(page, organization.id, filePath, "# Screenshot\n\n");
  const updateRes = await page.request.patch(`/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(filePath)}`, {
    data: {
      content: "![Screenshot](data:image/jpeg;base64,/9j/4AAQSkZJRg==)\n",
    },
  });
  expect(updateRes.status()).toBe(422);
  await expect(updateRes.json()).resolves.toMatchObject({
    error: expect.stringContaining("Embedded image data URLs are not allowed"),
  });
});

test("Library markdown tables keep readable columns inside the document pane", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Table-Layout");
  const filePath = "projects/research/openclaw-dreaming-mechanism.md";
  await writeWorkspaceFile(
    page,
    organization.id,
    filePath,
    [
      "# OpenClaw Dreaming 机制解析",
      "",
      "## 摘要",
      "",
      "OpenClaw 的 Dreaming 不是让模型在当前对话里自由“做梦”。",
      "",
      "## 资料来源与可靠性",
      "",
      "| 来源 | 可靠性 | 支撑内容 |",
      "|---|---|---|",
      "| OpenClaw 官方 Dreaming 概念文档: https://docs.openclaw.ai/concepts/dreaming | 官方文档 | Dreaming 的阶段模型、写入位置、默认启用方式、CLI/UI 入口、Deep ranking signal。 |",
      "| OpenClaw 源码, `openclaw/openclaw` commit 301213a05f2fefff88797d43c0c2cae7008c7699: https://github.com/openclaw/openclaw/tree/301213a05f2fefff88797d43c0c2cae7008c7699 | 开源实现 | 配置默认值、phase 执行顺序、candidate scoring 和 promotion 阈值。 |",
      "",
      "## 继续分析",
      "",
      "Done.",
    ].join("\n"),
  );
  await selectOrg(page, organization.id);
  await page.setViewportSize({ width: 1800, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page
    .getByTestId("org-workspaces-markdown-editor")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  const table = editor.locator("table").first();
  await expect(table).toBeVisible();
  await revealLibraryDocumentOutline(page);

  const metrics = await table.evaluate((element) => {
    const reliabilityHeader = element.querySelector("th:nth-child(2)");
    const supportHeader = element.querySelector("th:nth-child(3)");
    const supportCell = element.querySelector("tbody tr:first-child td:nth-child(3), tr:nth-child(2) td:nth-child(3)");
    const tableViewport = element.closest<HTMLElement>(".rudder-markdown-table-scroll");
    const outline = document.querySelector('[data-testid="org-workspaces-document-outline"]');
    const tableViewportRect = tableViewport?.getBoundingClientRect();
    const outlineRect = outline?.getBoundingClientRect();
    const reliabilityRect = reliabilityHeader?.getBoundingClientRect();
    const supportRect = supportCell?.getBoundingClientRect();
    return {
      tableViewportRight: tableViewportRect?.right ?? Number.POSITIVE_INFINITY,
      outlineLeft: outlineRect?.left ?? 0,
      tableClientWidth: tableViewport?.clientWidth ?? 0,
      tableScrollWidth: tableViewport?.scrollWidth ?? 0,
      tableOverflowX: tableViewport ? getComputedStyle(tableViewport).overflowX : "",
      reliabilityHeaderWidth: reliabilityRect?.width ?? 0,
      reliabilityHeaderHeight: reliabilityRect?.height ?? 0,
      supportHeaderText: supportHeader?.textContent ?? "",
      supportCellWidth: supportRect?.width ?? 0,
    };
  });

  expect(metrics.tableViewportRight).toBeLessThan(metrics.outlineLeft);
  expect(metrics.tableOverflowX).toBe("auto");
  expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.tableClientWidth);
  expect(metrics.reliabilityHeaderWidth).toBeGreaterThan(120);
  expect(metrics.reliabilityHeaderHeight).toBeLessThan(60);
  expect(metrics.supportHeaderText).toBe("支撑内容");
  expect(metrics.supportCellWidth).toBeGreaterThan(120);
});

test("Library markdown section jumps align headings to the top of the editor viewport", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Outline");
  const filePath = "docs/outline.md";
  const filler = Array.from({ length: 34 }, (_, index) => `Intro ${index + 1}`).join("\n\n");
  await writeWorkspaceFile(page, organization.id, filePath, `# Outline\n\n${filler}\n\n## Target Section\n\nDone.\n`);
  await selectOrg(page, organization.id);
  await page.setViewportSize({ width: 1800, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editorScroll = page.getByTestId("org-workspaces-markdown-editor");
  await revealLibraryDocumentOutline(page);
  const targetSectionButton = page
    .getByTestId("org-workspaces-document-outline")
    .getByRole("button", { name: "Target Section" });
  await expect(targetSectionButton).toBeVisible();
  await targetSectionButton.click();
  const targetSource = editorScroll.locator(
    '[data-markdown-preview-state="source"][data-source-line-start]',
    { hasText: "## Target Section" },
  );

  await expect.poll(async () => {
    const scrollBox = await editorScroll.boundingBox();
    const sourceBox = await targetSource.boundingBox();
    if (!scrollBox || !sourceBox) return 999;
    return Math.round(sourceBox.y - scrollBox.y);
  }).toBeLessThan(48);
});

test("Library markdown section options can reveal hidden headings", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Hidden-Outline");
  const filePath = "docs/hidden-outline.md";
  const filler = Array.from({ length: 28 }, (_, index) => `Intro ${index + 1}`).join("\n\n");
  await writeWorkspaceFile(
    page,
    organization.id,
    filePath,
    [
      "# Visible Outline",
      "",
      filler,
      "",
      "<!-- rudder-outline-hidden -->",
      "## Hidden Notes",
      "",
      "Details kept out of the normal section list.",
    ].join("\n"),
  );
  await selectOrg(page, organization.id);
  await page.setViewportSize({ width: 1800, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  await revealLibraryDocumentOutline(page);
  const outline = page.getByTestId("org-workspaces-document-outline");
  await expect(outline.getByRole("button", {
    name: "Visible Outline",
    exact: true,
  })).toBeVisible();
  await expect(outline.getByRole("button", { name: /Hidden Notes/ })).toHaveCount(0);

  const documentOptions = page.getByRole("button", { name: "Document options" });
  await documentOptions.focus();
  await documentOptions.press("Enter");
  await page.getByRole("menuitemcheckbox", { name: "Show hidden sections" }).click();

  const hiddenSectionButton = outline.getByRole("button", { name: /Hidden Notes/ });
  await expect(hiddenSectionButton).toBeVisible();
  await expect(hiddenSectionButton).toContainText("Hidden");

  const editorScroll = page.getByTestId("org-workspaces-markdown-editor");
  await hiddenSectionButton.click();
  const hiddenSource = editorScroll.locator(
    '[data-markdown-preview-state="source"][data-source-line-start]',
    { hasText: "## Hidden Notes" },
  );
  await expect.poll(async () => {
    const scrollBox = await editorScroll.boundingBox();
    const sourceBox = await hiddenSource.boundingBox();
    if (!scrollBox || !sourceBox) return 999;
    return Math.round(sourceBox.y - scrollBox.y);
  }).toBeLessThan(48);
});

test("Library markdown section options can hide and restore the outline panel", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Hide-Outline");
  const filePath = "docs/hide-outline.md";
  await writeWorkspaceFile(page, organization.id, filePath, "# Visible Outline\n\n## Next Step\n\nDone.\n");
  await selectOrg(page, organization.id);
  await page.setViewportSize({ width: 1800, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  await revealLibraryDocumentOutline(page);
  const outline = page.getByTestId("org-workspaces-document-outline");
  await expect(outline).toHaveCount(1);
  const documentOptions = page.getByRole("button", { name: "Document options" });
  await documentOptions.focus();
  await documentOptions.press("Enter");
  await page.getByRole("menuitem", { name: "Hide sections" }).click();

  await expect(outline).toHaveCount(0);
  await documentOptions.focus();
  await documentOptions.press("Enter");
  await page.getByRole("menuitem", { name: "Show sections" }).click();
  await expect(page.getByTestId("org-workspaces-document-outline")).toBeVisible();
  await expect(page
    .getByTestId("org-workspaces-document-outline")
    .getByRole("button", { name: "Next Step" })).toBeVisible();
});

test("Library MDX files use the markdown document chrome and outline options", async ({ page }) => {
  const organization = await createOrg(page, "Library-MDX-Document-Chrome");
  const filePath = "docs/component-notes.mdx";
  await writeWorkspaceFile(
    page,
    organization.id,
    filePath,
    [
      "# MDX Notes",
      "",
      "export const Status = () => <span>Draft</span>",
      "",
      "## Component Section",
      "",
      "<Status />",
    ].join("\n"),
  );
  await selectOrg(page, organization.id);
  await page.setViewportSize({ width: 1800, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  await revealLibraryDocumentOutline(page);
  await expect(page.getByTestId("org-workspaces-markdown-editor").locator("h1", { hasText: "MDX Notes" })).toBeVisible();
  await expect(page
    .getByTestId("org-workspaces-document-outline")
    .getByRole("button", { name: "Component Section" })).toBeVisible();
  await expect(page.getByTestId("org-workspaces-path-breadcrumb")).toContainText("component-notes.mdx");

  const documentOptions = page.getByRole("button", { name: "Document options" });
  await documentOptions.focus();
  await documentOptions.press("Enter");
  await page.getByRole("menuitem", { name: "Hide sections" }).click();
  await expect(page.getByTestId("org-workspaces-document-outline")).toHaveCount(0);
});
