import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createAgent(page: Page, orgId: string, name: string) {
  const agentRes = await page.request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name,
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json();
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

test("backspace deletes a clicked mention token and keeps the composer editable", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Mention-Backspace-${Date.now()}`);
  const agent = await createAgent(page, organization.id, "Para Memory");

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Ask @Para");
  await expect(page.getByTestId(`markdown-mention-option-agent:${agent.id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();

  const mentionToken = composer.locator("[data-mention-kind='agent']").filter({ hasText: "Para Memory" }).first();
  await expect(mentionToken).toBeVisible();

  const mentionBox = await mentionToken.boundingBox();
  expect(mentionBox).not.toBeNull();
  await mentionToken.click({
    force: true,
    position: {
      x: Math.max(1, mentionBox!.width - 2),
      y: Math.max(1, mentionBox!.height / 2),
    },
  });
  await page.keyboard.press("Backspace");
  await expect(mentionToken).toHaveCount(0);
  await expect(composer).toContainText("Ask");

  await page.keyboard.type(" about launch");
  await expect(composer).toContainText("Ask about launch");
});

test("backspace deletes normal text after mixed skill tokens and an active @ query", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Mixed-Backspace-${Date.now()}`);
  const agent = await createAgent(page, organization.id, "Advisor");
  const skill = await createSkill(page, organization.id, "Build Advisor", "build-advisor");
  await syncAgentSkills(page, agent.id, organization.id, [`org:${skill.key}`]);

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Backspace mixed composer",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Use this");

  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByPlaceholder("Search skills...").fill("build-advisor");
  await page
    .getByRole("menuitem")
    .filter({ hasText: "Build Advisor" })
    .first()
    .click();

  const skillToken = composer.locator("[data-skill-token='true']").filter({ hasText: "build-advisor" }).first();
  await expect(skillToken).toBeVisible();

  await page.keyboard.type(" asdasd @para");
  await expect(composer).toContainText("@para");

  await page.keyboard.press("Backspace");
  await expect(composer).toContainText("@par");
  await expect(composer).not.toContainText("@para");

  await page.keyboard.press("Backspace");
  await expect(composer).toContainText("@pa");
  await expect(skillToken).toBeVisible();
});
