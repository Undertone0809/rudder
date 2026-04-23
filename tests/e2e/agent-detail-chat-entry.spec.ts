import { expect, test } from "@playwright/test";

test.describe("Agent detail chat entry", () => {
  test("opens messenger chat with the current agent preselected", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Chat-Entry-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Elias",
        role: "engineer",
        title: "Founding Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
    await expect(page.getByRole("heading", { name: "Elias", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Chat", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat(?:\\?.*)?$`));
    await expect
      .poll(() => page.url())
      .not.toContain("agentId=");

    const agentPicker = page.getByRole("button", { name: "Elias (Founding Engineer)", exact: true });
    await expect(agentPicker).toBeVisible();
    await agentPicker.click();
    await expect(
      page.getByRole("menuitemradio", { name: "Elias (Founding Engineer)", exact: true }),
    ).toBeVisible();

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("@El");
    await expect(page.getByTestId(`markdown-mention-option-agent:${agent.id}`)).toHaveText(
      "Elias (Founding Engineer)",
    );
  });
});
