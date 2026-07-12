import { expect, test, type Page } from "@playwright/test";

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test("shows delayed detail previews for Messenger chat and issue rows", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Messenger-Hover-Preview-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const chatTitle = "A long Messenger chat title that is clipped in the compact sidebar row";
  const chatSummary = "Full chat context remains readable in the delayed hover preview.";
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: chatTitle,
      summary: chatSummary,
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  const issueTitle = "A Messenger issue title long enough to be truncated while its complete description stays available";
  const issueDescription = "This is the full issue description surfaced by the delayed Messenger preview card.";
  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: issueTitle,
      description: issueDescription,
      status: "todo",
      priority: "high",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };
  const followRes = await page.request.post(`/api/issues/${issue.id}/follow`);
  expect(followRes.ok()).toBe(true);

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger`, { waitUntil: "commit" });

  const chatRow = page.getByTestId(threadTestId(`chat:${chat.id}`));
  const chatPreview = page.getByTestId(`messenger-thread-preview-chat-${chat.id}`);
  await expect(chatRow).toBeVisible({ timeout: 15_000 });
  await chatRow.hover();
  await page.waitForTimeout(750);
  await expect(chatPreview).toBeHidden();
  await expect(chatPreview).toBeVisible({ timeout: 1_000 });
  await expect(chatPreview).toContainText(chatTitle);
  await expect(chatPreview).toContainText(chatSummary);

  const issueRow = page.getByTestId(threadTestId(`issue:${issue.id}`));
  const issuePreview = page.getByTestId(`messenger-thread-preview-issue-${issue.id}`);
  await issueRow.hover();
  await expect(issuePreview).toBeVisible({ timeout: 3_000 });
  await expect(issuePreview).toContainText(issueTitle);
  await expect(issuePreview).toContainText(issueDescription);
  await expect(issuePreview).toContainText(issue.identifier ?? "Issue");
  await expect(issuePreview).toContainText("Status: todo");
  await expect(issuePreview).toContainText("Priority: high");

  const geometry = await page.evaluate(({ rowId, previewId }) => {
    const row = document.querySelector(`[data-testid="${rowId}"]`);
    const preview = document.querySelector(`[data-testid="${previewId}"]`);
    if (!row || !preview) return null;
    const rowRect = row.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    return {
      rowRight: rowRect.right,
      previewLeft: previewRect.left,
      previewRight: previewRect.right,
      previewTop: previewRect.top,
      previewBottom: previewRect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }, {
    rowId: threadTestId(`issue:${issue.id}`),
    previewId: `messenger-thread-preview-issue-${issue.id}`,
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.previewLeft).toBeGreaterThanOrEqual(geometry!.rowRight);
  expect(geometry!.previewRight).toBeLessThanOrEqual(geometry!.viewportWidth);
  expect(geometry!.previewTop).toBeGreaterThanOrEqual(0);
  expect(geometry!.previewBottom).toBeLessThanOrEqual(geometry!.viewportHeight);

  await page.screenshot({ path: "/tmp/rudder-messenger-hover-preview.png", fullPage: true });
});
