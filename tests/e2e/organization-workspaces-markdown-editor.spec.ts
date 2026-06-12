import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function createOrg(page: import("@playwright/test").Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return await orgRes.json() as { id: string; issuePrefix: string };
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

  await page.getByText("Asher", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/]+/dashboard`));

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?path=${encodeURIComponent(filePath)}`));
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
  await expect(editorScroll.locator(".ProseMirror")).toBeVisible();
  const box = await editorScroll.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + 140, box!.y + box!.height - 80);
  await page.keyboard.type("Blank area text");

  await expect(editorScroll.locator(".ProseMirror")).toContainText("Blank area text");
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

  const editor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
  await expect(editor.locator("pre")).toBeVisible();
  await expect(editor.locator("pre").first()).toHaveCSS("background-color", "rgb(27, 28, 25)");
  await page.evaluate(() => navigator.clipboard.writeText("## HEAD2"));
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

  await expect(editor.locator("h2", { hasText: "HEAD2" })).toBeVisible();
  await expect(editor).not.toContainText("## HEAD2");
});

test("Library markdown copied list selections keep Markdown bullet markers", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Copy-List");
  const filePath = "agents/Wesley/instructions/HEARTBEAT.md";
  const heartbeatMarkdown = [
    "# HEARTBEAT.md -- Agent Heartbeat Checklist",
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
    heartbeatMarkdown,
  );
  await selectOrg(page, organization.id);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
  await expect(editor.locator("h2", { hasText: "Exit" })).toBeVisible();
  const selectEditorNodeContents = async (selector: string) => {
    await editor.evaluate(async (element, targetSelector) => {
      const target = targetSelector === ":scope" ? element : element.querySelector(targetSelector);
      if (!target) throw new Error(`Expected rendered Markdown node: ${targetSelector}`);
      if (!(target instanceof Node)) throw new Error(`Rendered target is not a DOM node: ${targetSelector}`);
      if (element instanceof HTMLElement && !element.contains(document.activeElement)) {
        element.focus();
        await new Promise(requestAnimationFrame);
      }
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, selector);
  };

  await selectEditorNodeContents("ul");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(
    "Comment on in_progress work before exiting.",
  );
  await page.evaluate(() => navigator.clipboard.writeText("__rudder_clipboard_sentinel__"));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    "- Comment on in_progress work before exiting.",
    "- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.",
    "- A successful `todo` or `in_progress` issue run without a close-out signal can trigger a same-agent passive follow-up.",
    "- Exit cleanly if no assignments.",
  ].join("\n"));

  await selectEditorNodeContents("ol");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(
    "Read today's plan from memory.",
  );
  await page.evaluate(() => navigator.clipboard.writeText("__rudder_clipboard_sentinel__"));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    "3. Read today's plan from memory.",
    "4. Review planned items.",
  ].join("\n"));

  await selectEditorNodeContents(":scope");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(
    "HEARTBEAT.md -- Agent Heartbeat Checklist",
  );
  await page.evaluate(() => navigator.clipboard.writeText("__rudder_clipboard_sentinel__"));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(heartbeatMarkdown);
});

test("Library markdown pasted images are uploaded as assets before save", async ({ page }) => {
  const organization = await createOrg(page, "Library-Markdown-Image-Upload");
  const filePath = "docs/image-upload.md";
  await writeWorkspaceFile(page, organization.id, filePath, "# Image Upload\n\n");
  await selectOrg(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
  await expect(editor.locator("h1", { hasText: "Image Upload" })).toBeVisible();

  const uploadResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/orgs/${organization.id}/assets/images`)
    && response.status() === 201,
  );

  await editor.evaluate(async (element) => {
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
  await page.setViewportSize({ width: 1491, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
  const table = editor.locator("table").first();
  await expect(table).toBeVisible();
  await expect(page.getByTestId("org-workspaces-document-outline")).toBeVisible();

  const metrics = await table.evaluate((element) => {
    const reliabilityHeader = element.querySelector("th:nth-child(2)");
    const supportHeader = element.querySelector("th:nth-child(3)");
    const supportCell = element.querySelector("tbody tr:first-child td:nth-child(3), tr:nth-child(2) td:nth-child(3)");
    const outline = document.querySelector('[data-testid="org-workspaces-document-outline"]');
    const tableRect = element.getBoundingClientRect();
    const outlineRect = outline?.getBoundingClientRect();
    const reliabilityRect = reliabilityHeader?.getBoundingClientRect();
    const supportRect = supportCell?.getBoundingClientRect();
    return {
      tableRight: tableRect.right,
      outlineLeft: outlineRect?.left ?? Number.POSITIVE_INFINITY,
      reliabilityHeaderWidth: reliabilityRect?.width ?? 0,
      reliabilityHeaderHeight: reliabilityRect?.height ?? 0,
      supportHeaderText: supportHeader?.textContent ?? "",
      supportCellWidth: supportRect?.width ?? 0,
    };
  });

  expect(metrics.tableRight).toBeLessThan(metrics.outlineLeft);
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
  await page.setViewportSize({ width: 1491, height: 926 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editorScroll = page.getByTestId("org-workspaces-markdown-editor");
  const targetHeading = editorScroll.locator("h2", { hasText: "Target Section" });
  await page.getByTestId("org-workspaces-document-outline").getByRole("button", { name: "Target Section" }).click();

  await expect.poll(async () => {
    const scrollBox = await editorScroll.boundingBox();
    const headingBox = await targetHeading.boundingBox();
    if (!scrollBox || !headingBox) return 999;
    return Math.round(headingBox.y - scrollBox.y);
  }).toBeLessThan(48);
});
