import { expect, test } from "@playwright/test";

const ORG_NAME = `Markdown-Patch-${Date.now()}`;

test.describe("Markdown patch rendering", () => {
  test("renders patch fences in issue descriptions as diff-highlighted rows", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Patch markdown preview",
        description: [
          "Review this patch:",
          "",
          "```patch",
          "--- a/app.ts",
          "+++ b/app.ts",
          "@@ -1,2 +1,2 @@",
          "-old value",
          "+new value",
          " context",
          "```",
        ].join("\n"),
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

    const patchBlock = page.locator(".rudder-markdown-patch-block");
    await expect(patchBlock).toBeVisible();
    await expect(patchBlock.locator(".rudder-markdown-patch-line--file")).toHaveCount(2);
    await expect(patchBlock.locator(".rudder-markdown-patch-line--hunk")).toContainText("@@ -1,2 +1,2 @@");
    await expect(patchBlock.locator(".rudder-markdown-patch-line--remove")).toContainText("-old value");
    await expect(patchBlock.locator(".rudder-markdown-patch-line--add")).toContainText("+new value");
    await expect(patchBlock.locator(".rudder-markdown-patch-line--context")).toContainText(" context");
  });
});
