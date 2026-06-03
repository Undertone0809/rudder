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
