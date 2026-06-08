import { expect, test } from "@playwright/test";

test("issue comment actions menu copies content and direct links", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __rudderClipboardWrites?: string[] }).__rudderClipboardWrites ??= [];
          (window as typeof window & { __rudderClipboardWrites: string[] }).__rudderClipboardWrites.push(value);
        },
      },
    });
  });

  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Actions-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Comment actions menu",
      description: "Comment blocks should expose secondary actions from the more menu.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const body = "Review note:\n\n- keep the copied markdown intact";
  const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body },
  });
  expect(commentRes.ok()).toBe(true);
  const comment = await commentRes.json() as { id: string; body: string };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const routeRef = issue.identifier ?? issue.id;
  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);

  const commentBlock = page.locator(`#comment-${comment.id}`);
  await expect(commentBlock).toBeVisible();

  await commentBlock.getByRole("button", { name: "Comment actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy content" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();

  await page.getByRole("menuitem", { name: "Copy content" }).click();
  const writesAfterContent = await page.evaluate(() => (
    (window as typeof window & { __rudderClipboardWrites?: string[] }).__rudderClipboardWrites ?? []
  ));
  expect(writesAfterContent.at(-1)).toBe(body);

  await commentBlock.getByRole("button", { name: "Comment actions" }).click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  const writesAfterLink = await page.evaluate(() => (
    (window as typeof window & { __rudderClipboardWrites?: string[] }).__rudderClipboardWrites ?? []
  ));
  const expectedMentionHref = `issue://${issue.id}?r=${routeRef}&c=${comment.id}`;
  const expectedSerializedMentionHref = expectedMentionHref.replaceAll("&", "\\&");
  const copiedMarkdownLink = writesAfterLink.at(-1);
  expect(copiedMarkdownLink).toBe(`[Issue comment ${comment.id.slice(0, 8)}](${expectedMentionHref})`);
  expect(copiedMarkdownLink).not.toContain("http://");
  expect(copiedMarkdownLink).not.toContain("https://");

  const composer = page.locator(".chat-composer .rudder-milkdown-content [contenteditable='true']").first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, copiedMarkdownLink!);
  const pastedMentionChip = page.locator(".chat-composer .rudder-milkdown-content .rudder-mention-chip--issue", {
    hasText: `Issue comment ${comment.id.slice(0, 8)}`,
  });
  await expect(pastedMentionChip).toBeVisible();
  await expect(pastedMentionChip).toHaveAttribute("data-mention-kind", "issue");

  const [createLinkedCommentResponse] = await Promise.all([
    page.waitForResponse((response) =>
      /\/api\/issues\/[^/]+\/comments$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST",
    ),
    page.locator(".chat-composer").getByRole("button", { name: "Comment", exact: true }).click(),
  ]);
  expect(createLinkedCommentResponse.ok()).toBe(true);
  const linkedComment = await createLinkedCommentResponse.json() as { id: string; body: string };
  expect(linkedComment.body).toBe(`[Issue comment ${comment.id.slice(0, 8)}](${expectedSerializedMentionHref})`);

  const linkedCommentBlock = page.locator(`#comment-${linkedComment.id}`);
  await expect(linkedCommentBlock).toBeVisible();
  const renderedCopiedLink = linkedCommentBlock.getByRole("link", { name: `Issue comment ${comment.id.slice(0, 8)}` });
  const expectedRenderedHref = `/issues/${routeRef}#comment-${comment.id}`;
  await expect(renderedCopiedLink).toHaveAttribute("href", expectedRenderedHref);
  await renderedCopiedLink.click();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}${expectedRenderedHref}`);
  await expect(commentBlock).toHaveClass(/border-primary/);

  const updatedBody = "Review note updated:\n\n- edit and delete stay owner-only";
  await commentBlock.getByRole("button", { name: "Comment actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const editComposer = commentBlock.locator(".rudder-milkdown-content [contenteditable='true']").first();
  await expect(editComposer).toBeVisible();
  await editComposer.click();
  await editComposer.press("ControlOrMeta+A");
  await page.keyboard.type(updatedBody);
  const [updateResponse] = await Promise.all([
    page.waitForResponse((response) =>
      new RegExp(`/api/issues/${issue.id}/comments/${comment.id}$`).test(new URL(response.url()).pathname)
      && response.request().method() === "PATCH",
    ),
    commentBlock.getByRole("button", { name: "Save" }).click(),
  ]);
  expect(updateResponse.ok()).toBe(true);
  await expect(commentBlock).toContainText("Review note updated:");
  await expect(commentBlock).toContainText("edited");

  const refreshedCommentRes = await page.request.get(`/api/issues/${issue.id}/comments/${comment.id}`);
  expect(refreshedCommentRes.ok()).toBe(true);
  const refreshedComment = await refreshedCommentRes.json() as { body: string; updatedAt: string; createdAt: string };
  expect(refreshedComment.body).toBe(updatedBody);
  expect(new Date(refreshedComment.updatedAt).getTime()).toBeGreaterThan(new Date(refreshedComment.createdAt).getTime());

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete this comment?");
    await dialog.accept();
  });
  await commentBlock.getByRole("button", { name: "Comment actions" }).click();
  const [deleteResponse] = await Promise.all([
    page.waitForResponse((response) =>
      new RegExp(`/api/issues/${issue.id}/comments/${comment.id}$`).test(new URL(response.url()).pathname)
      && response.request().method() === "DELETE",
    ),
    page.getByRole("menuitem", { name: "Delete" }).click(),
  ]);
  expect(deleteResponse.ok()).toBe(true);
  await expect(commentBlock).toContainText("Comment deleted");
  await expect(commentBlock).not.toContainText("Review note updated:");
  await expect(commentBlock.getByRole("button", { name: "Comment actions" })).toHaveCount(0);

  await page.reload();
  await expect(commentBlock).toContainText("Comment deleted");
  await expect(commentBlock).not.toContainText("Review note updated:");
  await expect(commentBlock.getByRole("button", { name: "Comment actions" })).toHaveCount(0);

  const deletedCommentRes = await page.request.get(`/api/issues/${issue.id}/comments/${comment.id}`);
  expect(deletedCommentRes.ok()).toBe(true);
  const deletedComment = await deletedCommentRes.json() as { body: string; deletedAt: string | null };
  expect(deletedComment.body).toBe("");
  expect(deletedComment.deletedAt).toBeTruthy();
});
