import { expect, test, type Locator, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

async function createPromptStarterContext(page: Page) {
  const suffix = Date.now();
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Prompt-Starters-${suffix}`,
      issuePrefix: `P${suffix.toString(36).slice(-8)}`,
    },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: `Prompt Starter Agent ${suffix}`,
  }) as { id: string; name: string };

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: { name: `Prompt Starter Project ${suffix}` },
  });
  expect(projectRes.ok(), await projectRes.text()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string };

  const skillSlug = `prompt-starter-skill-${suffix}`;
  const skillName = `Prompt Starter Skill ${suffix}`;
  const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
    data: {
      name: skillName,
      slug: skillSlug,
      markdown: `---\nname: ${skillSlug}\ndescription: Keeps prompt starter context attached.\n---\n\n# Prompt Starter Skill\n`,
    },
  });
  expect(skillRes.ok(), await skillRes.text()).toBe(true);
  const skill = await skillRes.json() as { key: string; slug: string };

  const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
    data: { desiredSkills: [`org:${skill.key}`] },
  });
  expect(syncRes.ok(), await syncRes.text()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  return { agent, organization, project, skill: { ...skill, name: skillName } };
}

async function resetComposer(composer: Locator) {
  await composer.click();
  await composer.press("ControlOrMeta+A");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");
}

test("new-chat prompt starters fill complete prompts and keep composer context", async ({ page }) => {
  const { agent, organization, project, skill } = await createPromptStarterContext(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat?projectId=${project.id}&agentId=${agent.id}`);

  const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
  const starters = page.getByTestId("chat-empty-state-starters");
  const suggestions = page.getByTestId("chat-empty-state-prompt-options");
  const promptFlow = page.getByTestId("chat-empty-state-prompt-flow");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(starters).toBeVisible();
  await expect(promptFlow).toHaveAttribute("data-state", "starters");
  await expect(promptFlow.locator(".t-page-slide")).toHaveAttribute("data-page", "1");
  await expect(starters.getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Create a file or build a site" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Research and plan next steps" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a briefing on recent work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Automate routine and recurring work" })).toBeVisible();
  await expect(page.getByTestId("chat-project-selector")).toContainText(project.name);
  await expect(page.getByTestId("chat-runtime-selector")).toBeVisible();
  await expect.poll(async () => starters.evaluate((element) => {
    const composerElement = document.querySelector(".chat-composer");
    return Boolean(composerElement && (element.compareDocumentPosition(composerElement) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);

  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByPlaceholder("Search skills...").fill(skill.slug);
  await page.getByRole("menuitem").filter({ hasText: skill.slug }).click();
  await expect(composer.locator("[data-skill-token='true']")).toHaveCount(1);
  await expect(starters).toBeVisible();

  await page.getByRole("button", { name: "Automate routine and recurring work" }).click({
    clickCount: 2,
    delay: 35,
  });
  await expect(composer).toContainText("Automate");
  await expect(composer).not.toContainText("Start by asking me");
  await expect(composer).toHaveCSS("font-weight", "600");
  await expect(composer.locator("[data-skill-token='true']")).toHaveCount(1);
  await expect(composer).toContainText(skill.slug);
  await expect(composer).toBeFocused();
  await expect(starters).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => promptFlow.locator("[data-page-id='1']").evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole("option")).toHaveCount(4);
  await expect(suggestions.getByRole("option").locator("strong")).toHaveText([
    "Automate",
    "Automate",
    "Automate",
    "Automate",
  ]);
  await expect(promptFlow).toHaveAttribute("data-state", "suggestions");
  await expect(promptFlow.locator(".t-page-slide")).toHaveAttribute("data-page", "2");
  await expect(suggestions).toHaveAttribute("data-interactive", "true");
  await expect(suggestions.getByRole("option").first()).toBeEnabled();
  await expect(page.getByTestId("chat-project-selector")).toContainText(project.name);
  await expect(page.getByTestId("chat-runtime-selector")).toBeVisible();

  const chatsAfterStarterRes = await page.request.get(`/api/orgs/${organization.id}/chats?status=all&limit=40`);
  expect(chatsAfterStarterRes.ok(), await chatsAfterStarterRes.text()).toBe(true);
  expect(await chatsAfterStarterRes.json()).toEqual([]);

  await suggestions.getByRole("option", { name: "Automate my morning prep" }).click();
  await expect(composer).toContainText("Automate my morning prep. Start by asking me what I want included each morning.");
  await expect(composer.locator("[data-skill-token='true']")).toHaveCount(1);
  await expect(suggestions).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => promptFlow.locator("[data-page-id='2']").evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await expect(suggestions.locator("[role='option']")).toHaveCount(4);
  await expect(promptFlow).toHaveAttribute("data-state", "hidden");

  await resetComposer(composer);
  await composer.fill("Automate");
  await expect(suggestions).toBeVisible();
  await expect(suggestions).toHaveAttribute("role", "listbox");
  await expect(suggestions.getByRole("option")).toHaveCount(4);
  await expect(suggestions.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(suggestions.getByRole("option").nth(0)).toHaveAttribute("tabindex", "-1");
  await expect(composer).toHaveAttribute("role", "combobox");
  await expect(composer).toHaveAttribute("aria-autocomplete", "list");
  await expect(composer).toHaveAttribute("aria-expanded", "true");
  await expect(composer).toHaveAttribute("aria-controls", "chat-empty-state-prompt-options");
  await expect(composer).toHaveAttribute("aria-activedescendant", /automate-report$/);
  await composer.press("ArrowDown");
  await expect(suggestions.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-activedescendant", /automate-morning-prep$/);
  await composer.press("ArrowUp");
  await expect(suggestions.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-activedescendant", /automate-report$/);
  await composer.press("ArrowDown");
  await composer.press("Enter");
  await expect(composer).toHaveText("Automate my morning prep. Start by asking me what I want included each morning.");
  await expect(suggestions).toHaveAttribute("aria-hidden", "true");
  await expect(composer).toHaveAttribute("aria-expanded", "false");

  await resetComposer(composer);
  await composer.fill("bRiEf Me On");
  await expect(suggestions.getByRole("option", { name: "Brief me on a project" })).toBeVisible();
  await composer.press("Tab");
  await expect(composer).toHaveText("Brief me on a project. Start by asking me which project to cover.");
  await expect(composer).toBeFocused();
  await expect(suggestions).toHaveAttribute("aria-hidden", "true");

  await resetComposer(composer);
  await page.getByRole("button", { name: "Skills" }).click();
  await page.getByPlaceholder("Search skills...").fill(skill.slug);
  await page.getByRole("menuitem").filter({ hasText: skill.slug }).click();
  await expect(composer.locator("[data-skill-token='true']")).toHaveCount(1);
  await composer.pressSequentially("Automate");
  await expect(suggestions).toBeVisible();
  await suggestions.getByRole("option", { name: "Automate triage" }).click();
  await expect(composer).toContainText("Automate triage. Start by asking me how I want items prioritized and handled.");
  await expect(composer.locator("[data-skill-token='true']")).toHaveCount(1);
  await expect(composer).toContainText(skill.slug);
  await expect(page.getByTestId("chat-project-selector")).toContainText(project.name);
  await expect(page.getByTestId("chat-runtime-selector")).toBeVisible();

  await resetComposer(composer);
  await composer.fill("Automate");
  await expect(suggestions).toBeVisible();
  await composer.press("Escape");
  await expect(suggestions).toHaveAttribute("aria-hidden", "true");
  await expect(composer).toHaveText("Automate");
  await composer.pressSequentially(" my");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(suggestions.getByRole("option", { name: "Automate my morning prep" })).toBeVisible();

  await resetComposer(composer);
  await composer.fill("Create a");
  const staleDocumentSuggestion = suggestions.getByRole("option", { name: "Create a new document" });
  await expect(suggestions.getByRole("option")).toHaveCount(4);
  await expect(staleDocumentSuggestion).toBeVisible();
  await composer.fill("Create a new d");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(staleDocumentSuggestion).toBeVisible();
  await composer.fill("what");
  await expect(promptFlow).toHaveAttribute("data-state", "hidden");
  await expect(suggestions).toHaveAttribute("aria-hidden", "true");
  await expect(suggestions).toHaveAttribute("data-interactive", "false");
  await expect(suggestions.locator("[role='option']")).toHaveCount(0);
  await expect(staleDocumentSuggestion).toHaveCount(0);
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await composer.press("Tab");
  await expect(composer).toHaveText("what");
  await expect(page.getByTestId("chat-project-selector")).toContainText(project.name);
  await expect(page.getByTestId("chat-runtime-selector")).toBeVisible();

  await resetComposer(composer);
  await expect(promptFlow).toHaveAttribute("data-state", "starters");
  await expect(starters).toBeVisible();
  await expect(starters.getByRole("button")).toHaveCount(4);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(starters).toBeVisible();
  await expect(page.getByRole("button", { name: "Automate routine and recurring work" })).toBeVisible();
  const mobileMetrics = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    starterHeights: Array.from(document.querySelectorAll("[data-testid^='chat-empty-state-starter-']"))
      .map((element) => element.clientHeight),
    starterOverflows: Array.from(document.querySelectorAll("[data-testid^='chat-empty-state-starter-']"))
      .map((element) => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight),
  }));
  expect(mobileMetrics.bodyWidth).toBeLessThanOrEqual(mobileMetrics.viewportWidth);
  expect(new Set(mobileMetrics.starterHeights).size).toBe(1);
  expect(mobileMetrics.starterHeights.every((height) => height <= 48)).toBe(true);
  expect(mobileMetrics.starterOverflows).toEqual([false, false, false, false]);

  await composer.fill("Create a");
  await expect(suggestions.getByRole("option")).toHaveCount(4);
  await composer.fill("what");
  await expect(promptFlow).toHaveAttribute("data-state", "hidden");
  await expect(suggestions.locator("[role='option']")).toHaveCount(0);
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await resetComposer(composer);
  await expect(promptFlow).toHaveAttribute("data-state", "starters");
  await expect(starters.getByRole("button")).toHaveCount(4);

  const existingChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: { title: "Existing prompt starter boundary", preferredAgentId: agent.id },
  });
  expect(existingChatRes.ok(), await existingChatRes.text()).toBe(true);
  const existingChat = await existingChatRes.json() as { id: string };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${existingChat.id}`);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Automate");
  await expect(suggestions).toHaveCount(0);
});
