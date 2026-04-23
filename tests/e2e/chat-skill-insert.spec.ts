import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
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
  return skillRes.json();
}

test("inserts a skill immediately, keeps it stable on click, and allows continued typing", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Skill-Chat-${Date.now()}`);

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Advisor",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json();

  await createSkill(page, organization.id, "Build Advisor", "build-advisor");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Skill insert",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Please review this UI.");

  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByPlaceholder("Search skills...").fill("no-match-skill");
  await expect(page.getByText("No skills match search.")).toBeVisible();
  await page.getByPlaceholder("Search skills...").fill("build-advisor");
  await expect(page.getByRole("menuitem", { name: "Insert selected skills" })).toHaveCount(0);
  await page
    .getByRole("menuitem")
    .filter({ hasText: "build-advisor" })
    .first()
    .click();

  const composerToken = page.locator(".rudder-mdxeditor-content [data-skill-token='true']").filter({ hasText: "build-advisor" }).first();
  await expect(composerToken).toBeVisible();
  await expect(composerToken).not.toHaveAttribute("data-removable", "true");
  const insertedLabel = (await composerToken.innerText()).trim();
  await composerToken.click({ force: true });
  await expect(composerToken).toBeVisible();
  await page.keyboard.type(" and keep going.");
  await expect(composer).toContainText("Please review this UI.");
  await expect(composer).toContainText("and keep going.");

  await page.getByRole("button", { name: "Send" }).click();
  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("Please review this UI.", { timeout: 15_000 });
  await expect(userBubble).toContainText("and keep going.", { timeout: 15_000 });
  await expect(userBubble.getByText(insertedLabel, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(userBubble.getByRole("link", { name: insertedLabel })).toHaveCount(0);

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json();
  const userMessage = messages.find((message: { role: string }) => message.role === "user");
  expect(userMessage?.body).toContain("Please review this UI.");
  expect(userMessage?.body).toContain("and keep going.");
  expect(userMessage?.body).toContain(`[${insertedLabel}](`);
  expect(userMessage?.body).toContain("/build-advisor/SKILL.md)");
});

test("backspace removes the full inserted skill token from the composer", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Skill-Delete-${Date.now()}`);

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Advisor",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json();

  await createSkill(page, organization.id, "Build Advisor", "build-advisor");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Skill delete",
      preferredAgentId: agent.id,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Use this");

  await page.getByRole("button", { name: "Skills" }).click();
  await page
    .getByRole("menuitem")
    .filter({ hasText: "build-advisor" })
    .first()
    .click();

  const composerToken = page.locator(".rudder-mdxeditor-content [data-skill-token='true']").filter({ hasText: "build-advisor" }).first();
  await expect(composerToken).toBeVisible();

  await page.keyboard.press("Backspace");
  await expect(composerToken).toHaveCount(0);
  await expect(composer).toContainText("Use this");

  await page.keyboard.type(" only.");
  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("Use this only.", { timeout: 15_000 });
  await expect(userBubble.getByText(/build-advisor/)).toHaveCount(0);

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json();
  const userMessage = messages.find((message: { role: string }) => message.role === "user");
  expect(userMessage?.body).toBe("Use this only.");
});
