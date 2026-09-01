import { expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("issue description special mention links stay inside the active organization route", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Description-Mention-Links-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const targetIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Target issue for special mention navigation",
      description: "The source issue links here through an issue:// mention.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(targetIssueRes.ok()).toBe(true);
  const targetIssue = await targetIssueRes.json() as { id: string; identifier: string | null };
  const targetIssueRef = targetIssue.identifier ?? targetIssue.id;

  const workspaceFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: "docs/reference-map.md",
      content: "# Reference map\n\nOpened from an issue description reference.",
    },
  });
  expect(workspaceFileRes.ok()).toBe(true);

  const sourceIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Source issue with special mention link",
      description: [
        `Review [${targetIssueRef}](issue://${targetIssue.id}) before closing this issue.`,
        "Open [Reference map](library-file://file?p=docs%2Freference-map.md) for context.",
      ].join("\n\n"),
      status: "todo",
      priority: "medium",
    },
  });
  expect(sourceIssueRes.ok()).toBe(true);
  const sourceIssue = await sourceIssueRes.json() as { id: string; identifier: string | null };
  const sourceIssueRef = sourceIssue.identifier ?? sourceIssue.id;

  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);

  const descriptionLink = page.getByRole("link", { name: targetIssueRef }).first();
  await expect(descriptionLink).toBeVisible();
  await expect(descriptionLink).toHaveAttribute("href", `issue://${targetIssue.id}`);
  await expect(page.locator(".rudder-issue-description-surface .rudder-milkdown-scope"))
    .toHaveAttribute("data-inline-token-click-mode", "plain");
  const activeOrganizationPrefix = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
  expect(activeOrganizationPrefix).toBeTruthy();

  const libraryFileLink = page.getByRole("link", { name: "Reference map" }).first();
  await expect(libraryFileLink).toHaveAttribute(
    "href",
    "library-file://file?p=docs%2Freference-map.md",
  );
  await libraryFileLink.click();
  await expect(page).toHaveURL(
    new RegExp(`/${activeOrganizationPrefix}/library\\?path=docs%2Freference-map\\.md$`),
  );
  await expect(page.getByTestId("org-workspaces-markdown-editor")).toContainText(
    "Opened from an issue description reference.",
  );

  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);
  await descriptionLink.click();
  await expect(page).toHaveURL(new RegExp(`/${activeOrganizationPrefix}/issues/${targetIssue.id}$`));
  await expect(page.locator("main").getByRole("heading", {
    name: "Target issue for special mention navigation",
  })).toBeVisible();
});

test("ordinary issue description Markdown links open from the live preview", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Description-Ordinary-Link-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue with an ordinary Markdown link",
      description: `Open [Messenger](/${organization.issuePrefix}/messenger) to continue reviewing the work.`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/issues/${issue.identifier ?? issue.id}`);

  const editor = page
    .locator(".rudder-issue-description-surface")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  const messengerLink = editor.locator(
    `[data-markdown-link-href="/${organization.issuePrefix}/messenger"]`,
  );
  await expect(messengerLink).toBeVisible();
  await messengerLink.click();

  await expect(page).toHaveURL(
    new RegExp(`/${organization.issuePrefix}/messenger(?:/|$)`),
  );
  await expect(page.getByTestId("chat-main-workspace-card")).toBeVisible();
  await page.screenshot({
    path: join(tmpdir(), "rudder-issue-markdown-link-open.png"),
  });
});
