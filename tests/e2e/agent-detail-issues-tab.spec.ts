import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Agent detail issues tab", () => {
  test("opens the issue board filtered to issues where the agent participates", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agent-Issues-Tab-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Issue Navigator",
        role: "engineer",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const otherAgentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Unrelated Agent",
        role: "qa",
      },
    });
    expect(otherAgentRes.ok()).toBe(true);
    const otherAgent = await otherAgentRes.json() as { id: string };

    const assignedIssueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Assigned issue from agent tab",
        description: "This issue is assigned to the selected agent.",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agent.id,
      },
    });
    expect(assignedIssueRes.ok()).toBe(true);

    const reviewIssueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Review issue from agent tab",
        description: "This issue is reviewed by the selected agent.",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: otherAgent.id,
        reviewerAgentId: agent.id,
      },
    });
    expect(reviewIssueRes.ok()).toBe(true);

    const unrelatedIssueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Unrelated issue outside agent tab",
        description: "This issue should not appear in the selected agent issue board.",
        status: "todo",
        priority: "medium",
        assigneeAgentId: otherAgent.id,
      },
    });
    expect(unrelatedIssueRes.ok()).toBe(true);

    await page.addInitScript(({ orgId, otherAgentId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem(
        `rudder:issues-view:${orgId}`,
        JSON.stringify({ viewMode: "board", assignees: [otherAgentId], statuses: ["done"] }),
      );
    }, { orgId: organization.id, otherAgentId: otherAgent.id });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { name: "Issue Navigator", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Issues" }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues\\?participantAgentId=${agent.id}$`));
    await expect(page.getByText("Assigned issue from agent tab")).toBeVisible();
    await expect(page.getByText("Review issue from agent tab")).toBeVisible();
    await expect(page.getByText("Unrelated issue outside agent tab")).toHaveCount(0);
  });
});
