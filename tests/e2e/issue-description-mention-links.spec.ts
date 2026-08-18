import { expect, test } from "@playwright/test";

const modifier = "ControlOrMeta" as const;

test("issue description links open supported targets in the Side Panel", async ({ page }, testInfo) => {
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
  const activeOrganizationPrefix = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
  expect(activeOrganizationPrefix).toBeTruthy();
  const sourceRoute = new RegExp(`/${activeOrganizationPrefix}/issues/${sourceIssueRef}$`);
  const targetRoute = new RegExp(`/${activeOrganizationPrefix}/issues/${targetIssue.id}$`);
  await expect(descriptionLink).toHaveAttribute("href", targetRoute);

  const libraryFileLink = page.getByRole("link", { name: /reference-map\.md/ }).first();
  await expect(libraryFileLink).toHaveAttribute(
    "href",
    new RegExp(`/${activeOrganizationPrefix}/library\\?path=docs%2Freference-map\\.md$`),
  );
  await libraryFileLink.click();
  const sidePanel = page.getByTestId("chat-side-panel");
  const librarySurface = page.getByTestId("library-live-surface");
  await expect(sidePanel).toBeVisible();
  await expect(librarySurface).toBeVisible();
  await expect(librarySurface.getByText("Reference map", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(sourceRoute);
  await expect(librarySurface).toContainText("Opened from an issue description reference.");
  await page.screenshot({ path: testInfo.outputPath("issue-description-side-panel-desktop.png"), fullPage: false });
  await sidePanel.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).not.toBeVisible();

  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);
  await descriptionLink.click();
  await expect(page).toHaveURL(sourceRoute);
  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-issue-view")).toBeVisible();
  await expect(sidePanel.getByRole("heading", {
    name: "Target issue for special mention navigation",
  })).toBeVisible();

  await sidePanel.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).not.toBeVisible();
  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);
  await page.getByRole("link", { name: targetIssueRef }).first().click({ modifiers: [modifier] });
  await expect(page).toHaveURL(targetRoute);
  await expect(sidePanel).not.toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${organization.issuePrefix}/issues/${sourceIssueRef}`);
  await page.getByRole("link", { name: targetIssueRef }).first().click();
  await expect(page).toHaveURL(targetRoute);
  await expect(sidePanel).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("issue-description-side-panel-mobile.png"), fullPage: false });
});
