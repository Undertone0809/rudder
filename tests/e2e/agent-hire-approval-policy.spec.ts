import { expect, test } from "@playwright/test";

test.describe("agent hire approval policy", () => {
  test("board-created Agent is usable without a self-approval request", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Board Hire Approval ${Date.now()}`,
        requireBoardApprovalForNewAgents: true,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/new`);

    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await main.getByPlaceholder("Agent name").fill("Board-Owned Agent");
    const hireResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/agent-hires`)
    ));
    await main.getByRole("button", { name: "Create agent", exact: true }).click();
    const hireResponse = await hireResponsePromise;
    expect(hireResponse.ok()).toBe(true);
    const hireResult = await hireResponse.json() as {
      agent: { id: string; status: string };
      approval: unknown;
    };
    expect(hireResult.agent.status).toBe("idle");
    expect(hireResult.approval).toBeNull();

    await expect(page).toHaveURL(/\/agents\/[^/]+(?:\/dashboard)?$/, { timeout: 15_000 });
    await expect(page.getByText("This agent is pending board approval and cannot be invoked yet.")).toHaveCount(0);
    const approvalsRes = await page.request.get(`/api/orgs/${organization.id}/approvals`);
    expect(approvalsRes.ok()).toBe(true);
    expect(await approvalsRes.json()).toEqual([]);
  });

  test("agent-originated hire remains pending exactly once and activates after board approval", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent Hire Approval ${Date.now()}`,
        requireBoardApprovalForNewAgents: true,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const creatorRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Creator Agent",
        role: "ceo",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(creatorRes.ok()).toBe(true);
    const creator = await creatorRes.json() as { id: string };
    const keyRes = await page.request.post(`/api/agents/${creator.id}/keys`, {
      data: { name: "approval-policy-e2e" },
    });
    expect(keyRes.ok()).toBe(true);
    const key = await keyRes.json() as { token: string };
    const agentHeaders = { authorization: `Bearer ${key.token}` };

    const hireRes = await page.request.post(`/api/orgs/${organization.id}/agent-hires`, {
      headers: agentHeaders,
      data: {
        name: "Agent-Proposed Hire",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(hireRes.ok()).toBe(true);
    const hire = await hireRes.json() as {
      agent: { id: string; status: string };
      approval: { id: string; status: string } | null;
    };
    expect(hire.agent.status).toBe("pending_approval");
    expect(hire.approval).toMatchObject({ status: "pending" });
    expect(hire.approval?.id).toBeTruthy();

    const pendingApprovalsRes = await page.request.get(
      `/api/orgs/${organization.id}/approvals?status=pending`,
    );
    expect(pendingApprovalsRes.ok()).toBe(true);
    const pendingApprovals = await pendingApprovalsRes.json() as Array<{ id: string; type: string }>;
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]).toMatchObject({ id: hire.approval?.id, type: "hire_agent" });

    const approveRes = await page.request.post(`/api/approvals/${hire.approval?.id}/approve`, {
      data: { decisionNote: "Approved by the board for the E2E workflow." },
    });
    expect(approveRes.ok()).toBe(true);

    await expect.poll(async () => {
      const agentRes = await page.request.get(`/api/agents/${hire.agent.id}`);
      expect(agentRes.ok()).toBe(true);
      const agent = await agentRes.json() as { status: string };
      return agent.status;
    }).toBe("idle");

    const resolvedRes = await page.request.get(`/api/orgs/${organization.id}/approvals`);
    expect(resolvedRes.ok()).toBe(true);
    const resolvedApprovals = await resolvedRes.json() as Array<{ id: string; status: string }>;
    expect(resolvedApprovals).toHaveLength(1);
    expect(resolvedApprovals[0]).toMatchObject({ id: hire.approval?.id, status: "approved" });
  });
});
