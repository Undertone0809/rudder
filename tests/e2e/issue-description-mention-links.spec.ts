import { expect, test } from "@playwright/test";

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

  const sourceIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Source issue with special mention link",
      description: `Review [${targetIssueRef}](issue://${targetIssue.id}?r=${targetIssueRef}) before closing this issue.`,
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
  await expect(descriptionLink).toHaveAttribute("href", `/${organization.issuePrefix}/issues/${targetIssueRef}`);

  await descriptionLink.click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues/${targetIssueRef}$`));
  await expect(page.locator("main").getByRole("heading", {
    name: "Target issue for special mention navigation",
  })).toBeVisible();
});
