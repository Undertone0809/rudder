import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

function organizationSkillMarkdownTarget(skill: { sourceLocator?: string | null; sourcePath?: string | null }) {
  const candidate = skill.sourceLocator ?? skill.sourcePath ?? null;
  if (!candidate) return null;
  return candidate.endsWith("/SKILL.md") || candidate.toLowerCase().endsWith(".md")
    ? candidate
    : `${candidate.replace(/\/$/, "")}/SKILL.md`;
}

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createIssue(page: Page, orgId: string, title: string) {
  const issueRes = await page.request.post(`/api/orgs/${orgId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  return issueRes.json() as Promise<{ id: string; identifier: string | null; title: string }>;
}

test("chat composer reference tokens navigate to their target pages", async ({ page }) => {
  const organization = await createOrganization(page, "Composer-Reference-Navigation");
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "Navigator Agent" }) as {
    id: string;
    name: string;
  };
  const issue = await createIssue(page, organization.id, "Navigation issue");

  const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
    data: {
      name: "Navigation Skill",
      slug: "navigation-skill",
      markdown: "---\nname: Navigation Skill\n---\n\n# Navigation Skill\n",
    },
  });
  expect(skillRes.ok()).toBe(true);
  const skill = await skillRes.json() as {
    id: string;
    key: string;
    sourceLocator?: string | null;
    sourcePath?: string | null;
  };
  const skillTarget = organizationSkillMarkdownTarget(skill);
  expect(skillTarget).toBeTruthy();

  const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
    data: { desiredSkills: [`org:${skill.key}`] },
  });
  expect(syncRes.ok()).toBe(true);

  const hostChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Navigation host chat",
      preferredAgentId: agent.id,
    },
  });
  expect(hostChatRes.ok()).toBe(true);
  const hostChat = await hostChatRes.json() as { id: string };

  const referencedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Referenced navigation chat",
      preferredAgentId: agent.id,
    },
  });
  expect(referencedChatRes.ok()).toBe(true);
  const referencedChat = await referencedChatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const hostChatPath = `/${organization.issuePrefix}/messenger/chat/${hostChat.id}`;
  await page.goto(hostChatPath);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const issueRef = issue.identifier ?? issue.id;
  const draft = [
    `[${agent.name}](agent://${agent.id})`,
    `[${issue.title}](issue://${issue.id}?r=${encodeURIComponent(issueRef)})`,
    `[Referenced navigation chat](chat://${referencedChat.id})`,
    `[navigation-skill](${skillTarget})`,
  ].join(" ");

  await composer.fill(draft);

  const agentToken = composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name }).first();
  const issueToken = composer.locator("[data-mention-kind='issue']").filter({ hasText: issue.title }).first();
  const chatToken = composer.locator("[data-mention-kind='chat']").filter({ hasText: "Referenced navigation chat" }).first();
  const skillToken = composer.locator("[data-skill-token='true']").filter({ hasText: "navigation-skill" }).first();

  await expect(agentToken).toBeVisible({ timeout: 15_000 });
  await expect(issueToken).toBeVisible();
  await expect(chatToken).toBeVisible();
  await expect(skillToken).toBeVisible();

  await agentToken.click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/${agent.id}$`));

  await page.goto(hostChatPath);
  await expect(issueToken).toBeVisible({ timeout: 15_000 });
  await issueToken.click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues/${issueRef}$`));

  await page.goto(hostChatPath);
  await expect(chatToken).toBeVisible({ timeout: 15_000 });
  await chatToken.click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat/${referencedChat.id}$`));

  await page.goto(hostChatPath);
  await expect(skillToken).toBeVisible({ timeout: 15_000 });
  await skillToken.click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/skills/${skill.id}$`));
});
