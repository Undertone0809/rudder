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

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Comment Agent",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const agentKeyRes = await page.request.post(`/api/agents/${agent.id}/keys`, {
    data: { name: "issue-comment-actions-menu-e2e" },
  });
  expect(agentKeyRes.ok()).toBe(true);
  const agentKey = await agentKeyRes.json() as { token: string };

  const body = "Review note:\n\n- keep the copied markdown intact";
  const commentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body },
  });
  expect(commentRes.ok()).toBe(true);
  const comment = await commentRes.json() as { id: string; body: string };

  const agentCommentRes = await page.request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: "Agent handoff note that the board may remove." },
    headers: { authorization: `Bearer ${agentKey.token}` },
  });
  expect(agentCommentRes.ok()).toBe(true);
  const agentComment = await agentCommentRes.json() as { id: string; body: string };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const routeRef = issue.identifier ?? issue.id;
  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);

  const commentBlock = page.locator(`#comment-${comment.id}`);
  await expect(commentBlock).toBeVisible();

  const agentCommentBlock = page.locator(`#comment-${agentComment.id}`);
  await expect(agentCommentBlock).toBeVisible();
  await agentCommentBlock.getByRole("button", { name: "Comment actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy content" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteAgentDialog = page.getByRole("dialog", { name: "Delete this comment?" });
  await expect(deleteAgentDialog).toBeVisible();
  const [deleteAgentResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        (
          pathname.endsWith(`/api/issues/${issue.id}/comments/${agentComment.id}`)
          || pathname.endsWith(`/api/issues/${routeRef}/comments/${agentComment.id}`)
        )
        && response.request().method() === "DELETE"
      );
    }),
    deleteAgentDialog.getByRole("button", { name: "Delete" }).click(),
  ]);
  expect(deleteAgentResponse.ok()).toBe(true);
  await expect(agentCommentBlock).toHaveCount(0);

  const deletedAgentCommentRes = await page.request.get(`/api/issues/${issue.id}/comments/${agentComment.id}`);
  expect(deletedAgentCommentRes.ok()).toBe(true);
  const deletedAgentComment = await deletedAgentCommentRes.json() as { body: string; deletedAt: string | null };
  expect(deletedAgentComment.body).toBe("");
  expect(deletedAgentComment.deletedAt).toBeTruthy();

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
  const expectedMentionHref = `issue://${issue.id}?c=${comment.id}`;
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
  const expectedRenderedHref = `/${organization.issuePrefix}/issues/${issue.id}#comment-${comment.id}`;
  await expect(renderedCopiedLink).toHaveAttribute("href", expectedRenderedHref);
  await renderedCopiedLink.click();
  await expect(page).toHaveURL(`${new URL(page.url()).origin}/${organization.issuePrefix}/issues/${routeRef}#comment-${comment.id}`);
  await expect(commentBlock).toHaveClass(/border-primary/);

  const updatedBody = "Review note updated: edit and delete stay owner-only";
  await commentBlock.getByRole("button", { name: "Comment actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const editComposer = commentBlock.locator(".rudder-milkdown-content [contenteditable='true']").first();
  await expect(editComposer).toBeVisible();
  const editSurfaceState = await commentBlock.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const editor = element.querySelector(".rudder-milkdown-content, .rudder-mdxeditor-content");
    const editorRect = editor instanceof HTMLElement ? editor.getBoundingClientRect() : null;
    return {
      className: element.getAttribute("class") ?? "",
      width: rect.width,
      height: rect.height,
      editorWidth: editorRect?.width ?? 0,
      editorHeight: editorRect?.height ?? 0,
    };
  });
  expect(editSurfaceState.className).toContain("rounded-[var(--radius-lg)]");
  expect(editSurfaceState.width).toBeGreaterThan(600);
  expect(editSurfaceState.height).toBeGreaterThan(150);
  expect(editSurfaceState.editorWidth).toBeGreaterThan(editSurfaceState.width - 72);
  expect(editSurfaceState.editorHeight).toBeGreaterThanOrEqual(88);
  await expect(commentBlock.locator('button[title="Attach file"]')).toBeVisible();
  await editComposer.click();
  await editComposer.press("ControlOrMeta+A");
  await page.keyboard.type(updatedBody);
  const [editAttachmentResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        pathname.endsWith(`/api/orgs/${organization.id}/issues/${issue.id}/attachments`)
        || pathname.endsWith(`/api/orgs/${organization.id}/issues/${routeRef}/attachments`)
      ) && response.request().method() === "POST";
    }),
    commentBlock.locator('input[type="file"]').setInputFiles({
      name: "edit-proof.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("edit attachment proof"),
    }),
  ]);
  expect(editAttachmentResponse.ok()).toBe(true);
  const editAttachment = await editAttachmentResponse.json() as { contentPath: string };
  const expectedEditedBody = `${updatedBody}\n\n[edit-proof.txt](${editAttachment.contentPath})`;
  await expect.poll(async () => {
    const value = await editComposer.evaluate((element) => element.textContent ?? "");
    return value.includes("edit-proof.txt");
  }).toBe(true);
  const [updateResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        (
          pathname.endsWith(`/api/issues/${issue.id}/comments/${comment.id}`)
          || pathname.endsWith(`/api/issues/${routeRef}/comments/${comment.id}`)
        )
        && response.request().method() === "PATCH"
      );
    }),
    commentBlock.getByRole("button", { name: "Save" }).click(),
  ]);
  expect(updateResponse.ok()).toBe(true);
  await expect(commentBlock).toContainText("Review note updated:");
  await expect(commentBlock).toContainText("edited");
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity).not.toContainText("edited a comment");

  const refreshedCommentRes = await page.request.get(`/api/issues/${issue.id}/comments/${comment.id}`);
  expect(refreshedCommentRes.ok()).toBe(true);
  const refreshedComment = await refreshedCommentRes.json() as { body: string; updatedAt: string; createdAt: string };
  expect(refreshedComment.body).toBe(expectedEditedBody);
  expect(new Date(refreshedComment.updatedAt).getTime()).toBeGreaterThan(new Date(refreshedComment.createdAt).getTime());

  await commentBlock.getByRole("button", { name: "Comment actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete this comment?" });
  await expect(deleteDialog).toBeVisible();
  const [deleteResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        (
          pathname.endsWith(`/api/issues/${issue.id}/comments/${comment.id}`)
          || pathname.endsWith(`/api/issues/${routeRef}/comments/${comment.id}`)
        )
        && response.request().method() === "DELETE"
      );
    }),
    deleteDialog.getByRole("button", { name: "Delete" }).click(),
  ]);
  expect(deleteResponse.ok()).toBe(true);
  await expect(commentBlock).toHaveCount(0);
  await expect(activity).not.toContainText("deleted a comment");

  await page.reload();
  await expect(commentBlock).toHaveCount(0);
  await expect(activity).not.toContainText("edited a comment");
  await expect(activity).not.toContainText("deleted a comment");

  const deletedCommentRes = await page.request.get(`/api/issues/${issue.id}/comments/${comment.id}`);
  expect(deletedCommentRes.ok()).toBe(true);
  const deletedComment = await deletedCommentRes.json() as { body: string; deletedAt: string | null };
  expect(deletedComment.body).toBe("");
  expect(deletedComment.deletedAt).toBeTruthy();
});

test("issue detail delete removes the issue without retaining hidden UI", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Del-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Delete from detail menu",
      description: "Deleting the issue should leave the detail view.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const routeRef = issue.identifier ?? issue.id;
  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);
  await expect(page.getByRole("heading", { name: "Delete from detail menu" })).toBeVisible();

  await page.getByRole("button", { name: "More issue actions" }).click();
  await expect(page.getByText("Delete Issue")).toBeVisible();
  await expect(page.getByText("Hide this Issue")).toHaveCount(0);

  await page.getByText("Delete Issue").click();
  const deleteIssueDialog = page.getByRole("dialog", { name: `Delete ${routeRef}?` });
  await expect(deleteIssueDialog).toBeVisible();
  const [deleteResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        (pathname.endsWith(`/api/issues/${issue.id}`) || pathname.endsWith(`/api/issues/${routeRef}`))
        && response.request().method() === "DELETE"
      );
    }),
    deleteIssueDialog.getByRole("button", { name: "Delete" }).click(),
  ]);
  expect(deleteResponse.ok()).toBe(true);

  await expect(page).toHaveURL(/\/issues\/all$/);
  await expect(page.getByText("This issue is hidden")).toHaveCount(0);
  const deletedIssueRes = await page.request.get(`/api/issues/${issue.id}`);
  expect(deletedIssueRes.status()).toBe(404);
});
