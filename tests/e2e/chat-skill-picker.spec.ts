import fs from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_CODEX_STUB, E2E_HOME } from "./support/e2e-env";

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

async function syncAgentSkills(
  request: APIRequestContext,
  agentId: string,
  orgId: string,
  desiredSkills: string[],
) {
  const syncRes = await request.post(`/api/agents/${agentId}/skills/sync?orgId=${encodeURIComponent(orgId)}`, {
    data: { desiredSkills },
  });
  expect(syncRes.ok()).toBe(true);
}

test.describe("Chat skill picker", () => {
  test("shows the skill picker for the default selected chat agent", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Skill-Explicit-Agent-${Date.now()}`,
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
    await syncAgentSkills(page.request, agent.id, organization.id, ["build-advisor"]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat`);

    await expect(page.getByRole("button", { name: new RegExp(agent.name) })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Skills" })).toBeVisible();

    const composerSurface = page.locator(".chat-composer").first();
    await page.getByTestId("chat-agent-selector").click();
    const agentMenu = page.getByTestId("chat-agent-menu");
    await expect(agentMenu).toBeVisible();
    const composerSurfaceBox = await composerSurface.boundingBox();
    const agentMenuBox = await agentMenu.boundingBox();
    expect(composerSurfaceBox).not.toBeNull();
    expect(agentMenuBox).not.toBeNull();
    expect(agentMenuBox!.y + agentMenuBox!.height).toBeLessThanOrEqual(composerSurfaceBox!.y + 1);
    await expect(page.getByRole("menuitemradio", { name: "No agent selected" })).toHaveCount(0);
  });

  test("searches installed skills, inserts immediately, and keeps readable markdown", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Skill-Chat-${Date.now()}`,
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
    await syncAgentSkills(page.request, agent.id, organization.id, ["alpha-test", "beta-search"]);

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

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

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
    await page.getByRole("menuitem").filter({ hasText: /Beta Search|beta-search/ }).click();

    await page.getByRole("button", { name: "Skills" }).click();
    const reopenedSkillMenu = page.getByTestId("chat-skill-menu");
    await expect(reopenedSkillMenu).toBeVisible();
    const reopenedSearchInput = reopenedSkillMenu.getByPlaceholder("Search skills...");
    await expect(reopenedSearchInput).toBeVisible();
    await reopenedSearchInput.fill("alpha");
    await reopenedSkillMenu.getByRole("menuitem").filter({ hasText: /Alpha Test|alpha-test/ }).click();

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

  test("renders external skill names with source badges in the skill picker", async ({ page }) => {
    const unique = Date.now();
    const globalSkillName = `global-picker-${unique}`;
    const adapterSkillName = `adapter-picker-${unique}`;
    const codexHome = path.join(E2E_HOME, ".codex", `picker-${unique}`);

    const globalSkillDir = path.join(E2E_HOME, ".agents", "skills", globalSkillName);
    const adapterSkillDir = path.join(codexHome, "skills", adapterSkillName);
    await fs.mkdir(globalSkillDir, { recursive: true });
    await fs.mkdir(adapterSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(globalSkillDir, "SKILL.md"),
      `---\nname: ${globalSkillName}\ndescription: Global picker helper.\n---\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(adapterSkillDir, "SKILL.md"),
      `---\nname: ${adapterSkillName}\ndescription: Adapter picker helper.\n---\n`,
      "utf8",
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Skill-Picker-Badges-${unique}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Badge Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
          env: {
            HOME: E2E_HOME,
            CODEX_HOME: codexHome,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
      data: {
        desiredSkills: [globalSkillName, adapterSkillName],
      },
    });
    expect(syncRes.ok()).toBe(true);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Skill picker badges",
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
    await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Skills" }).click();
    const skillMenu = page.getByTestId("chat-skill-menu");
    await expect(skillMenu).toBeVisible({ timeout: 15_000 });

    const globalRow = skillMenu.getByRole("menuitem").filter({ hasText: globalSkillName });
    await expect(globalRow).toBeVisible();
    await expect(globalRow.getByText("Global skill", { exact: true })).toBeVisible();
    await expect(globalRow).toContainText("Global picker helper.");
    await expect(globalRow).not.toContainText("Global skill · ~/.agents/skills");

    const adapterRow = skillMenu.getByRole("menuitem").filter({ hasText: adapterSkillName });
    await expect(adapterRow).toBeVisible();
    await expect(adapterRow.getByText("Adapter skill", { exact: true })).toBeVisible();
    await expect(adapterRow).toContainText("Adapter picker helper.");
    await expect(adapterRow).not.toContainText("Adapter skill · ~/.codex/skills");
  });

  test("surfaces skills inside $ mentions and inserts a skill token", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Mention-Skill-${Date.now()}`,
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
    await syncAgentSkills(page.request, agent.id, organization.id, ["build-advisor"]);
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

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Use $advisor");

    const mentionMenu = page.getByTestId("markdown-mention-menu");
    await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
    const skillOption = mentionMenu.locator('[data-testid^="markdown-mention-option-skill:"]').first();
    await expect(skillOption).toContainText("Build Advisor", { timeout: 15_000 });
    await skillOption.dispatchEvent("mousedown");

    const insertedSkillToken = page.locator(".rudder-mdxeditor-content [data-skill-token='true']").first();
    await expect(insertedSkillToken).toBeVisible({ timeout: 15_000 });
    const insertedSkillLabel = (await insertedSkillToken.textContent())?.trim() ?? "";
    expect(insertedSkillLabel).toContain("build-advisor");

    await page.getByRole("button", { name: "Send" }).click();

    const userBubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "Use" }).last();
    await expect(userBubble.getByText(insertedSkillLabel, { exact: true })).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => {
      const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
      expect(messagesRes.ok()).toBe(true);
      const messages = await messagesRes.json();
      const userMessage = messages.find((message: { role: string; kind: string }) => message.role === "user" && message.kind === "message");
      return userMessage?.body ?? "";
    }).toContain(`[${insertedSkillLabel}](${skillTarget})`);
  });

  test("keeps mention suggestions fully visible near the bottom composer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Mention-Menu-${Date.now()}`,
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

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

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
