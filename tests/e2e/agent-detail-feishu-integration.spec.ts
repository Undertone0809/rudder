import { expect, test, type Page } from "@playwright/test";

test.describe("Agent detail Feishu integration", () => {
  async function createIntegrationFixture(page: Page) {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Feishu-Launcher-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Ella",
        role: "general",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/integrations`);

    await expect(page.getByRole("heading", { name: "Ella", exact: true })).toBeVisible();
    await expect(page.getByText("Ella - Rudder")).toBeVisible();

    return { agent, organization };
  }

  test("opens the Feishu one-click bot launcher and stores the authorized app", async ({ page }) => {
    const { agent, organization } = await createIntegrationFixture(page);

    await page.context().route("https://open.feishu.cn/page/launcher**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Feishu launcher</title><main>Feishu launcher</main>",
      });
    });

    await expect(page.getByText("Create a Feishu bot named")).toBeVisible();
    await expect(page.getByText("requests Feishu bot menu and Slash Command permissions")).toBeVisible();
    await expect(page.getByText("Automatic creation of the Feishu Quick Command menu is not enabled")).toBeVisible();

    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");

    const launcherUrl = new URL(popup.url());
    expect(launcherUrl.origin).toBe("https://open.feishu.cn");
    expect(launcherUrl.pathname).toBe("/page/launcher");
    expect(launcherUrl.searchParams.get("from")).toBe("sdk");
    expect(launcherUrl.searchParams.get("name")).toBe("Ella - Rudder");
    expect(launcherUrl.searchParams.get("source")).toBe("node-sdk/rudder/agent-integrations");
    expect(launcherUrl.searchParams.get("tp")).toBe("sdk");

    await expect(page.getByText("Waiting for Feishu authorization").first()).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Quick Commands", { exact: true })).toBeVisible();
    await expect(page.getByText("Credential stored")).toBeVisible();
    await expect(page.getByText(/cli_mock_/)).toBeVisible();

    const integrationsRes = await page.request.get(`/api/agents/${agent.id}/integrations?orgId=${organization.id}`);
    expect(integrationsRes.ok()).toBe(true);
    const integrations = await integrationsRes.json() as Array<{
      provider: string;
      status: string;
      externalAppId: string;
      hasCredentialSecret: boolean;
    }>;
    expect(integrations).toEqual([
      expect.objectContaining({
        provider: "feishu",
        status: "active",
        hasCredentialSecret: true,
      }),
    ]);
    expect(integrations[0]?.externalAppId).toMatch(/^cli_mock_/);
    expect(JSON.stringify(integrations)).not.toContain("mock-secret");
  });

  test("opens the Lark Global launcher when that region is selected", async ({ page }) => {
    const { agent, organization } = await createIntegrationFixture(page);

    await page.context().route("https://open.larksuite.com/page/launcher**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Lark launcher</title><main>Lark launcher</main>",
      });
    });

    await page.getByRole("button", { name: "Lark Global" }).click();
    await expect(page.getByText("Create a Lark bot named")).toBeVisible();

    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");

    const launcherUrl = new URL(popup.url());
    expect(launcherUrl.origin).toBe("https://open.larksuite.com");
    expect(launcherUrl.pathname).toBe("/page/launcher");
    expect(launcherUrl.searchParams.get("name")).toBe("Ella - Rudder");
    expect(launcherUrl.searchParams.get("source")).toBe("node-sdk/rudder/agent-integrations");
  });
});
