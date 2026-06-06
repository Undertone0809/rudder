import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    command: E2E_CODEX_STUB,
  });
  return { ...organization, chatAgent };
}

async function createSkill(page: Page, orgId: string, name: string, slug: string) {
  const skillRes = await page.request.post(`/api/orgs/${orgId}/skills`, {
    data: {
      name,
      slug,
      markdown: `---\nname: ${name}\n---\n\n# ${name}\n`,
    },
  });
  expect(skillRes.ok()).toBe(true);
  return skillRes.json() as Promise<{ key: string }>;
}

async function syncAgentSkills(page: Page, agentId: string, orgId: string, desiredSkills: string[]) {
  const syncRes = await page.request.post(`/api/agents/${agentId}/skills/sync?orgId=${encodeURIComponent(orgId)}`, {
    data: { desiredSkills },
  });
  expect(syncRes.ok()).toBe(true);
}

test.describe("Chat edit streaming layout", () => {
  test("shows only the replacement branch while an edited message is streaming", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Edt-Chat-${Date.now()}`);
    const skill = await createSkill(page, organization.id, "Build Advisor", "build-advisor");
    await syncAgentSkills(page, organization.chatAgent.id, organization.id, [`org:${skill.key}`]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

    const composer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Original edit target");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Streaming reply for chat.", { exact: false })).toBeVisible({ timeout: 15_000 });

    const originalBubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" }).last();
    await originalBubble.hover();
    await page.getByRole("button", { name: "Edit message" }).last().click();

    const inlineEditor = page.getByTestId("chat-inline-message-editor");
    await expect(inlineEditor).toBeVisible();
    await expect(inlineEditor).toContainText("Original edit target");
    await expect(composer).not.toContainText("Original edit target");
    const inlineContent = inlineEditor.locator(".rudder-mdxeditor-content").first();
    await inlineContent.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" $");
    const inlineMentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(inlineMentionMenu).toBeVisible();
    await expect(inlineMentionMenu.getByRole("menuitem").filter({ hasText: "Build Advisor" }).first()).toBeVisible();
    const inlineEditorBox = await inlineEditor.boundingBox();
    const mentionMenuBox = await inlineMentionMenu.boundingBox();
    expect(inlineEditorBox).not.toBeNull();
    expect(mentionMenuBox).not.toBeNull();
    expect(mentionMenuBox!.y).toBeGreaterThanOrEqual(inlineEditorBox!.y + inlineEditorBox!.height - 2);
    await inlineEditor.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" })).toBeVisible();
    await expect(composer).not.toContainText("Original edit target");

    await originalBubble.hover();
    await page.getByRole("button", { name: "Edit message" }).last().click();
    await expect(inlineEditor).toBeVisible();
    await inlineEditor.locator(".rudder-mdxeditor-content").fill("Edited edit target");
    await inlineEditor.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByTestId("chat-user-message-bubble").filter({ hasText: "Edited edit target" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("chat-user-message-bubble")).toHaveCount(1);
  });
});
