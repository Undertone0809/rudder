import { expect, test } from "@playwright/test";

const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAvElEQVR4nOXOMQEAIAzAsCqZTiTiisnIwZE/nbnvZ+mAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YC2eEHSLFdn2uQAAAAASUVORK5CYII=",
  "base64",
);

test.describe("Agent avatar", () => {
  test("lets users set an emoji avatar and upload a compressed image avatar", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Avatar-${Date.now()}`,
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
        name: "Avatar Agent",
        role: "engineer",
        title: "Visual Identity",
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
    await expect(page.getByRole("heading", { name: "Avatar Agent", exact: true })).toBeVisible();

    const avatarButton = page.getByRole("button", { name: "Change agent avatar" });
    await avatarButton.click();
    await page.getByRole("textbox", { name: "Emoji" }).fill("🧪");
    const emojiPatch = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/agents/${agent.id}`),
    );
    await page.getByRole("button", { name: "Apply" }).click();
    await expect((await emojiPatch).ok()).toBe(true);
    await expect(avatarButton).toContainText("🧪");

    await avatarButton.click();
    const uploadResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/agents/${agent.id}/avatar`),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: AVATAR_PNG,
    });
    const uploaded = await uploadResponse;
    expect(uploaded.ok()).toBe(true);

    const refreshedRes = await page.request.get(`/api/agents/${agent.id}?orgId=${organization.id}`);
    expect(refreshedRes.ok()).toBe(true);
    const refreshedAgent = await refreshedRes.json();
    expect(refreshedAgent.icon).toMatch(/^asset:/);
    await expect(avatarButton.locator("img")).toHaveAttribute("src", /\/api\/assets\/.+\/content/);
  });
});
