import { expect, test } from "@playwright/test";

const ORG_NAME = `Issue-Detail-Find-${Date.now()}`;

test.describe("Issue detail find", () => {
  test("finds right-side property values, navigates matches, and clears highlights", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const needle = `FindPropertyNeedle${Date.now()}`;
    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: `${needle} Project`,
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        projectId: project.id,
        title: "Issue detail find E2E",
        description: `The body includes ${needle} once before the property match.`,
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { identifier?: string | null; id: string };

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await expect(page.getByRole("button", { name: project.name })).toBeVisible();

    await page.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
    const findUi = page.getByRole("search", { name: "Find in issue" });
    await expect(findUi).toBeVisible();

    const input = findUi.getByRole("textbox", { name: "Find in issue" });
    await input.fill(needle);

    const marks = page.locator("mark[data-issue-find-highlight='true']");
    await expect(findUi).toContainText("1 of 2");
    await expect(marks).toHaveCount(2);
    await expect(page.locator("button mark[data-issue-find-highlight='true']")).toHaveCount(1);

    await input.press("Enter");
    await expect(findUi).toContainText("2 of 2");
    await expect(page.locator("mark.issue-find-highlight--active")).toHaveCount(1);
    await expect.poll(async () => page.locator("mark.issue-find-highlight--active").evaluate((element) =>
      Boolean(element.closest("button")),
    )).toBe(true);

    await input.press("Shift+Enter");
    await expect(findUi).toContainText("1 of 2");

    await input.press("ArrowDown");
    await expect(findUi).toContainText("2 of 2");

    await input.press("Escape");
    await expect(findUi).toHaveCount(0);
    await expect(marks).toHaveCount(0);
  });
});
