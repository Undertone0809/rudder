import { expect, test } from "@playwright/test";

test("keeps an unsent issue comment draft when navigating away and back", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Issue-Comment-Draft-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue comment draft should survive navigation",
      description: "Unsent comment text should be restored after route changes.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null; title: string };
  const routeRef = issue.identifier ?? issue.id;

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

  const activity = page.getByRole("region", { name: "Activity" });
  const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  const draft = "Keep this unsent issue comment";
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await page.keyboard.type(draft);
  await expect(composer).toContainText(draft);
  await expect.poll(async () => page.evaluate((key) => (
    window.localStorage.getItem(key)
  ), `rudder:issue-comment-draft:${issue.id}`)).toContain(draft);

  await page.getByTestId("primary-rail").getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`), { timeout: 15_000 });

  await page.goto(`/${organization.issuePrefix}/issues/${routeRef}`);
  await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });
  await expect(activity.locator(".rudder-milkdown-content [contenteditable='true']").last()).toContainText(draft);
});
