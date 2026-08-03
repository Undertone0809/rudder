import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Global search results", () => {
  test("offers AI Search for an empty result and opens the model-selected chat", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `AI Search ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "AI Search Agent" });
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "AI Search architecture chat",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: {
          body: "Architecture decision notes for the runtime search flow.",
        },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.route(`**/api/orgs/${organization.id}/intelligence-profiles`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([null, {
          id: "profile-reasoning",
          orgId: organization.id,
          purpose: "reasoning",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { model: "gpt-5.4-mini" },
          status: "configured",
          lastError: null,
          lastVerifiedAt: "2026-06-18T00:00:00.000Z",
          createdAt: "2026-06-18T00:00:00.000Z",
          updatedAt: "2026-06-18T00:00:00.000Z",
        }]),
      });
    });

    let requestedQuery: string | null = null;
    await page.route(`**/api/orgs/${organization.id}/ai-search`, async (route) => {
      requestedQuery = (route.request().postDataJSON() as { query?: string }).query ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: requestedQuery,
          answer: "The architecture discussion is in the selected chat.",
          results: [{
            key: `chat:${chat.id}`,
            kind: "chat",
            id: chat.id,
            title: chat.title,
            preview: "Architecture decision notes",
            reason: "The chat contains the architecture discussion.",
            href: `/messenger/chat/${chat.id}`,
          }],
        }),
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("unindexed semantic concept");

    const aiSearch = page.getByRole("option", { name: /^AI Search$/i });
    await expect(aiSearch).toBeVisible({ timeout: 15_000 });
    await expect(aiSearch).not.toContainText("Search organization content");
    await aiSearch.click();

    await expect.poll(() => requestedQuery).toBe("unindexed semantic concept");
    await expect(page.getByText("The architecture discussion is in the selected chat.")).toBeVisible();
    const chatResult = page.getByRole("option", { name: /AI Search architecture chat/i });
    await expect(chatResult).toBeVisible();
    await chatResult.click();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
  });

  test("does not offer AI Search when Smart Model is disabled", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `AI Search Disabled ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.route(`**/api/orgs/${organization.id}/intelligence-profiles`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([null, {
          id: "profile-reasoning",
          orgId: organization.id,
          purpose: "reasoning",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { model: "gpt-5.4-mini" },
          status: "disabled",
        }]),
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await searchInput.fill("disabled model search token");
    await expect(page.getByRole("option", { name: /^AI Search$/i })).toHaveCount(0);
  });

  test("offers AI Search inside an Issues search scope", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Scoped AI Search ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Scoped AI Search issue match",
        description: "Returned by the scoped AI Search result.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.route(`**/api/orgs/${organization.id}/intelligence-profiles`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([null, {
          id: "profile-reasoning",
          orgId: organization.id,
          purpose: "reasoning",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { model: "gpt-5.4-mini" },
          status: "configured",
        }]),
      });
    });

    let requestedScope: string | null = null;
    await page.route(`**/api/orgs/${organization.id}/ai-search`, async (route) => {
      const body = route.request().postDataJSON() as { scope?: string };
      requestedScope = body.scope ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          query: "scope-only semantic token",
          answer: "The issue is the scoped AI Search match.",
          results: [{
            key: `issue:${issue.id}`,
            kind: "issue",
            id: issue.id,
            title: issue.title,
            preview: issue.description,
            reason: "The issue is in the selected scope.",
            href: `/issues/${issue.identifier ?? issue.id}`,
          }],
        }),
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    let searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await searchInput.fill("issues ");
    searchInput = page.getByPlaceholder("Search Issues...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("scope-only semantic token");

    const aiSearch = page.getByRole("option", { name: /^AI Search$/i });
    await expect(aiSearch).toBeVisible({ timeout: 15_000 });
    await aiSearch.click();
    await expect.poll(() => requestedScope).toBe("issue");
    await expect(page.getByText("The issue is the scoped AI Search match.")).toBeVisible();

    const issueResult = page.getByRole("option", { name: /Scoped AI Search issue match/i });
    await expect(issueResult).toBeVisible();
    await issueResult.click();
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));
  });

  test("shows an animated panel boundary while command palette search is loading", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Search Loading Ring ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    let releaseIssueSearch: (() => void) | null = null;
    const issueSearchStarted = new Promise<void>((resolve) => {
      page.route("**/api/orgs/*/issues**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("q") !== "rare-loading-ring-token") {
          await route.continue();
          return;
        }

        resolve();
        await new Promise<void>((release) => {
          releaseIssueSearch = release;
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-loading-ring-token");
    await issueSearchStarted;

    const commandPalette = page.locator('[data-slot="dialog-content"].command-palette-content');
    await expect(commandPalette).toHaveClass(/command-palette-content--searching/);
    await expect(page.getByText("Searching...")).toBeVisible();
    await expect.poll(async () => commandPalette.evaluate((element) => {
      const styles = window.getComputedStyle(element, "::before");
      return {
        animationName: styles.animationName,
        backgroundImage: styles.backgroundImage,
      };
    })).toMatchObject({
      animationName: "command-palette-search-ring",
    });

    releaseIssueSearch?.();
    await expect(commandPalette).not.toHaveClass(/command-palette-content--searching/, { timeout: 15_000 });
  });

  test("finds a chat by message body and opens the conversation", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Search Chats ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    await createE2EChatAgent(page.request, organization.id, { name: "Search Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Messenger search target",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Need to preserve the rare-chat-search-token in global search.",
      structuredPayload: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-chat-search-token");

    const chatResult = page.getByRole("option", { name: /Messenger search target/i });
    await expect(chatResult).toBeVisible({ timeout: 15_000 });
    await expect(chatResult).toContainText("rare-chat-search-token");
    await chatResult.click();

    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
  });

  test("finds an issue by description text from the command palette", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Search Issues ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const doneIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Done global search target",
        description: "Only this description contains rare-issue-description-token.",
        status: "done",
        priority: "medium",
      },
    });
    expect(doneIssueRes.ok()).toBe(true);
    const doneIssue = await doneIssueRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Global search status verifier",
        role: "engineer",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const progressIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "In-progress global search target",
        description: "Only this description contains rare-issue-description-token.",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agent.id,
      },
    });
    expect(progressIssueRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-issue-description-token");

    const doneResult = page.getByRole("option", { name: /Done global search target/i });
    const progressResult = page.getByRole("option", { name: /In-progress global search target/i });
    await expect(doneResult).toBeVisible({ timeout: 15_000 });
    await expect(progressResult).toBeVisible({ timeout: 15_000 });

    const doneIcon = doneResult.locator('[data-slot="issue-status-icon"][data-status="done"]');
    const progressIcon = progressResult.locator('[data-slot="issue-status-icon"][data-status="in_progress"]');
    await expect(doneIcon).toHaveClass(/text-green-600/);
    await expect(progressIcon).toHaveClass(/text-yellow-600/);

    const doneColor = await doneIcon.evaluate((element) => getComputedStyle(element).color);
    const doneGlyphColor = await doneIcon.locator("svg").evaluate((element) => getComputedStyle(element).color);
    const progressColor = await progressIcon.evaluate((element) => getComputedStyle(element).color);
    const progressGlyphColor = await progressIcon.locator("svg").evaluate((element) => getComputedStyle(element).color);
    expect(doneGlyphColor).toBe(doneColor);
    expect(progressGlyphColor).toBe(progressColor);
    expect(doneGlyphColor).not.toBe(progressGlyphColor);

    await expect(doneResult.locator(".lucide-circle-dot")).toHaveCount(0);
    await doneResult.click();

    await expect(page).toHaveURL(new RegExp(`/issues/${doneIssue.identifier ?? doneIssue.id}$`));
  });

  test("finds an organization skill and opens the skill detail", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Search Skills ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "development-lifecycle-router-maintainer",
        slug: "development-lifecycle-router-maintainer",
        description: "Route Rudder development work through lifecycle stages.",
        markdown: [
          "---",
          "name: development-lifecycle-router-maintainer",
          "description: Route Rudder development work through lifecycle stages.",
          "---",
          "",
          "# Development Lifecycle Router Maintainer",
        ].join("\n"),
      },
    });
    expect(skillRes.ok()).toBe(true);
    const skill = await skillRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    const searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("lifecycle-router");

    const skillResult = page.getByRole("option", { name: /development-lifecycle-router-maintainer/i });
    await expect(skillResult).toBeVisible({ timeout: 15_000 });
    await expect(skillResult).toContainText("Route Rudder development work through lifecycle stages.");
    await skillResult.click();

    await expect(page).toHaveURL(
      new RegExp(
        `/${organization.issuePrefix}/library\\?(?:skill=${skill.id}&skillFile=SKILL\\.md|path=skills%2Fdevelopment-lifecycle-router-maintainer%2FSKILL\\.md)$`,
      ),
    );
    await expect(page.getByRole("heading", { name: "Development Lifecycle Router Maintainer" })).toBeVisible();
  });

  test("scopes search to issues and opens the selected issue", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Scoped Issues ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    await createE2EChatAgent(page.request, organization.id, { name: "Scoped Search Agent" });

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Scoped issue search target",
        description: "Only this issue should appear for rare-scoped-issue-token.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Scoped chat decoy",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "This chat also contains rare-scoped-issue-token but should not show in issue scope.",
      structuredPayload: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    let searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("iss");
    await expect(page.getByRole("option", { name: /Search in Issues/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...")).toBeVisible();

    await searchInput.fill("issue ");
    searchInput = page.getByPlaceholder("Search Issues...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("rare-scoped-issue-token");

    const issueResult = page.getByRole("option", { name: /Scoped issue search target/i });
    await expect(issueResult).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: /Scoped chat decoy/i })).toHaveCount(0);
    await issueResult.click();

    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));
  });

  test("scopes search to Library and exits scope from an empty query", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Scoped Library ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const filePath = `docs/scoped-library-${Date.now()}.md`;
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath,
        content: "# Scoped Library\n\nrare-scoped-library-token lives in the filename boundary test.",
      },
    });
    expect(fileRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("primary-rail").getByRole("button", { name: "Search" }).click();
    let searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("library ");

    searchInput = page.getByPlaceholder("Search Library...");
    await expect(searchInput).toBeVisible();
    await expect(page.getByText("Type to search Library")).toBeVisible();

    await searchInput.press("Backspace");
    searchInput = page.getByPlaceholder("Search issues, chats, agents, projects, skills, library...");
    await expect(searchInput).toBeVisible();

    await searchInput.fill("library ");
    searchInput = page.getByPlaceholder("Search Library...");
    await searchInput.fill("scoped-library");

    const libraryResult = page.getByRole("option", { name: new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(libraryResult).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: /Scoped issue search target/i })).toHaveCount(0);
    await libraryResult.click();

    await expect(page).toHaveURL(new RegExp(`/library\\?path=${encodeURIComponent(filePath)}$`));
  });
});
