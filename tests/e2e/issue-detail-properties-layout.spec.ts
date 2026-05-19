import { expect, test } from "@playwright/test";

test.describe("Issue detail properties layout", () => {
  test("keeps assignee and reviewer identity metadata readable in the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Properties-Layout-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const assigneeRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Ulysses",
        role: "general",
        title: "Chief Operating Officer",
      },
    });
    expect(assigneeRes.ok()).toBe(true);
    const assignee = await assigneeRes.json() as { id: string };

    const reviewerRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Tobias",
        role: "ceo",
        title: "Work Lead / Issue Owner",
      },
    });
    expect(reviewerRes.ok()).toBe(true);
    const reviewer = await reviewerRes.json() as { id: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Properties layout should show principal metadata",
        status: "todo",
        priority: "medium",
        assigneeAgentId: assignee.id,
        reviewerAgentId: reviewer.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    const propertiesPanel = page.getByRole("region", { name: "Issue properties" });
    await expect(propertiesPanel).toBeVisible();
    await expect(propertiesPanel.getByText("Ulysses", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Chief Operating Officer", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Tobias", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Work Lead / Issue Owner", { exact: true })).toBeVisible();

    const principalRows = await propertiesPanel.locator('[data-slot="assignee-label"][data-kind="agent"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const badge = node.querySelector<HTMLElement>('[data-slot="agent-title-badge"]');
        const button = node.closest("button") as HTMLElement | null;

        return {
          layout: node.getAttribute("data-layout"),
          rowClientWidth: node.clientWidth,
          rowScrollWidth: node.scrollWidth,
          triggerClientWidth: button?.clientWidth ?? 0,
          triggerScrollWidth: button?.scrollWidth ?? 0,
          badgeClientWidth: badge?.clientWidth ?? 0,
          badgeScrollWidth: badge?.scrollWidth ?? 0,
        };
      }),
    );

    expect(principalRows).toHaveLength(2);
    for (const row of principalRows) {
      expect(row.layout).toBe("stacked");
      expect(row.rowScrollWidth).toBeLessThanOrEqual(row.rowClientWidth);
      expect(row.triggerScrollWidth).toBeLessThanOrEqual(row.triggerClientWidth);
      expect(row.badgeScrollWidth).toBeLessThanOrEqual(row.badgeClientWidth);
    }
  });
});
