import { expect, test } from "@playwright/test";

test.describe("Agent auto naming", () => {
  test("new-agent flow pre-fills a distinct name for the first agent", async ({ page }) => {
    const organizationName = `Agent-Auto-Name-${Date.now()}`;
    const title = "Founding Engineer";

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
        requireBoardApprovalForNewAgents: false,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/new`);
    const newAgentMain = page.locator("#main-content");
    await expect(newAgentMain.getByRole("heading", { name: "New Agent" })).toBeVisible();
    const nameInput = newAgentMain.getByPlaceholder("Agent name");
    await expect(nameInput).toHaveValue(/\S+/, { timeout: 15_000 });
    const suggestedName = (await nameInput.inputValue()).trim();
    expect(suggestedName.length).toBeGreaterThan(0);

    await newAgentMain.getByPlaceholder("Title (e.g. VP of Engineering)").fill(title);
    await newAgentMain.getByRole("button", { name: "Create agent" }).click();

    await expect(page).toHaveURL(/\/agents\/(?!new(?:\/|$))[^/]+(?:\/dashboard)?$/, { timeout: 15_000 });

    const agentRefMatch = new URL(page.url()).pathname.match(/\/agents\/([^/]+)/);
    expect(agentRefMatch?.[1]).toBeTruthy();
    const agentRef = decodeURIComponent(agentRefMatch![1]!);

    await expect(async () => {
      const agentRes = await page.request.get(
        `/api/agents/${encodeURIComponent(agentRef)}?orgId=${organization.id}`,
      );
      expect(agentRes.ok()).toBe(true);
      const agent = await agentRes.json() as {
        name: string;
        title: string | null;
        role: string;
      };
      expect(agent.title).toBe(title);
      expect(agent.role).toBe("ceo");
      expect(agent.name).toBe(suggestedName);
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] });
  });

  test("general-role agent creation pre-fills a suggested distinct name", async ({ page }) => {
    const organizationName = `Agent-General-Name-${Date.now()}`;
    const title = "Generalist";

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
        requireBoardApprovalForNewAgents: false,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const founderRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Founder",
        role: "ceo",
        title: "CEO",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(founderRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/new`);
    const newAgentMain = page.locator("#main-content");
    await expect(newAgentMain.getByRole("heading", { name: "New Agent" })).toBeVisible();

    const nameInput = newAgentMain.getByPlaceholder("Agent name");
    await expect(nameInput).toHaveValue(/\S+/, { timeout: 15_000 });
    const suggestedName = (await nameInput.inputValue()).trim();
    expect(suggestedName.length).toBeGreaterThan(0);

    await newAgentMain.getByPlaceholder("Title (e.g. VP of Engineering)").fill(title);
    await newAgentMain.getByRole("button", { name: "Create agent" }).click();

    await expect(page).toHaveURL(/\/agents\/(?!new(?:\/|$))[^/]+(?:\/dashboard)?$/, { timeout: 15_000 });

    const agentRefMatch = new URL(page.url()).pathname.match(/\/agents\/([^/]+)/);
    expect(agentRefMatch?.[1]).toBeTruthy();
    const agentRef = decodeURIComponent(agentRefMatch![1]!);

    await expect(async () => {
      const agentRes = await page.request.get(
        `/api/agents/${encodeURIComponent(agentRef)}?orgId=${organization.id}`,
      );
      expect(agentRes.ok()).toBe(true);
      const agent = await agentRes.json() as {
        name: string;
        title: string | null;
        role: string;
      };
      expect(agent.title).toBe(title);
      expect(agent.role).toBe("general");
      expect(agent.name).toBe(suggestedName);
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] });
  });
});
