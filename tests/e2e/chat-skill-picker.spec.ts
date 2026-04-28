import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

function organizationSkillMarkdownTarget(skill: { sourceLocator?: string | null; sourcePath?: string | null }) {
  const candidate = skill.sourceLocator ?? skill.sourcePath ?? null;
  if (!candidate) return null;
  return candidate.endsWith("/SKILL.md") || candidate.toLowerCase().endsWith(".md")
    ? candidate
    : `${candidate.replace(/\/$/, "")}/SKILL.md`;
}

async function createSkill(request: APIRequestContext, orgId: string, name: string, slug: string) {
  const skillRes = await request.post(`/api/orgs/${orgId}/skills`, {
    data: {
      name,
      slug,
      markdown: `---\nname: ${name}\n---\n\n# ${name}\n`,
    },
  });
  expect(skillRes.ok()).toBe(true);
  return skillRes.json();
}

test.describe("Chat skill picker", () => {
  test("hides the skill picker while Rudder Copilot is selected", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Skill-Copilot-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
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

    await createSkill(page.request, organization.id, "Build Advisor", "build-advisor");

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    await expect(page.getByRole("button", { name: "Rudder Copilot" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Skills" })).toHaveCount(0);

    const composerSurface = page.locator(".chat-composer").first();
    await page.getByRole("button", { name: "Rudder Copilot" }).click();
    const agentMenu = page.getByTestId("chat-agent-menu");
    await expect(agentMenu).toBeVisible();
    const composerSurfaceBox = await composerSurface.boundingBox();
    const agentMenuBox = await agentMenu.boundingBox();
    expect(composerSurfaceBox).not.toBeNull();
    expect(agentMenuBox).not.toBeNull();
    expect(agentMenuBox!.y + agentMenuBox!.height).toBeLessThanOrEqual(composerSurfaceBox!.y + 1);
    await page.getByRole("menuitemradio", { name: new RegExp(agent.name) }).click();

    await expect(page.getByRole("button", { name: new RegExp(agent.name) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skills" })).toBeVisible();
  });

  test("searches installed skills, inserts immediately, and keeps readable markdown", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Skill-Chat-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
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

    await createSkill(page.request, organization.id, "Alpha Test", "alpha-test");
    await createSkill(page.request, organization.id, "Beta Search", "beta-search");

    const skillsRes = await page.request.get(`/api/orgs/${organization.id}/skills`);
    expect(skillsRes.ok()).toBe(true);
    const skills = await skillsRes.json();
    const alphaSkill = skills.find((skill: { slug: string }) => skill.slug === "alpha-test");
    const betaSkill = skills.find((skill: { slug: string }) => skill.slug === "beta-search");
    expect(alphaSkill).toBeTruthy();
    expect(betaSkill).toBeTruthy();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Skill picker insertion",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
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
    await composer.fill("Use these skills");

    await page.getByRole("button", { name: "Skills" }).click();
    const skillMenu = page.getByTestId("chat-skill-menu");
    await expect(skillMenu).toBeVisible();
    const composerSurfaceBox = await page.locator(".chat-composer").first().boundingBox();
    const skillMenuBox = await skillMenu.boundingBox();
    expect(composerSurfaceBox).not.toBeNull();
    expect(skillMenuBox).not.toBeNull();
    expect(skillMenuBox!.y + skillMenuBox!.height).toBeLessThanOrEqual(composerSurfaceBox!.y + 1);
    const searchInput = page.getByPlaceholder("Search skills...");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("beta");
    await expect(page.getByRole("menuitem", { name: "Insert selected skills" })).toHaveCount(0);
    await page.getByRole("menuitem").filter({ hasText: "beta-search" }).click();

    await page.getByRole("button", { name: "Skills" }).click();
    await expect(searchInput).toBeVisible();
    await searchInput.fill("alpha");
    await page.getByRole("menuitem").filter({ hasText: "alpha-test" }).click();

    const insertedLabels = (await page.locator(".rudder-mdxeditor-content [data-skill-token='true']").allInnerTexts()).map((value) => value.trim());
    const alphaSkillLabel = insertedLabels.find((value) => value.includes("alpha-test"));
    const betaSkillLabel = insertedLabels.find((value) => value.includes("beta-search"));
    expect(alphaSkillLabel).toBeTruthy();
    expect(betaSkillLabel).toBeTruthy();

    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByTestId("chat-user-message-bubble").filter({ hasText: "Use these skills" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Streaming reply for chat.", { exact: false })).toBeVisible({ timeout: 15_000 });

    const alphaTarget = organizationSkillMarkdownTarget(alphaSkill);
    const betaTarget = organizationSkillMarkdownTarget(betaSkill);
    expect(alphaTarget).toBeTruthy();
    expect(betaTarget).toBeTruthy();

    const userMessageAlphaRef = `[${alphaSkillLabel}](${alphaTarget})`;
    const userMessageBetaRef = `[${betaSkillLabel}](${betaTarget})`;

    const userBubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "Use these skills" }).last();
    await expect(userBubble.getByText(alphaSkillLabel!, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(userBubble.getByText(betaSkillLabel!, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(userBubble.getByRole("link", { name: alphaSkillLabel! })).toHaveCount(0);
    await expect(userBubble.getByRole("link", { name: betaSkillLabel! })).toHaveCount(0);

    const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
    expect(messagesRes.ok()).toBe(true);
    const messages = await messagesRes.json();
    const userMessage = messages.find((message: { role: string; kind: string }) => message.role === "user" && message.kind === "message");
    expect(userMessage).toBeTruthy();
    expect(userMessage.body).toContain(userMessageAlphaRef);
    expect(userMessage.body).toContain(userMessageBetaRef);
    expect(userMessage.body).not.toContain("\n\n");
  });

  test("surfaces skills inside @ mentions and inserts a skill token", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Mention-Skill-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
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

    const skill = await createSkill(page.request, organization.id, "Build Advisor", "build-advisor");
    const skillTarget = organizationSkillMarkdownTarget(skill);
    expect(skillTarget).toBeTruthy();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Mention skill insertion",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
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
    await composer.fill("Use @advisor");

    await expect(page.getByTestId(`markdown-mention-option-skill:${skill.id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`markdown-mention-option-skill:${skill.id}`).click();

    const insertedSkillToken = page.locator(".rudder-mdxeditor-content [data-skill-token='true']").first();
    await expect(insertedSkillToken).toBeVisible({ timeout: 15_000 });
    const insertedSkillLabel = (await insertedSkillToken.textContent())?.trim() ?? "";
    expect(insertedSkillLabel).toContain("build-advisor");

    await page.getByRole("button", { name: "Send" }).click();

    const userBubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "Use" }).last();
    await expect(userBubble.getByText(insertedSkillLabel, { exact: true })).toBeVisible({ timeout: 15_000 });

    const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
    expect(messagesRes.ok()).toBe(true);
    const messages = await messagesRes.json();
    const userMessage = messages.find((message: { role: string; kind: string }) => message.role === "user" && message.kind === "message");
    expect(userMessage).toBeTruthy();
    expect(userMessage.body).toContain(`[${insertedSkillLabel}](${skillTarget})`);
  });

  test("keeps mention suggestions fully visible near the bottom composer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Mention-Menu-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
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

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Mention visibility",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
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
    await composer.fill("@");

    const mentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`markdown-mention-option-agent:${agent.id}`)).toBeVisible({ timeout: 15_000 });

    const menuBox = await mentionMenu.boundingBox();
    const composerBox = await composer.boundingBox();
    const viewport = page.viewportSize();

    expect(menuBox).toBeTruthy();
    expect(composerBox).toBeTruthy();
    expect(viewport).toBeTruthy();

    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(composerBox!.y + 8);
  });
});
