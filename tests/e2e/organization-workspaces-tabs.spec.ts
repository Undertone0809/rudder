import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("Library markdown file links open as retained editor tabs", async ({ page }) => {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Library-Tabs-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const sourcePath = `projects/tab-proof-${suffix}/current.md`;
  const linkedPath = `projects/tab-proof-${suffix}/linked.md`;
  const files = [
    {
      filePath: sourcePath,
      content: `# Current\n\nOpen [Linked doc](library-file://file?p=${encodeURIComponent(linkedPath)}&t=linked.md) from this document.\n`,
    },
    {
      filePath: linkedPath,
      content: "# Linked doc\n\nThis should open in a retained Library tab.\n",
    },
  ];

  for (const file of files) {
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: file,
    });
    expect(fileRes.ok()).toBe(true);
  }

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(sourcePath)}`);

  const tabStrip = page.getByTestId("org-workspaces-editor-tabs");
  await expect(tabStrip).toContainText("current.md", { timeout: 15_000 });
  await expect(tabStrip).not.toContainText("linked.md");

  await page.getByText("Linked doc", { exact: true }).click();

  await expect(tabStrip).toContainText("current.md");
  await expect(tabStrip).toContainText("linked.md");
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("linked.md");

  await page.reload({ waitUntil: "networkidle" });
  await expect(tabStrip).toContainText("current.md");
  await expect(tabStrip).toContainText("linked.md");
  await expect(tabStrip.locator("[role='tab'][aria-selected='true']")).toContainText("linked.md");
});
