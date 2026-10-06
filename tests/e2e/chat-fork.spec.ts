import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agents,
  chatConversations,
  chatMessages,
  chatMessageTranscriptEntries,
  createDb,
  heartbeatRuns,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
  runtimeSourceAliases,
} from "../../packages/db/src/index.ts";
import { MESSENGER_FORK_GROUP_DEFAULT_ICON } from "../../packages/shared/src/index.ts";
import { resolveDefaultAgentWorkspaceDir } from "../../server/src/home-paths.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL, E2E_HOME, E2E_INSTANCE_ID, E2E_ROOT } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

// Read-only SessionDB stand-in for historical Hermes Reader coverage. It has
// no Hermes package, provider, or authentication dependency.
const HERMES_HISTORY_SESSION_DB = String.raw`
import json
from pathlib import Path

class SessionDB:
    def __init__(self, db_path=None, read_only=False):
        if not read_only:
            raise AssertionError("history reader must open SessionDB read-only")
        self.state = json.loads(Path(db_path).read_text(encoding="utf-8"))

    def _read_ctx(self):
        import sqlite3
        from contextlib import contextmanager
        @contextmanager
        def context():
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            sessions = list(self.state.get("sessions", {}).values())
            messages = [row for rows in self.state.get("messages", {}).values() for row in rows]
            for table, rows, required in [
                ("sessions", sessions, ["id", "source", "parent_session_id", "profile_name", "cwd", "started_at", "ended_at", "end_reason", "message_count", "tool_call_count"]),
                ("messages", messages, ["id", "session_id", "role", "content"]),
            ]:
                columns = list(dict.fromkeys(required + [key for row in rows for key in row]))
                conn.execute("CREATE TABLE " + table + " (" + ",".join('"' + col + '"' for col in columns) + ")")
                for row in rows:
                    values = [json.dumps(row.get(col), ensure_ascii=False) if isinstance(row.get(col), (dict, list)) else row.get(col) for col in columns]
                    conn.execute("INSERT INTO " + table + " VALUES (" + ",".join("?" for _ in columns) + ")", values)
            conn.commit()
            try:
                yield conn
            finally:
                conn.close()
        return context()

    def _row_to_message_dict(self, row, **kwargs):
        result = dict(row)
        for key in ["content", "tool_calls", "display_metadata"]:
            if isinstance(result.get(key), str):
                try:
                    result[key] = json.loads(result[key])
                except ValueError:
                    pass
        return result

    def get_session(self, session_id):
        return self.state.get("sessions", {}).get(session_id)

    def get_messages(self, session_id, include_inactive=False, include_compacted=False,
                     limit=None, offset=0, latest=False, after_id=None):
        rows = list(self.state.get("messages", {}).get(session_id, []))
        if not include_inactive:
            rows = [row for row in rows if row.get("active", 1) == 1]
        if after_id is not None:
            rows = [row for row in rows if row["id"] > after_id]
        if latest:
            rows.reverse()
        if limit is not None:
            rows = rows[offset:offset + limit]
        if latest:
            rows.reverse()
        return rows

    def get_compression_tip(self, session_id):
        return self.state.get("tips", {}).get(session_id, session_id)

    def resolve_resume_session_id(self, session_id):
        return self.state.get("resume", {}).get(session_id, session_id)

    def close(self):
        return None
`;

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string; urlKey: string }>;
}

async function configureFastTitleProfile(page: Page, orgId: string, title: string) {
  const profileRes = await page.request.put(`/api/orgs/${orgId}/intelligence-profiles/lightweight`, {
    data: {
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: "node",
        args: ["-e", `process.stdout.write(${JSON.stringify(title)})`],
      },
      status: "configured",
    },
  });
  expect(profileRes.ok()).toBe(true);
}

function threadTestId(threadKey: string) {
  return `messenger-thread-${threadKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function expectMessageInScrollViewport(page: Page, messageId: string) {
  const isVisibleInScrollViewport = await page.evaluate((targetMessageId) => {
    const scrollRegion = document.querySelector<HTMLElement>('[data-testid="chat-messages-scroll-region"]');
    const message = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === targetMessageId);
    if (!scrollRegion || !message) return false;

    const containerBox = scrollRegion.getBoundingClientRect();
    const messageBox = message.getBoundingClientRect();
    const containerCenter = containerBox.top + containerBox.height / 2;
    const messageCenter = messageBox.top + messageBox.height / 2;
    const intersects = messageBox.bottom > containerBox.top && messageBox.top < containerBox.bottom;
    return intersects && Math.abs(messageCenter - containerCenter) < containerBox.height * 0.35;
  }, messageId);
  expect(isVisibleInScrollViewport).toBe(true);
}

async function expectMessageJumpHighlightStylesTargetBlock(page: Page, messageId: string) {
  const highlightStyle = await page.evaluate((targetMessageId) => {
    const message = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === targetMessageId);
    const target = message?.querySelector<HTMLElement>("[data-message-highlight-target='true']") ?? message;
    if (!target) return null;
    const highlight = window.getComputedStyle(target);
    const pseudo = window.getComputedStyle(target, "::before");
    const radiusProbe = document.createElement("div");
    radiusProbe.style.borderRadius = "var(--radius-lg)";
    document.body.append(radiusProbe);
    const expectedBorderRadius = window.getComputedStyle(radiusProbe).borderRadius;
    radiusProbe.remove();
    return {
      backgroundColor: highlight.backgroundColor,
      borderRadius: highlight.borderRadius,
      borderStyle: highlight.borderStyle,
      borderWidth: highlight.borderTopWidth,
      boxShadow: highlight.boxShadow,
      expectedBorderRadius,
      pseudoContent: pseudo.content,
    };
  }, messageId);

  expect(highlightStyle).not.toBeNull();
  expect(highlightStyle?.borderRadius).toBe(highlightStyle?.expectedBorderRadius);
  expect(highlightStyle?.borderStyle).toBe("solid");
  expect(highlightStyle?.borderWidth).toBe("1px");
  expect(highlightStyle?.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(highlightStyle?.boxShadow).not.toBe("none");
  expect(highlightStyle?.pseudoContent).toBe("none");
}

async function seedForkableChatSource(page: Page, input: {
  orgId: string;
  title: string;
  agentName: string;
  userBody: string;
  assistantBody: string;
}) {
  const agent = await createE2EChatAgent(page.request, input.orgId, {
    name: input.agentName,
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const sourceConversationId = randomUUID();
  const sourceMessageIds = [randomUUID(), randomUUID()];
  await e2eDb.insert(chatConversations).values({
    id: sourceConversationId,
    orgId: input.orgId,
    title: input.title,
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-06-22T10:02:00.000Z"),
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    updatedAt: new Date("2026-06-22T10:02:00.000Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageIds[0],
      orgId: input.orgId,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: input.userBody,
      createdAt: new Date("2026-06-22T10:01:00.000Z"),
      updatedAt: new Date("2026-06-22T10:01:00.000Z"),
    },
    {
      id: sourceMessageIds[1],
      orgId: input.orgId,
      conversationId: sourceConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: input.assistantBody,
      replyingAgentId: agent.id,
      createdAt: new Date("2026-06-22T10:02:00.000Z"),
      updatedAt: new Date("2026-06-22T10:02:00.000Z"),
    },
  ]);
  return { sourceConversationId, sourceMessageIds };
}

async function openOrganizationChat(page: Page, organization: { id: string; issuePrefix: string; urlKey: string }, conversationId: string) {
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat/${conversationId}`);
}

async function forkFromAssistantMessage(page: Page, conversationId: string, messageId: string) {
  const sourceAssistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${messageId}"]`);
  await expect(sourceAssistant).toBeVisible({ timeout: 15_000 });
  await sourceAssistant.hover();
  await expect(sourceAssistant.getByRole("button", { name: "Copy message" })).toBeVisible();
  await expect(sourceAssistant.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
  await sourceAssistant.getByRole("button", { name: "More message actions" }).filter({ visible: true }).click();
  await expect(page.getByTestId("chat-fork-more-action")).toBeVisible();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${conversationId}/fork`),
  );
  await page.getByTestId("chat-fork-more-action").click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const forkedConversation = await forkResponse.json() as { id: string };
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`));
  return forkedConversation;
}

async function sendFirstForkMessage(page: Page, message: string) {
  const composer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await page.keyboard.insertText(message);
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled({ timeout: 15_000 });
  await sendButton.click();
}

async function expectChatTitle(page: Page, chatId: string, title: string) {
  await expect.poll(async () => {
    const chatRes = await page.request.get(`/api/chats/${chatId}`);
    expect(chatRes.ok()).toBe(true);
    return (await chatRes.json() as { title: string }).title;
  }, {
    timeout: 20_000,
  }).toBe(title);
  await expect(page.getByTestId(threadTestId(`chat:${chatId}`))).toContainText(title, { timeout: 15_000 });
}

test("forks a chat from a selected message and groups the fork family in Messenger", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Fork-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

  const sourceConversationId = randomUUID();
  const sourceMessageIds = [randomUUID(), randomUUID(), randomUUID()];
  const agentId = randomUUID();
  await e2eDb.insert(agents).values({
    id: agentId,
    orgId: organization.id,
    name: "Autumn",
    role: "operator_assistant",
    icon: "notionists-neutral",
    status: "idle",
  });
  await e2eDb.insert(chatConversations).values({
    id: sourceConversationId,
    orgId: organization.id,
    title: "Forkable strategy chat",
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-06-22T08:03:00.000Z"),
    createdAt: new Date("2026-06-22T08:00:00.000Z"),
    updatedAt: new Date("2026-06-22T08:03:00.000Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageIds[0],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Original premise",
      createdAt: new Date("2026-06-22T08:01:00.000Z"),
      updatedAt: new Date("2026-06-22T08:01:00.000Z"),
    },
    {
      id: sourceMessageIds[1],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Middle branch point",
      structuredPayload: {
        __chatTranscript: [{
          kind: "thinking",
          ts: "2026-06-22T08:02:00.500Z",
          text: "Fork must retain this transcript",
        }],
      },
      replyingAgentId: agentId,
      createdAt: new Date("2026-06-22T08:02:00.000Z"),
      updatedAt: new Date("2026-06-22T08:02:00.000Z"),
    },
    {
      id: sourceMessageIds[2],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Later context that should stay out",
      createdAt: new Date("2026-06-22T08:03:00.000Z"),
      updatedAt: new Date("2026-06-22T08:03:00.000Z"),
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat/${sourceConversationId}`);

  const sourceUser = page.locator(`[data-testid="chat-user-message"][data-message-id="${sourceMessageIds[0]}"]`);
  await expect(sourceUser).toContainText("Original premise", { timeout: 15_000 });
  await sourceUser.hover();
  await expect(sourceUser.getByRole("button", { name: "Fork from here" })).toHaveCount(0);

  const sourceAssistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${sourceMessageIds[1]}"]`);
  await expect(sourceAssistant).toContainText("Middle branch point", { timeout: 15_000 });
  await sourceAssistant.hover();
  await expect(sourceAssistant.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
  await sourceAssistant.getByRole("button", { name: "More message actions" }).filter({ visible: true }).click();
  await expect(page.getByTestId("chat-fork-more-action")).toBeVisible();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/fork`),
  );
  await page.getByTestId("chat-fork-more-action").click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const forkedConversation = await forkResponse.json() as {
    id: string;
    title: string;
    lastMessageAt: string | null;
    forkedFromConversationId: string | null;
    forkedFromMessageId: string | null;
    forkRootConversationId: string | null;
  };

  expect(forkedConversation.title).toBe("Forkable strategy chat (2)");
  expect(forkedConversation.forkedFromConversationId).toBe(sourceConversationId);
  expect(forkedConversation.forkedFromMessageId).toBe(sourceMessageIds[1]);
  expect(forkedConversation.forkRootConversationId).toBe(sourceConversationId);
  expect(Date.parse(forkedConversation.lastMessageAt ?? "")).toBeGreaterThan(Date.parse("2026-06-22T08:03:00.000Z"));
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`));
  await expect(page.getByTestId("chat-messages-content")).toContainText("Original premise");
  await expect(page.getByTestId("chat-messages-content")).toContainText("Middle branch point");
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Middle branch point" })).toContainText("Autumn");
  await expect(page.getByTestId("chat-messages-content")).not.toContainText("Later context that should stay out");

  const messagesRes = await page.request.get(`/api/chats/${forkedConversation.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const forkMessages = await messagesRes.json() as Array<{ id: string; role: string; body: string; structuredPayload: Record<string, unknown> | null }>;
  expect(forkMessages.map((message) => message.body).slice(0, 2)).toEqual([
    "Original premise",
    "Middle branch point",
  ]);
  expect(forkMessages[2]?.body).toContain("[Forkable strategy chat]");
  expect(forkMessages[2]?.body).toContain("at message.");
  expect(forkMessages[2]?.body).not.toContain(sourceMessageIds[1]!);
  expect(forkMessages[2]?.structuredPayload).toMatchObject({
    eventType: "chat_fork",
    sourceConversationId,
    sourceConversationTitle: "Forkable strategy chat",
    sourceMessageId: sourceMessageIds[1],
  });

  const forkAssistant = forkMessages.find((message) => message.body === "Middle branch point");
  expect(forkAssistant).toBeTruthy();
  const forkTranscriptResponse = await page.request.get(
    `/api/chats/${forkedConversation.id}/messages/${forkAssistant.id}/transcript`,
  );
  expect(forkTranscriptResponse.ok()).toBe(true);
  expect(await forkTranscriptResponse.json()).toMatchObject({
    transcript: [{ text: "Fork must retain this transcript" }],
  });

  const sourceMessageLink = page.getByRole("link", { name: "Open source message" });
  await expect(sourceMessageLink).toHaveText("message");
  await sourceMessageLink.click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${sourceConversationId}`));
  await expect(sourceAssistant).toContainText("Middle branch point");
  await expect(sourceAssistant.locator("[data-message-highlight-target='true']")).toHaveClass(/chat-message-jump-highlight/);
  await expectMessageInScrollViewport(page, sourceMessageIds[1]!);
  await expectMessageJumpHighlightStylesTargetBlock(page, sourceMessageIds[1]!);
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/messenger/chat/${sourceConversationId}$`));

  await page.goto(`/${organization.urlKey}/messenger`);
  await expect(page.getByTestId(threadTestId(`chat:${sourceConversationId}`))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(threadTestId(`chat:${forkedConversation.id}`))).toBeVisible({ timeout: 15_000 });

  const groups = await e2eDb
    .select()
    .from(messengerCustomGroups)
    .where(eq(messengerCustomGroups.orgId, organization.id));
  expect(groups).toHaveLength(1);
  expect(groups[0]?.name).toContain("Forkable strategy chat");
  expect(groups[0]?.icon).toBe(MESSENGER_FORK_GROUP_DEFAULT_ICON);
  await expect(page.getByTestId(`messenger-thread-section-custom-group-${groups[0]!.id}`)).toContainText(MESSENGER_FORK_GROUP_DEFAULT_ICON);
  const groupEntries = await e2eDb
    .select()
    .from(messengerCustomGroupEntries)
    .where(eq(messengerCustomGroupEntries.groupId, groups[0]!.id));
  expect(new Set(groupEntries.map((entry) => entry.threadKey))).toEqual(new Set([
    `chat:${forkedConversation.id}`,
    `chat:${sourceConversationId}`,
  ]));

  const deleteSourceResponse = await page.request.delete(`/api/chats/${sourceConversationId}`);
  expect(deleteSourceResponse.ok()).toBe(true);
  const transcriptAfterSourceDelete = await page.request.get(
    `/api/chats/${forkedConversation.id}/messages/${forkAssistant.id}/transcript`,
  );
  expect(transcriptAfterSourceDelete.ok()).toBe(true);
  expect(await transcriptAfterSourceDelete.json()).toMatchObject({
    transcript: [{ text: "Fork must retain this transcript" }],
  });
  await page.goto(`/${organization.urlKey}/messenger/chat/${forkedConversation.id}`);
  await expect(page.getByTestId("chat-messages-content")).toContainText("Middle branch point");
  await page.screenshot({ path: testInfo.outputPath("fork-history-after-source-delete.png"), fullPage: true });
});

test("ordinary Main native fork keeps exact alias history and its child session after source deletion", async ({ page }, testInfo) => {
  const organization = await createOrganization(page, `Main native fork ${randomUUID()}`);
  const agent = await createE2EChatAgent(page.request, organization.id, {
    command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
  });
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agent.id}`);
  const send = async (prompt: string, reply: string) => {
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill(prompt);
    const stream = page.waitForResponse((response) => response.request().method() === "POST"
      && response.url().endsWith("/messages/stream"));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const streamResponse = await stream;
    expect(streamResponse.status()).toBe(201);
    await streamResponse.finished();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(reply, { timeout: 30_000 });
  };
  const sourceUrl = "https://native-fork-source.example/research";
  await send(`Native parent input ${sourceUrl}`, "Native reply 1");
  const parentId = new URL(page.url()).pathname.split("/").at(-1)!;
  const [parentRun] = await e2eDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, parentId));
  const sourceMessageId = await page.getByTestId("chat-assistant-message").last().getAttribute("data-message-id");
  expect(sourceMessageId).toBeTruthy();
  const child = await forkFromAssistantMessage(page, parentId, sourceMessageId!);
  const [alias] = await e2eDb.select().from(runtimeSourceAliases).where(eq(runtimeSourceAliases.conversationId, child.id));
  expect(alias).toMatchObject({ runId: parentRun.id, readOnly: true, sourceKind: "chat_fork_native_span" });
  const copiedMessageId = String(alias.sourceRangeJson.targetCopiedMessageId);
  const [copiedMessage] = await e2eDb.select().from(chatMessages).where(eq(chatMessages.id, copiedMessageId));
  expect(copiedMessage.runId).toBeNull();
  expect(await e2eDb.select().from(chatMessageTranscriptEntries).where(eq(chatMessageTranscriptEntries.messageId, copiedMessageId))).toEqual([]);
  const historyBefore = await page.request.get(`/api/chats/${child.id}/messages/${copiedMessageId}/transcript`);
  expect(historyBefore.ok()).toBe(true);
  const history = await historyBefore.json();
  expect(history.transcript.length).toBeGreaterThan(0);
  // Exercise the retained-source admission edge, not only an already admitted child.
  const deletion = await page.request.delete(`/api/chats/${parentId}`);
  expect(deletion.ok()).toBe(true);
  const manifestPath = `/api/chats/${child.id}/work-manifest`;
  const initialManifest = page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).pathname === manifestPath);
  await page.reload();
  expect([200, 304]).toContain((await initialManifest).status());
  const manifestResponses: Response[] = [];
  const sendManifestRequests = new Set<Request>();
  let childSendStarted = false;
  const captureRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === `/api/chats/${child.id}/messages/stream`) childSendStarted = true;
    if (childSendStarted && request.method() === "GET" && pathname === manifestPath) sendManifestRequests.add(request);
  };
  const captureManifest = (response: Response) => {
    if (sendManifestRequests.has(response.request())) {
      manifestResponses.push(response);
    }
  };
  page.on("request", captureRequest);
  page.on("response", captureManifest);
  await send("Native child first input", "Native reply 2");
  await expect.poll(() => manifestResponses.length, { timeout: 5_000 }).toBeGreaterThan(0);
  // Include the next query retry in the first-send observation window.
  await page.waitForTimeout(1_250);
  page.off("request", captureRequest);
  page.off("response", captureManifest);
  expect(manifestResponses.length).toBeGreaterThan(0);
  for (const response of manifestResponses) {
    // Browser revalidation may legitimately reuse a 304 cached manifest.
    expect([200, 304, 409]).toContain(response.status());
    if (response.status() === 409) {
      expect(await response.json()).toMatchObject({ details: { code: "work_manifest_revision_changed" } });
    }
  }
  let terminalManifest: { conversationId: string; sources: unknown[]; subagents: unknown } | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await page.request.get(manifestPath);
    if (response.status() === 200) {
      terminalManifest = await response.json();
      break;
    }
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ details: { code: "work_manifest_revision_changed" } });
    if (attempt < 3) await page.waitForTimeout(200 * (attempt + 1));
  }
  expect(terminalManifest).toMatchObject({ conversationId: child.id, subagents: { active: [], done: [], totalCount: 0 } });
  expect(terminalManifest?.sources).toContainEqual(expect.objectContaining({
    targetKey: `url:${sourceUrl}`, targetType: "external_url", url: sourceUrl, sourceRole: "user",
  }));
  const [childRun] = await e2eDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, child.id));
  expect(childRun.status).toBe("succeeded");
  expect(childRun.sessionIdAfter).toBeTruthy();
  expect(childRun.sessionIdAfter).not.toBe(parentRun.sessionIdAfter);
  const [childSpan] = await e2eDb.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, childRun.id));
  expect(childSpan).toMatchObject({ state: "sealed", completeness: "complete" });
  expect(childSpan.selectorJson).toMatchObject({ kind: "codex_turn", threadId: childRun.sessionIdAfter });
  await page.reload();
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Native reply 2" }).last())
    .toBeVisible({ timeout: 15_000 });
  const persistedMessages = await e2eDb.select().from(chatMessages).where(eq(chatMessages.conversationId, child.id));
  expect(persistedMessages).toContainEqual(expect.objectContaining({
    role: "assistant", status: "completed", body: "Native reply 2", runId: childRun.id,
  }));
  const historyAfter = await page.request.get(`/api/chats/${child.id}/messages/${copiedMessageId}/transcript`);
  expect(historyAfter.ok()).toBe(true);
  expect((await historyAfter.json()).transcript).toEqual(history.transcript);
  await send("Native child continues after parent deletion", "Native reply 3");
  const childRuns = await e2eDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, child.id));
  expect(childRuns).toHaveLength(2);
  expect(childRuns.every((run) => run.status === "succeeded" && run.sessionIdAfter === childRun.sessionIdAfter)).toBe(true);
  expect(await e2eDb.select().from(chatMessageTranscriptEntries).where(eq(chatMessageTranscriptEntries.orgId, organization.id))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("native-main-fork-after-source-delete.png"), fullPage: true });
});

test("forks Hermes historical Reader history from the managed agent workspace key", async ({ page }) => {
  test.setTimeout(120_000);
  const pythonCommand = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-hermes-history-fork-"));
  try {
    const sourcePath = path.join(fixtureRoot, "source");
    const hermesHome = path.join(fixtureRoot, "home");
    const sessionId = `hermes-e2e-${randomUUID()}`;
    const providerExecutionRef = `execution-${randomUUID()}`;
    await fs.mkdir(sourcePath);
    await fs.mkdir(hermesHome);
    await fs.writeFile(path.join(sourcePath, "hermes_state.py"), HERMES_HISTORY_SESSION_DB, "utf8");
    const hermesState = {
      sessions: {
        [sessionId]: {
          id: sessionId,
          source: "acp",
          parent_session_id: null,
          profile_name: "rudder-e2e",
          cwd: "/historical/hermes/workspace",
          started_at: 1,
          ended_at: 3,
          end_reason: null,
          message_count: 2,
          tool_call_count: 0,
        },
      },
      messages: {
        [sessionId]: [
          { id: 1, session_id: sessionId, role: "user", content: "Hermes historical question", timestamp: 2, active: 1, compacted: 0 },
          { id: 2, session_id: sessionId, role: "assistant", content: "Hermes historical answer", timestamp: 3, active: 1, compacted: 0, finish_reason: "stop" },
        ],
      },
    };
    const hermesStatePath = path.join(hermesHome, "state.db");
    await fs.writeFile(hermesStatePath, JSON.stringify(hermesState), "utf8");

    const organization = await createOrganization(page, `Hermes historical Fork ${randomUUID()}`);
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Hermes historical Fork Agent" }) as { id: string };
    const workspaceKey = `hermes-history-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const managedCwd = (() => {
      const previousRudderHome = process.env.RUDDER_HOME;
      const previousRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
      process.env.RUDDER_HOME = E2E_HOME;
      process.env.RUDDER_INSTANCE_ID = E2E_INSTANCE_ID;
      try {
        return resolveDefaultAgentWorkspaceDir(organization.id, workspaceKey);
      } finally {
        if (previousRudderHome === undefined) delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = previousRudderHome;
        if (previousRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
        else process.env.RUDDER_INSTANCE_ID = previousRudderInstanceId;
      }
    })();
    const profileHostId = `e2e-host-${randomUUID()}`;
    const profileId = `e2e-profile-${randomUUID()}`;
    const capabilityRevision = "hermes-history-fixture-v1";
    const conversationId = randomUUID();
    const runId = randomUUID();
    const bindingId = randomUUID();
    const segmentId = randomUUID();
    const spanId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const sourceRangeRef = JSON.stringify({ version: 1, status: "exact", sessionId, startExclusive: 0, endInclusive: 2 });
    const selectorJson = {
      kind: "hermes_execution",
      sessionRef: sessionId,
      providerExecutionRef,
      sourceRangeRef,
      boundaryStatus: "exact",
    };
    const sessionParams = {
      sessionId,
      sessionDisplayId: sessionId,
      hermesSessionId: sessionId,
      transport: "hermes-tui-gateway-stdio",
      hermesProviderVersion: "0.21.0",
      hermesPythonCommand: pythonCommand,
      hermesSourcePath: sourcePath,
      hermesHome,
      profileHostId,
      profileId,
      profileBindingId: bindingId,
      profileOrgId: organization.id,
      capabilityRevision,
      cwd: managedCwd,
      workspaceBindingId: managedCwd,
    };
    const runtimeProviderProfile = {
      runtimeType: "hermes_gateway",
      cwd: "/historical/hermes/source-checkout",
      providerVersion: "0.21.0",
      hermesPythonCommand: pythonCommand,
      hermesSourcePath: sourcePath,
      hermesHome,
    };
    const createdAt = new Date("2026-10-01T10:00:00.000Z");
    const spanOpenedAt = new Date("2026-10-01T10:01:00.000Z");
    const spanClosedAt = new Date("2026-10-01T10:02:00.000Z");

    await e2eDb.update(agents).set({
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: {
        hermesPythonCommand: pythonCommand,
        hermesSourcePath: sourcePath,
        hermesHome,
        providerVersion: "0.21.0",
      },
      workspaceKey,
    }).where(eq(agents.id, agent.id));
    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Hermes historical source",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "local-board",
      createdAt,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
    });
    await e2eDb.insert(runtimeBindings).values({
      id: bindingId,
      orgId: organization.id,
      conversationId,
      principalScopeRef: `org:${organization.id}`,
      agentId: agent.id,
      runtimeType: "hermes_gateway",
      hostId: profileHostId,
      profileId,
      workspaceBindingId: managedCwd,
      capabilityRevision,
      continuity: "native",
      currentSegmentId: null,
      status: "active",
    });
    await e2eDb.insert(nativeSegments).values({
      id: segmentId,
      orgId: organization.id,
      bindingId,
      runtimeType: "hermes_gateway",
      segmentOrdinal: 0,
      nativeSessionId: sessionId,
      rootSessionId: sessionId,
      providerStateJson: sessionParams,
      state: "open",
      sealedAt: null,
      createdAt: spanOpenedAt,
      updatedAt: spanOpenedAt,
    });
    await e2eDb.update(runtimeBindings).set({ currentSegmentId: segmentId }).where(eq(runtimeBindings.id, bindingId));
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "on_demand",
      status: "succeeded",
      startedAt: spanOpenedAt,
      finishedAt: spanClosedAt,
      exitCode: 0,
      sessionIdBefore: sessionId,
      sessionIdAfter: sessionId,
      sessionParamsBeforeJson: sessionParams,
      sessionParamsAfterJson: sessionParams,
      sessionReuseScope: "explicit",
      chatConversationId: conversationId,
      contextSnapshot: {
        transcriptSource: "native",
        agentRuntimeType: "hermes_gateway",
        runtimeBindingId: bindingId,
        runtimeProviderProfile,
      },
      createdAt,
      updatedAt: spanClosedAt,
    });
    const [persistedAgent] = await e2eDb.select().from(agents).where(eq(agents.id, agent.id));
    const [persistedRun] = await e2eDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persistedAgent?.workspaceKey).toBe(workspaceKey);
    expect(persistedRun?.contextSnapshot).not.toHaveProperty("rudderWorkspace");
    await e2eDb.insert(runRuntimeSpans).values({
      id: spanId,
      orgId: organization.id,
      runId,
      bindingId,
      segmentId,
      attemptRef: `attempt-${runId}`,
      ownerToken: `owner-${runId}`,
      ordinal: 0,
      selectorJson,
      state: "sealed",
      completeness: "complete",
      writerLeaseReleasedAt: spanClosedAt,
      openedAt: spanOpenedAt,
      closedAt: spanClosedAt,
      updatedAt: spanClosedAt,
    });
    await e2eDb.insert(chatMessages).values([
      {
        id: userMessageId,
        orgId: organization.id,
        conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Hermes historical question",
        createdAt: spanOpenedAt,
        updatedAt: spanOpenedAt,
      },
      {
        id: assistantMessageId,
        orgId: organization.id,
        conversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Hermes historical answer",
        replyingAgentId: agent.id,
        runId,
        createdAt: spanClosedAt,
        updatedAt: spanClosedAt,
      },
    ]);

    const runHistoryResponse = await page.request.get(
      `/api/run-intelligence/runs/${runId}/transcript?output=full&order=oldest&turnLimit=50&includeOutput=false&maxChars=4000`,
    );
    expect(runHistoryResponse.ok(), await runHistoryResponse.text()).toBe(true);
    const runHistory = await runHistoryResponse.json() as {
      source: string;
      availability: string;
      completeness: string;
      entries?: Array<{ entry?: { kind?: string; text?: string } }>;
    };
    expect(runHistory, JSON.stringify(runHistory)).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(runHistory.entries?.map(({ entry }) => [entry?.kind, entry?.text])).toEqual([
      ["user", "Hermes historical question"],
      ["assistant", "Hermes historical answer"],
    ]);

    const forkResponse = await page.request.post(`/api/chats/${conversationId}/fork`, {
      data: { sourceMessageId: assistantMessageId },
    });
    expect(forkResponse.status(), await forkResponse.text()).toBe(201);
    const child = await forkResponse.json() as { id: string };
    const [alias] = await e2eDb.select().from(runtimeSourceAliases).where(eq(runtimeSourceAliases.conversationId, child.id));
    expect(alias).toMatchObject({
      runId,
      bindingId,
      segmentId,
      sourceKind: "chat_fork_native_span",
      readOnly: true,
      sourceRangeJson: {
        sourceRunId: runId,
        sourceSpanId: spanId,
        sourceConversationId: conversationId,
        sourceMessageId: assistantMessageId,
        targetCopiedMessageId: expect.any(String),
        selectorJson,
      },
    });
    expect(alias?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    const copiedMessageId = String(alias?.sourceRangeJson.targetCopiedMessageId);
    const resolvedHistoryResponse = await page.request.get(
      `/api/chats/${child.id}/messages/${copiedMessageId}/transcript`,
    );
    expect(resolvedHistoryResponse.ok(), await resolvedHistoryResponse.text()).toBe(true);

    await e2eDb.update(runRuntimeSpans).set({ completeness: "partial" }).where(eq(runRuntimeSpans.id, spanId));
    const incompleteResponse = await page.request.get(
      `/api/chats/${child.id}/messages/${copiedMessageId}/transcript`,
    );
    expect(incompleteResponse.status()).toBe(422);
    await e2eDb.update(runRuntimeSpans).set({ completeness: "complete" }).where(eq(runRuntimeSpans.id, spanId));

    hermesState.messages[sessionId]![1]!.content = "Changed Hermes source answer";
    await fs.writeFile(hermesStatePath, JSON.stringify(hermesState), "utf8");
    const mismatchedResponse = await page.request.get(
      `/api/chats/${child.id}/messages/${copiedMessageId}/transcript`,
    );
    expect(mismatchedResponse.status()).toBe(422);
    expect(await mismatchedResponse.text()).toContain("Native Fork alias content no longer matches its sealed source range");
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("forks from an earlier assistant message while a later reply is streaming", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Fork-Streaming-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Autumn",
    command: E2E_CODEX_STUB,
  });

  const sourceConversationId = randomUUID();
  const sourceMessageIds = [randomUUID(), randomUUID()];
  await e2eDb.insert(chatConversations).values({
    id: sourceConversationId,
    orgId: organization.id,
    title: "Forkable streaming chat",
    preferredAgentId: chatAgent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-06-22T09:02:00.000Z"),
    createdAt: new Date("2026-06-22T09:00:00.000Z"),
    updatedAt: new Date("2026-06-22T09:02:00.000Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceMessageIds[0],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Stable premise before streaming",
      createdAt: new Date("2026-06-22T09:01:00.000Z"),
      updatedAt: new Date("2026-06-22T09:01:00.000Z"),
    },
    {
      id: sourceMessageIds[1],
      orgId: organization.id,
      conversationId: sourceConversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Earlier completed branch point",
      replyingAgentId: chatAgent.id,
      createdAt: new Date("2026-06-22T09:02:00.000Z"),
      updatedAt: new Date("2026-06-22T09:02:00.000Z"),
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat/${sourceConversationId}`);

  const sourceAssistant = page.locator(`[data-testid="chat-assistant-message"][data-message-id="${sourceMessageIds[1]}"]`);
  await expect(sourceAssistant).toContainText("Earlier completed branch point", { timeout: 15_000 });

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Later prompt that is still running");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });

  await sourceAssistant.scrollIntoViewIfNeeded();
  await sourceAssistant.hover();
  await expect(sourceAssistant.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
  await sourceAssistant.getByRole("button", { name: "More message actions" }).filter({ visible: true }).click();
  await expect(page.getByTestId("chat-fork-more-action")).toBeVisible();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${sourceConversationId}/fork`),
  );
  await page.getByTestId("chat-fork-more-action").click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const forkedConversation = await forkResponse.json() as {
    id: string;
    forkedFromConversationId: string | null;
    forkedFromMessageId: string | null;
    forkRootConversationId: string | null;
  };

  expect(forkedConversation.forkedFromConversationId).toBe(sourceConversationId);
  expect(forkedConversation.forkedFromMessageId).toBe(sourceMessageIds[1]);
  expect(forkedConversation.forkRootConversationId).toBe(sourceConversationId);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`));
  await expect(page.getByTestId("chat-messages-content")).toContainText("Stable premise before streaming");
  await expect(page.getByTestId("chat-messages-content")).toContainText("Earlier completed branch point");
  await expect(page.getByTestId("chat-messages-content")).not.toContainText("Later prompt that is still running");
  await expect(page.getByTestId("chat-messages-content")).not.toContainText("Streaming reply for chat.");

  const messagesRes = await page.request.get(`/api/chats/${forkedConversation.id}/messages`);
  expect(messagesRes.ok()).toBe(true);
  const forkMessages = await messagesRes.json() as Array<{ role: string; body: string }>;
  expect(forkMessages.map((message) => message.body).slice(0, 2)).toEqual([
    "Stable premise before streaming",
    "Earlier completed branch point",
  ]);
  expect(forkMessages.some((message) => message.body.includes("Later prompt that is still running"))).toBe(false);
  expect(forkMessages.some((message) => message.body.includes("Streaming reply for chat."))).toBe(false);
});

test("forks from a completed historical turn variant after its replacement was stopped", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const organization = await createOrganization(page, `Historical-Fork-${Date.now()}`);
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Historical Fork Agent",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const sourceUserId = randomUUID();
  const sourceAssistantId = randomUUID();
  const supersededAt = new Date("2026-07-30T16:54:30.434Z");
  await e2eDb.insert(chatConversations).values({
    id: conversationId,
    orgId: organization.id,
    title: "Historical fork source",
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date("2026-07-30T16:54:35.390Z"),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: sourceUserId,
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Original historical request",
      chatTurnId: turnId,
      turnVariant: 0,
      supersededAt,
      createdAt: new Date("2026-07-30T14:47:07.233Z"),
      updatedAt: supersededAt,
    },
    {
      id: sourceAssistantId,
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Completed historical answer",
      replyingAgentId: agent.id,
      chatTurnId: turnId,
      turnVariant: 0,
      supersededAt,
      createdAt: new Date("2026-07-30T14:55:24.548Z"),
      updatedAt: supersededAt,
    },
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Replacement request that was stopped",
      chatTurnId: turnId,
      turnVariant: 1,
      createdAt: new Date("2026-07-30T16:54:30.434Z"),
      updatedAt: new Date("2026-07-30T16:54:30.434Z"),
    },
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "stopped",
      body: "Chat run stopped before a final reply.",
      replyingAgentId: agent.id,
      chatTurnId: turnId,
      turnVariant: 1,
      createdAt: new Date("2026-07-30T16:54:35.390Z"),
      updatedAt: new Date("2026-07-30T16:54:35.390Z"),
    },
  ]);

  await openOrganizationChat(page, organization, conversationId);
  await expect(page.getByText("2/2")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Previous branch" }).click();
  await expect(page.getByText("1/2")).toBeVisible();
  await expect(page.getByText("Completed historical answer")).toBeVisible();

  const forked = await forkFromAssistantMessage(page, conversationId, sourceAssistantId);
  await expect(page.getByText("Completed historical answer")).toBeVisible();
  await expect(page.getByText("Replacement request that was stopped")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("historical-variant-fork.png"),
    fullPage: true,
  });

  const messagesRes = await page.request.get(`/api/chats/${forked.id}/messages`);
  expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
  const messages = await messagesRes.json() as Array<{ body: string }>;
  expect(messages.map((message) => message.body).slice(0, 2)).toEqual([
    "Original historical request",
    "Completed historical answer",
  ]);
  expect(messages.map((message) => message.body)).not.toContain("Replacement request that was stopped");
});

test("keeps a numbered fork title after the first new user message when Fast Intelligence is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const organization = await createOrganization(page, `Fallback-Fork-Title-${Date.now()}`);
  const source = await seedForkableChatSource(page, {
    orgId: organization.id,
    title: "Inherited fallback source title",
    agentName: "Fork Title Fallback Agent",
    userBody: "Original fallback fork premise",
    assistantBody: "Use this fallback branch point",
  });

  await openOrganizationChat(page, organization, source.sourceConversationId);
  await expect(page.getByTestId("chat-messages-content")).toContainText("Use this fallback branch point", { timeout: 15_000 });
  const forkedConversation = await forkFromAssistantMessage(page, source.sourceConversationId, source.sourceMessageIds[1]!);
  const forkTitle = "Inherited fallback source title (2)";
  await expect(page.getByTestId(threadTestId(`chat:${forkedConversation.id}`))).toContainText(forkTitle, { timeout: 15_000 });

  const firstForkMessage = "Draft a branch-specific launch checklist";
  await sendFirstForkMessage(page, firstForkMessage);

  await expect(page.getByTestId("chat-messages-content")).toContainText("Streaming reply for chat.", { timeout: 20_000 });
  await expectChatTitle(page, forkedConversation.id, forkTitle);
});

test("keeps a numbered fork title after the first new user message when Fast Intelligence is configured", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });

  const organization = await createOrganization(page, `Intelligence-Fork-Title-${Date.now()}`);
  await configureFastTitleProfile(page, organization.id, "AI fork pricing title");
  const source = await seedForkableChatSource(page, {
    orgId: organization.id,
    title: "Inherited AI source title",
    agentName: "Fork Title AI Agent",
    userBody: "Original AI fork premise",
    assistantBody: "Use this AI branch point",
  });

  await openOrganizationChat(page, organization, source.sourceConversationId);
  await expect(page.getByTestId("chat-messages-content")).toContainText("Use this AI branch point", { timeout: 15_000 });
  const forkedConversation = await forkFromAssistantMessage(page, source.sourceConversationId, source.sourceMessageIds[1]!);
  const forkTitle = "Inherited AI source title (2)";
  await expect(page.getByTestId(threadTestId(`chat:${forkedConversation.id}`))).toContainText(forkTitle, { timeout: 15_000 });

  await sendFirstForkMessage(page, "Explore a pricing branch for agency teams");

  await expect(page.getByTestId("chat-messages-content")).toContainText("Streaming reply for chat.", { timeout: 20_000 });
  await expectChatTitle(page, forkedConversation.id, forkTitle);
});
