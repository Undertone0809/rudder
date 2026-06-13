import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

function buildIssueMentionHref(issueId: string, ref: string | null, status: string) {
  const params = new URLSearchParams();
  if (ref) params.set("r", ref);
  params.set("s", status);
  return `issue://${issueId}?${params.toString()}`;
}

async function createOrganization(page: Page) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Mention-Status-Icons-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, organizationId);
}

async function createIssue(page: Page, organizationId: string, title: string, status = "todo") {
  const issueRes = await page.request.post(`/api/orgs/${organizationId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status,
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  return issueRes.json() as Promise<{ id: string; identifier: string | null; title: string; status: string }>;
}

async function expectEditorStatusChip(chip: Locator, status: string) {
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveClass(/rudder-mention-chip--with-status-icon/);
  await expect(chip).toHaveAttribute("data-mention-kind", "issue");
  await expect(chip).toHaveAttribute("data-mention-status", status);

  const beforeStyle = await chip.evaluate((element) => {
    const style = window.getComputedStyle(element, "::before");
    return {
      content: style.content,
      display: style.display,
      maskImage: style.getPropertyValue("-webkit-mask-image") || style.getPropertyValue("mask-image"),
    };
  });
  expect(beforeStyle.content).not.toBe("none");
  expect(beforeStyle.display).not.toBe("none");
  expect(beforeStyle.maskImage).not.toBe("none");
  expect(beforeStyle.maskImage).not.toContain("viewBox='0 0 24 24'");
}

test("issue status mentions render status icons in comments and editor surfaces", async ({ page }) => {
  const organization = await createOrganization(page);
  const targetIssue = await createIssue(page, organization.id, "Status chip target issue", "todo");
  const targetRef = targetIssue.identifier ?? targetIssue.id;
  const hostIssue = await createIssue(page, organization.id, "Status chip host issue", "todo");
  const hostRef = hostIssue.identifier ?? hostIssue.id;
  const issueMentionHref = buildIssueMentionHref(targetIssue.id, targetRef, "todo");

  const commentRes = await page.request.post(`/api/issues/${hostIssue.id}/comments`, {
    data: {
      body: `Rendered comment mention: [${targetRef}](${issueMentionHref})`,
    },
  });
  expect(commentRes.ok(), await commentRes.text()).toBe(true);
  const comment = await commentRes.json() as { id: string };

  const filePath = `docs/status-chip-${Date.now()}.md`;
  const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: `# Status Chip\n\nLibrary editor mention: [${targetRef}](${issueMentionHref})\n`,
    },
  });
  expect(fileRes.ok(), await fileRes.text()).toBe(true);

  await selectOrganization(page, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/issues/${hostRef}`);

  const renderedCommentChip = page.locator(`#comment-${comment.id} a.rudder-mention-chip[data-mention-kind="issue"]`).first();
  await expect(renderedCommentChip).toBeVisible({ timeout: 15_000 });
  await expect(renderedCommentChip).toHaveAttribute("data-mention-status", "todo");
  await expect(renderedCommentChip.locator('[data-slot="issue-status-icon"][data-status="todo"]')).toBeVisible();

  const composer = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').last();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await composer.click();
  await page.evaluate((markdown) => navigator.clipboard.writeText(markdown), `[${targetRef}](${issueMentionHref})`);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expectEditorStatusChip(composer.locator(`a[href^="issue://${targetIssue.id}"]`).first(), "todo");

  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);
  const libraryEditor = page.getByTestId("org-workspaces-markdown-editor").locator(".ProseMirror");
  await expect(libraryEditor).toBeVisible({ timeout: 15_000 });
  await expectEditorStatusChip(libraryEditor.locator(`a[href^="issue://${targetIssue.id}"]`).first(), "todo");
});
