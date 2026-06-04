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
  const expectedCommentUrl = `${new URL(page.url()).origin}/${organization.issuePrefix}/issues/${routeRef}#comment-${comment.id}`;
  const copiedMarkdownLink = writesAfterLink.at(-1);
  expect(copiedMarkdownLink).toBe(`[Issue comment ${comment.id.slice(0, 8)}](<${expectedCommentUrl}>)`);

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

  const [createLinkedCommentResponse] = await Promise.all([
    page.waitForResponse((response) =>
      /\/api\/issues\/[^/]+\/comments$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST",
    ),
    page.locator(".chat-composer").getByRole("button", { name: "Comment", exact: true }).click(),
  ]);
  expect(createLinkedCommentResponse.ok()).toBe(true);
  const linkedComment = await createLinkedCommentResponse.json() as { id: string; body: string };
  expect(linkedComment.body).toBe(`[Issue comment ${comment.id.slice(0, 8)}](${expectedCommentUrl})`);

  const linkedCommentBlock = page.locator(`#comment-${linkedComment.id}`);
  await expect(linkedCommentBlock).toBeVisible();
  const renderedCopiedLink = linkedCommentBlock.getByRole("link", { name: `Issue comment ${comment.id.slice(0, 8)}` });
  await expect(renderedCopiedLink).toHaveAttribute("href", expectedCommentUrl);
  await renderedCopiedLink.click();
  await expect(page).toHaveURL(expectedCommentUrl);
  await expect(commentBlock).toHaveClass(/border-primary/);
});
