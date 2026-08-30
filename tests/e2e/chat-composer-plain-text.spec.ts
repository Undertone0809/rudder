import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createChatAgent(page: Page, orgId: string, name: string) {
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
  return agentRes.json() as Promise<{ id: string; name: string }>;
}

test("chat composer keeps normal Markdown literal while tokenizing Rudder references", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Plain-Text");
  const agent = await createChatAgent(page, organization.id, "Copy Agent");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Plain composer",
      preferredAgentId: agent.id,
      initialMessage: { body: "Plain composer seed" },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const canonicalReference = `[${agent.name}](agent://${agent.id})`;
  const draft = `**bold** # title [plain](https://example.com) ${canonicalReference}`;
  await composer.fill(draft);

  await expect(composer).toContainText("**bold** # title [plain](https://example.com)");
  await expect(composer.locator("strong")).toHaveCount(0);
  await expect(composer.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(0);
  await expect(composer.locator('a[href="https://example.com"]')).toHaveCount(0);
  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name }).first();
  await expect(token).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("**bold** # title plain", { timeout: 15_000 });
  await expect(userBubble.locator("strong")).toHaveCount(0);
  await expect(userBubble.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(0);
  await expect(userBubble.locator('a[href="https://example.com"]')).toHaveCount(1);
  await expect(userBubble).toContainText(agent.name);

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{ role: string; body: string }>;
  const userMessage = messages.filter((message) => message.role === "user").at(-1);
  expect(userMessage?.body).toBe(draft);
});

test("chat composer treats Rudder references as atomic caret boundaries", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Reference-Caret");
  const agent = await createChatAgent(page, organization.id, "原则");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Reference caret",
      preferredAgentId: agent.id,
      initialMessage: { body: "Reference caret seed" },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const canonicalReference = `[${agent.name}](agent://${agent.id})`;
  const canonicalSkillReference = "[visualize](skill://org/e2e-visualize?ref=visualize)";
  await composer.fill(`请参考 ${canonicalReference} 与 ${canonicalSkillReference} 后续计划`);

  const agentToken = composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name }).first();
  const skillToken = composer.locator("[data-skill-token='true']").filter({ hasText: "visualize" }).first();
  await expect(agentToken).toBeVisible({ timeout: 15_000 });
  await expect(skillToken).toBeVisible({ timeout: 15_000 });

  const selectionState = await agentToken.evaluate((element) => {
    const textNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (!textNode) return { ok: false, reason: "missing token text" };

    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const parent = element.parentNode;
    const tokenIndex = parent ? Array.prototype.indexOf.call(parent.childNodes, element) : -1;
    return {
      ok: selection?.anchorNode === parent && selection.anchorOffset === tokenIndex,
      anchorInsideToken: selection?.anchorNode ? element.contains(selection.anchorNode) : null,
      anchorOffset: selection?.anchorOffset ?? null,
      tokenIndex,
    };
  });

  expect(selectionState).toMatchObject({
    ok: true,
    anchorInsideToken: false,
  });

  const setTokenBoundary = async (token: typeof agentToken, edge: "before" | "after") => token.evaluate((element, requestedEdge) => {
    const parent = element.parentNode;
    if (!parent) throw new Error("missing token parent");
    const tokenIndex = Array.prototype.indexOf.call(parent.childNodes, element);
    const range = document.createRange();
    range.setStart(parent, requestedEdge === "before" ? tokenIndex : tokenIndex + 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, edge);
  const readTokenSelection = async (token: typeof agentToken) => token.evaluate((element) => {
    const selection = window.getSelection();
    const parent = element.parentNode;
    const tokenIndex = parent ? Array.prototype.indexOf.call(parent.childNodes, element) : -1;
    const boundary = (node: Node | null, offset: number) => {
      if (node !== parent) return "other";
      if (offset === tokenIndex) return "before";
      if (offset === tokenIndex + 1) return "after";
      return "other";
    };
    const semanticBoundary = (node: Node | null, offset: number) => {
      const exact = boundary(node, offset);
      if (exact !== "other" || !node) return exact;
      const tokenRange = document.createRange();
      tokenRange.selectNode(element);
      const relation = tokenRange.comparePoint(node, offset);
      if (relation < 0) return "before";
      if (relation > 0) return "after";
      return "other";
    };
    return {
      anchor: semanticBoundary(selection?.anchorNode ?? null, selection?.anchorOffset ?? -1),
      focus: semanticBoundary(selection?.focusNode ?? null, selection?.focusOffset ?? -1),
      anchorInside: selection?.anchorNode ? element.contains(selection.anchorNode) : false,
      focusInside: selection?.focusNode ? element.contains(selection.focusNode) : false,
    };
  });

  await setTokenBoundary(agentToken, "after");
  await page.keyboard.press("ArrowLeft");
  expect(await readTokenSelection(agentToken)).toMatchObject({ anchor: "before", focus: "before" });

  await page.keyboard.press("ArrowRight");
  expect(await readTokenSelection(agentToken)).toMatchObject({ anchor: "after", focus: "after" });

  await agentToken.click({ position: { x: 2, y: 2 } });
  expect(await readTokenSelection(agentToken)).toMatchObject({ anchor: "before", focus: "before" });

  for (const token of [agentToken, skillToken]) {
    const normalizedSelections = await token.evaluate((element) => {
      const tokenText = element.querySelector(".rudder-inline-token-label")?.firstChild
        ?? Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      const tokenHost = element.parentElement?.classList.contains("rudder-skill-token-wrap")
        ? element.parentElement
        : element;
      const leadingText = tokenHost.previousSibling;
      const trailingText = tokenHost.nextSibling;
      const parent = element.parentNode;
      if (!tokenText || !leadingText || !trailingText || !parent) {
        throw new Error("missing token selection fixture nodes");
      }
      const tokenIndex = Array.prototype.indexOf.call(parent.childNodes, element);
      const selection = window.getSelection();
      const snapshot = () => ({
        anchorInside: selection?.anchorNode ? element.contains(selection.anchorNode) : false,
        focusInside: selection?.focusNode ? element.contains(selection.focusNode) : false,
        anchorAt: selection?.anchorNode === parent ? selection.anchorOffset : null,
        focusAt: selection?.focusNode === parent ? selection.focusOffset : null,
      });

      selection?.setBaseAndExtent(leadingText, 1, tokenText, 1);
      document.dispatchEvent(new Event("selectionchange"));
      const forward = snapshot();
      selection?.setBaseAndExtent(trailingText, 1, tokenText, 1);
      document.dispatchEvent(new Event("selectionchange"));
      const reverse = snapshot();
      return { forward, reverse, tokenIndex };
    });

    expect(normalizedSelections.forward).toMatchObject({
      anchorInside: false,
      focusInside: false,
      focusAt: normalizedSelections.tokenIndex + 1,
    });
    expect(normalizedSelections.reverse).toMatchObject({
      anchorInside: false,
      focusInside: false,
      focusAt: normalizedSelections.tokenIndex,
    });

    await setTokenBoundary(token, "after");
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await readTokenSelection(token)).toMatchObject({
      anchor: "after",
      focus: "before",
      anchorInside: false,
      focusInside: false,
    });

    await setTokenBoundary(token, "before");
    await page.keyboard.press("Shift+ArrowRight");
    expect(await readTokenSelection(token)).toMatchObject({
      anchor: "before",
      focus: "after",
      anchorInside: false,
      focusInside: false,
    });
  }
});

test("chat composer keeps the caret in place while editing markdown-like text after references", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Reference-Mid-Draft-Caret");
  const agent = await createChatAgent(page, organization.id, "Caret Agent");

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Reference mid-draft caret",
      preferredAgentId: agent.id,
      initialMessage: { body: "Reference mid-draft caret seed" },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const canonicalReference = `[${agent.name}](agent://${agent.id})`;
  const canonicalSkillReference = "[visualize](skill://org/e2e-visualize?ref=visualize)";
  const draft = [
    `${canonicalReference} and ${canonicalReference} use ${canonicalSkillReference} to build a plan`,
    "",
    "Milestones:",
    "",
    "- Aug 28: Approval policy signed.",
    "- Sep 18: Evaluation gate.",
    "- Oct 2: Pilot readout.",
  ].join("\n");
  await composer.fill(draft);
  await expect(composer.locator("[data-mention-kind='agent']")).toHaveCount(2);
  await expect(composer.locator("[data-skill-token='true']")).toHaveCount(1);

  const initialSelectionOffset = await composer.evaluate((element) => {
    element.focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const offset = node.textContent?.indexOf("Sep 18") ?? -1;
      if (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        const prefix = document.createRange();
        prefix.setStart(element, 0);
        prefix.setEnd(node, offset);
        return prefix.toString().length;
      }
      node = walker.nextNode();
    }
    return -1;
  });
  expect(initialSelectionOffset).toBeGreaterThan(0);

  await page.keyboard.press("Backspace");
  await expect(composer).toContainText("-Sep 18: Evaluation gate.");

  const selectionOffsetAfterDelete = await composer.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !element.contains(selection.anchorNode)) return -1;
    const prefix = document.createRange();
    prefix.setStart(element, 0);
    prefix.setEnd(selection.anchorNode, selection.anchorOffset);
    return prefix.toString().length;
  });
  expect(selectionOffsetAfterDelete).toBe(initialSelectionOffset - 1);

  await page.keyboard.type("X");
  await expect(composer).toContainText("-XSep 18: Evaluation gate.");
  await expect(composer).not.toContainText(`X${agent.name}`);
});

test("chat composer keeps text after Rudder reference tokens when sending", async ({ page }) => {
  const organization = await createOrganization(page, "Chat-Reference-Tail");
  const agent = await createChatAgent(page, organization.id, "Mira");

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "Rudder Release",
      description: "Release planning context",
    },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string };

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Reference tail",
      preferredAgentId: agent.id,
      initialMessage: { body: "Reference tail seed" },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const projectReference = `[${project.name}](project://${project.id})`;
  const agentReference = `[${agent.name}](agent://${agent.id})`;
  const draft = `你需要结合 ${projectReference} 项目中的 issue 发版计划，优化一下 PRD roadmap，并让 ${agentReference} 继续跟进。`;
  await composer.fill(draft);

  await expect(composer).toContainText("你需要结合");
  await expect(composer.locator("[data-mention-kind='project']").filter({ hasText: project.name })).toBeVisible();
  await expect(composer.locator("[data-mention-kind='agent']").filter({ hasText: agent.name })).toBeVisible();
  await expect(composer).toContainText("项目中的 issue 发版计划，优化一下 PRD roadmap，并让");
  await expect(composer).toContainText("继续跟进。");

  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("你需要结合", { timeout: 15_000 });
  await expect(userBubble).toContainText(project.name);
  await expect(userBubble).toContainText("项目中的 issue 发版计划，优化一下 PRD roadmap，并让");
  await expect(userBubble).toContainText(agent.name);
  await expect(userBubble).toContainText("继续跟进。");

  const messagesRes = await page.request.get(`/api/chats/${chat.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const messages = await messagesRes.json() as Array<{ role: string; body: string }>;
  const userMessage = messages.filter((message) => message.role === "user").at(-1);
  expect(userMessage?.body).toBe(draft);
});
