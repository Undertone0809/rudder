import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  createDb,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import {
  E2E_CODEX_APP_SERVER_STUB,
  E2E_CODEX_STUB,
  E2E_DATABASE_URL,
} from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

const FINAL_BODY = [
  "## 发布建议",
  "",
  "第一段包含 [Rudder docs](https://rudderhq.dev) 和 `inline_code`，并保留精确的 CJK 选区。",
  "",
  "Second paragraph keeps the selection stable across Markdown blocks.",
  "",
  "- list target alpha",
  "- list target beta",
  "",
  "para-memory-files",
  "rudder-docs",
  "skill-creator",
  "visualize browser",
].join("\n");
const FIRST_PROCESS_TEXT = "可见 Thinking 过程：先核对数据与用户约束。";
const SECOND_PROCESS_TEXT = "第二个 Thinking 区块：再比较稳定证据。";

type SeededAnnotationChat = {
  organization: {
    id: string;
    issuePrefix: string;
    urlKey: string;
  };
  agent: { id: string };
  conversationId: string;
  assistantMessageId: string;
  generationId: string;
};

function sourceHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedAnnotationChat(
  page: Page,
  name: string,
  options: { nativeSteerRuntime?: boolean } = {},
): Promise<SeededAnnotationChat> {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as SeededAnnotationChat["organization"];
  const agent = await createE2EChatAgent(
    page.request,
    organization.id,
    options.nativeSteerRuntime
      ? {
        name: "Annotation Agent",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_APP_SERVER_STUB,
          chatAppServerEnabled: true,
        },
      }
      : {
        name: "Annotation Agent",
        command: E2E_CODEX_STUB,
      },
  ) as { id: string };
  const conversationId = randomUUID();
  const assistantMessageId = randomUUID();
  const generationId = randomUUID();
  const now = Date.now();

  await e2eDb.insert(chatConversations).values({
    id: conversationId,
    orgId: organization.id,
    title: "Response annotation contract",
    preferredAgentId: agent.id,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "local-board",
    lastMessageAt: new Date(now - 1_000),
  });
  await e2eDb.insert(chatMessages).values([
    {
      id: randomUUID(),
      orgId: organization.id,
      conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Give me a production-shaped launch recommendation.",
      chatTurnId: randomUUID(),
      turnVariant: 0,
      createdAt: new Date(now - 4_000),
      updatedAt: new Date(now - 4_000),
    },
    {
      id: assistantMessageId,
      orgId: organization.id,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: FINAL_BODY,
      structuredPayload: {
        __chatTranscript: [
          {
            kind: "thinking",
            ts: new Date(now - 3_000).toISOString(),
            text: FIRST_PROCESS_TEXT,
            generationId,
            generationSeqStart: 1,
            generationSeqEnd: 1,
          },
          {
            kind: "thinking",
            ts: new Date(now - 2_000).toISOString(),
            text: SECOND_PROCESS_TEXT,
            generationId,
            generationSeqStart: 2,
            generationSeqEnd: 2,
          },
        ],
      },
      replyingAgentId: agent.id,
      chatTurnId: randomUUID(),
      turnVariant: 0,
      createdAt: new Date(now - 1_000),
      updatedAt: new Date(now - 1_000),
    },
  ]);
  await e2eDb.insert(chatGenerations).values({
    id: generationId,
    orgId: organization.id,
    conversationId,
    status: "completed",
    terminalReason: "completed",
    attemptEpoch: 1,
    controlVersion: 0,
    controlState: "terminal",
    acceptedThroughSeq: 2,
    frozenBodyHash: sourceHash(FINAL_BODY),
    runtimeTerminalAt: new Date(now - 1_000),
    completedAt: new Date(now - 1_000),
    startedAt: new Date(now - 4_000),
  });
  await e2eDb.insert(chatGenerationEvents).values([
    {
      id: randomUUID(),
      orgId: organization.id,
      generationId,
      generationSeq: 1,
      attemptEpoch: 1,
      eventKind: "transcript",
      assistantMessageId,
      payload: {
        entry: {
          kind: "thinking",
          ts: new Date(now - 3_000).toISOString(),
          text: FIRST_PROCESS_TEXT,
        },
      },
      recordedAt: new Date(now - 3_000),
    },
    {
      id: randomUUID(),
      orgId: organization.id,
      generationId,
      generationSeq: 2,
      attemptEpoch: 1,
      eventKind: "transcript",
      assistantMessageId,
      payload: {
        entry: {
          kind: "thinking",
          ts: new Date(now - 2_000).toISOString(),
          text: SECOND_PROCESS_TEXT,
        },
      },
      recordedAt: new Date(now - 2_000),
    },
  ]);

  await page.goto("/");
  await page.evaluate((orgId) => {
    localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${conversationId}`);
  await expect(
    page.locator(
      `[data-testid="chat-assistant-message"][data-message-id="${assistantMessageId}"]`,
    ),
  ).toContainText("Rudder docs", { timeout: 30_000 });

  return {
    organization,
    agent,
    conversationId,
    assistantMessageId,
    generationId,
  };
}

function composer(page: Page) {
  return page
    .getByTestId("chat-composer-editor-scroll")
    .locator(".rudder-mdxeditor-content")
    .first();
}

function annotationToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Response annotation actions" });
}

function annotationSource(
  page: Page,
  options: {
    messageId: string;
    surface: "assistant_body" | "process_transcript";
    text?: string;
  },
) {
  let source = page.locator(
    `[data-chat-annotation-source][data-message-id="${options.messageId}"]`
    + `[data-annotation-surface="${options.surface}"]`,
  );
  if (options.text) source = source.filter({ hasText: options.text });
  return source.first();
}

type SelectionGeometry = {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  };
  endpoint: {
    x: number;
    y: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  };
};

async function selectVisibleText(
  page: Page,
  root: Locator,
  startNeedle: string,
  endNeedle = startNeedle,
  options: { expectToolbar?: boolean; dispatchSelection?: boolean } = {},
): Promise<SelectionGeometry> {
  await root.scrollIntoViewIfNeeded();
  const geometry = await root.evaluate((sourceRoot, selection) => {
    const ignored = (node: Node) => {
      const element = node instanceof HTMLElement ? node : node.parentElement;
      return Boolean(element?.closest("[data-chat-annotation-ignore]"));
    };
    const walker = document.createTreeWalker(
      sourceRoot,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return ignored(node) || !node.textContent
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const nodes: Text[] = [];
    let rendered = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node as Text);
      rendered += node.textContent ?? "";
    }
    const start = rendered.indexOf(selection.startNeedle);
    const endStart = rendered.indexOf(selection.endNeedle, Math.max(0, start));
    if (start < 0 || endStart < 0) {
      throw new Error(
        `Could not find selection "${selection.startNeedle}" → "${selection.endNeedle}" in "${rendered}"`,
      );
    }
    const end = endStart + selection.endNeedle.length;
    const boundary = (absoluteOffset: number, edge: "start" | "end") => {
      let traversed = 0;
      for (const node of nodes) {
        const length = node.textContent?.length ?? 0;
        const inside = edge === "start"
          ? absoluteOffset < traversed + length
          : absoluteOffset <= traversed + length;
        if (inside) return { node, offset: absoluteOffset - traversed };
        traversed += length;
      }
      const last = nodes.at(-1);
      if (!last) throw new Error("Selection source has no text nodes");
      return { node: last, offset: last.textContent?.length ?? 0 };
    };
    const startBoundary = boundary(start, "start");
    const endBoundary = boundary(end, "end");
    const range = document.createRange();
    range.setStart(startBoundary.node, startBoundary.offset);
    range.setEnd(endBoundary.node, endBoundary.offset);
    const toGeometry = (rect: DOMRect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    });
    const clientRects = Array.from(range.getClientRects());
    const endpoint = clientRects.at(-1) ?? range.getBoundingClientRect();
    if (selection.dispatchSelection !== false) {
      const browserSelection = window.getSelection();
      browserSelection?.removeAllRanges();
      browserSelection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      sourceRoot.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }
    return {
      bounds: toGeometry(range.getBoundingClientRect()),
      endpoint: toGeometry(endpoint),
    };
  }, { startNeedle, endNeedle, dispatchSelection: options.dispatchSelection });
  if (options.expectToolbar !== false) {
    await expect(annotationToolbar(page)).toBeVisible({ timeout: 5_000 });
  }
  return geometry;
}

async function expectMarkerNearSelection(
  marker: Locator,
  source: Locator,
  selection: SelectionGeometry,
) {
  await expect(marker).toBeVisible();
  const markerBox = await marker.boundingBox();
  const sourceBox = await source.boundingBox();
  expect(markerBox).toBeTruthy();
  expect(sourceBox).toBeTruthy();
  const markerCenterY = markerBox!.y + markerBox!.height / 2;
  const endpointCenterY = selection.endpoint.y + selection.endpoint.height / 2;
  const overlapsSelection = (
    markerBox!.x < selection.bounds.right
    && markerBox!.x + markerBox!.width > selection.bounds.x
    && markerBox!.y < selection.bounds.bottom
    && markerBox!.y + markerBox!.height > selection.bounds.y
  );
  expect(overlapsSelection).toBe(false);
  expect(Math.abs(markerCenterY - endpointCenterY)).toBeLessThanOrEqual(48);
  expect(markerCenterY).toBeGreaterThanOrEqual(sourceBox!.y - 8);
  expect(markerCenterY).toBeLessThanOrEqual(sourceBox!.y + sourceBox!.height + 8);
}

async function selectAcrossRoots(
  page: Page,
  startRoot: Locator,
  startNeedle: string,
  endRoot: Locator,
  endNeedle: string,
) {
  const startHandle = await startRoot.elementHandle();
  const endHandle = await endRoot.elementHandle();
  expect(startHandle).toBeTruthy();
  expect(endHandle).toBeTruthy();
  await page.evaluate(
    ({ startRoot, endRoot, startNeedle, endNeedle }) => {
      const textNodes = (root: Element) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent) nodes.push(node as Text);
        }
        return nodes;
      };
      const boundary = (root: Element, needle: string, edge: "start" | "end") => {
        let traversed = 0;
        for (const node of textNodes(root)) {
          const text = node.textContent ?? "";
          const index = text.indexOf(needle);
          if (index >= 0) {
            return {
              node,
              offset: index + (edge === "end" ? needle.length : 0),
            };
          }
          traversed += text.length;
        }
        throw new Error(`Could not find cross-root needle "${needle}" after ${traversed} characters`);
      };
      const start = boundary(startRoot, startNeedle, "start");
      const end = boundary(endRoot, endNeedle, "end");
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const browserSelection = window.getSelection();
      browserSelection?.removeAllRanges();
      browserSelection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      endRoot.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    {
      startRoot: startHandle!,
      endRoot: endHandle!,
      startNeedle,
      endNeedle,
    },
  );
}

async function expandProcess(page: Page, messageId: string) {
  const toggle = processToggleForAssistant(page, messageId);
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(
    annotationSource(page, {
      messageId,
      surface: "process_transcript",
      text: FIRST_PROCESS_TEXT,
    }),
  ).toBeVisible({ timeout: 15_000 });
}

function processToggleForAssistant(page: Page, messageId: string) {
  const assistant = page.locator(
    `[data-testid="chat-assistant-message"][data-message-id="${messageId}"]`,
  );
  const processItem = assistant.locator(
    "xpath=preceding-sibling::*[@data-testid='chat-transcript-item'][1]",
  );
  return processItem
    .getByRole("button", { name: /Worked for|Show process|Hide process/ })
    .first();
}

async function addSelectionToChat(page: Page, options: { save?: boolean } = {}) {
  await annotationToolbar(page).getByRole("button", { name: "Add to chat" }).click();
  const editor = page.getByTestId("chat-response-annotation-editor");
  await expect(editor).toBeVisible();
  await expect(editor).not.toContainText("User comment:");
  if (options.save !== false) {
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
  }
  return editor;
}

function draftAnnotationChip(page: Page, count: number) {
  return page.getByRole("button", {
    name: new RegExp(`(?:Show|Hide) ${count} annotations?`),
  }).first();
}

async function expandDraftAnnotations(page: Page, count: number) {
  const chip = draftAnnotationChip(page, count);
  if (await chip.getAttribute("aria-expanded") !== "true") await chip.click();
}

async function expandSentAnnotations(page: Page, turn: Locator, count: number) {
  const chip = turn.getByRole("button", {
    name: new RegExp(`(?:Show|Hide) ${count} annotations?`),
  });
  if (await chip.getAttribute("aria-expanded") !== "true") await chip.click();
  const card = page.getByTestId("chat-response-annotation-sent-card");
  await expect(card).toBeVisible();
  return card;
}

async function editAnnotation(
  page: Page,
  ordinal: number,
  options: {
    comment: string;
    files?: Array<{ name: string; mimeType: string; buffer: Buffer }>;
  },
) {
  const showChip = page.getByRole("button", {
    name: new RegExp(`Show \\d+ annotation`),
  }).first();
  if (await showChip.getAttribute("aria-expanded") !== "true") await showChip.click();
  const draftCard = page.getByTestId("chat-response-annotation-card");
  await expect(draftCard).toBeVisible();
  await draftCard.hover();
  await draftCard.getByRole("button", { name: `Edit annotation ${ordinal}` }).click();
  const editor = page.getByTestId("chat-response-annotation-editor");
  await expect(editor).toBeVisible();
  await editor.getByPlaceholder("Add an optional comment…").fill(options.comment);
  if (options.files?.length) {
    await editor.getByLabel("Add images or files").setInputFiles(options.files);
    await expect(editor.getByTestId("chat-response-annotation-pending-attachment"))
      .toHaveCount(options.files.length);
  }
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

async function createInlineVisualRuntimeStub() {
  const directory = await mkdtemp(join(tmpdir(), "rudder-response-annotation-visual-"));
  const scriptPath = join(directory, "codex");
  await writeFile(scriptPath, `#!/usr/bin/env node
process.stdout.write([
    "RUDDER_RESULT_BEGIN",
    "Selectable prose before the inline visual.",
    "",
    ":::rudder-inline-visual:v1",
    "<div id=\\"widget\\"><strong id=\\"annotation-inline-visual\\">Iframe-only evidence</strong></div>",
    ":::rudder-inline-visual:end",
    "",
    "Selectable prose after the inline visual.",
    "RUDDER_RESULT_END",
  ].join("\\n"));
`, "utf8");
  await chmod(scriptPath, 0o755);
  return { directory, scriptPath };
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Chat response annotations", () => {
  test("annotates rich final text, owns files, sends annotation-only, and restores immutable evidence", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotations-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });

    const firstSelectionGeometry = await selectVisibleText(
      page,
      finalSource,
      "第一段包含",
    );
    const toolbar = annotationToolbar(page);
    await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
    await expect(toolbar.getByRole("button")).toHaveCount(2);
    const firstEditor = await addSelectionToChat(page, { save: false });
    const firstComment = firstEditor.getByLabel("Comment");
    await expect(firstComment).toBeFocused();
    await firstComment.fill("Please verify this CJK and Markdown claim.");
    await firstEditor.getByLabel("Add images or files").setInputFiles({
      name: "annotation-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("annotation-owned evidence"),
    });
    await firstEditor.getByLabel("Comment").evaluate((textarea, pngBytes) => {
      const file = new File([new Uint8Array(pngBytes)], "annotation-evidence.png", {
        type: "image/png",
      });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }));
    }, [...ONE_BY_ONE_PNG]);
    await expect(firstEditor.getByTestId("chat-response-annotation-pending-attachment"))
      .toHaveCount(2);
    await firstEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(draftAnnotationChip(page, 1)).toBeVisible();
    const firstMarker = finalSource
      .getByTestId("chat-response-annotation-marker")
      .filter({ hasText: "1" });
    await expect(firstMarker).toHaveText("1");
    await expectMarkerNearSelection(firstMarker, finalSource, firstSelectionGeometry);
    await selectVisibleText(
      page,
      finalSource,
      "Second paragraph keeps the selection stable across Markdown blocks.",
    );
    await expect(toolbar.getByRole("button", { name: "More details" })).toHaveCount(0);
    await addSelectionToChat(page);
    await expect(draftAnnotationChip(page, 2)).toBeVisible();
    await expect(composer(page)).toHaveText("");
    await composer(page).blur();

    await expect(page.getByTestId("chat-response-annotation-marker")).toHaveCount(2);

    const streamRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes(`/api/chats/${seeded.conversationId}/messages/stream`)
    ));
    await page.getByRole("button", { name: "Send" }).click();
    const request = await streamRequest;
    expect(request.headers()["content-type"]).toContain("multipart/form-data");

    const sentTurn = page.getByTestId("chat-user-message-turn").last();
    await expect(sentTurn.getByRole("button", { name: "Show 2 annotations" })).toBeVisible({
      timeout: 15_000,
    });
    const sentCard = await expandSentAnnotations(page, sentTurn, 2);
    const sentEntries = sentCard.getByTestId("chat-response-annotation-sent-card-entry");
    await expect(sentEntries).toHaveCount(2);
    await expect(sentEntries.nth(0)).toContainText("Please verify this CJK and Markdown claim.");
    await expect(sentEntries.nth(0).getByText("annotation-notes.txt")).toBeVisible();
    await expect(sentEntries.nth(0).getByTestId("chat-annotation-image-attachment")).toBeVisible();
    await expect(sentCard.getByRole("button", { name: /Edit annotation|Delete annotation/ }))
      .toHaveCount(0);
    await expect(
      page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }),
    ).toBeVisible({ timeout: 20_000 });

    const messagesRes = await page.request.get(
      `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
    );
    expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
    const messages = await messagesRes.json() as Array<{
      id: string;
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          id: string;
          selectedText: string;
          comment: string | null;
          sourceMessageId: string;
          surface: string;
          generationId?: string;
          generationSeqStart?: number;
          generationSeqEnd?: number;
          attachmentIds: string[];
        }>;
      } | null;
      attachments: Array<{ id: string; originalFilename: string | null }>;
    }>;
    const sentUserMessage = [...messages].reverse().find((message) => (
      message.role === "user" && message.structuredPayload?.inlineAnnotations?.length === 2
    ));
    expect(sentUserMessage).toBeTruthy();
    expect(sentUserMessage!.body).toBe("");
    expect(sentUserMessage!.structuredPayload!.inlineAnnotations).toEqual([
      expect.objectContaining({
        sourceMessageId: seeded.assistantMessageId,
        surface: "assistant_body",
        comment: "Please verify this CJK and Markdown claim.",
        attachmentIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
      }),
      expect.objectContaining({
        sourceMessageId: seeded.assistantMessageId,
        surface: "assistant_body",
      }),
    ]);
    expect(sentUserMessage!.attachments.map((attachment) => attachment.originalFilename).sort())
      .toEqual(["annotation-evidence.png", "annotation-notes.txt"]);

    await page.reload();
    const reloadedTurn = page
      .locator(`[data-testid="chat-user-message-turn"][data-message-id="${sentUserMessage!.id}"]`);
    await expect(reloadedTurn.getByRole("button", { name: "Show 2 annotations" }))
      .toBeVisible({ timeout: 15_000 });
    const reloadedCard = await expandSentAnnotations(page, reloadedTurn, 2);
    await reloadedCard
      .getByTestId("chat-response-annotation-sent-card-entry")
      .first()
      .getByRole("button", { name: "Show source" })
      .click();
    await expect(finalSource).toBeVisible({ timeout: 15_000 });
    await expect(finalSource).toHaveClass(/chat-message-jump-highlight/);
    const restoredSelectionGeometry = await selectVisibleText(
      page,
      finalSource,
      "第一段包含",
      "第一段包含",
      { expectToolbar: false, dispatchSelection: false },
    );
    const restoredMarker = finalSource
      .getByTestId("chat-response-annotation-marker")
      .filter({ hasText: "1" });
    await expectMarkerNearSelection(restoredMarker, finalSource, restoredSelectionGeometry);
    await expect(reloadedCard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reloadedCard).toHaveCount(0);
    const reloadedChip = reloadedTurn.getByRole("button", { name: "Show 2 annotations" });
    await expect(reloadedChip).toBeFocused();
    await reloadedChip.click();
    await expect(reloadedCard).toBeVisible();

    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-desktop.png`,
      fullPage: false,
      animations: "disabled",
    });

    await e2eDb.delete(chatMessages).where(eq(chatMessages.id, seeded.assistantMessageId));
    await page.reload();
    const unlocatableTurn = page
      .locator(`[data-testid="chat-user-message-turn"][data-message-id="${sentUserMessage!.id}"]`);
    const unlocatableCard = await expandSentAnnotations(page, unlocatableTurn, 2);
    await unlocatableCard
      .getByTestId("chat-response-annotation-sent-card-entry")
      .first()
      .getByRole("button", { name: "Show source" })
      .click();
    await expect(page.getByTestId("chat-response-annotation-unlocatable")).toBeVisible();
    await expect(unlocatableCard).toBeVisible();
    await expect(unlocatableCard).toContainText("第一段包含");
  });

  test("maps a rich CJK selection across a Markdown link and inline code", async ({ page }) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Rich-Mapping-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await selectVisibleText(page, finalSource, "第一段包含", "inline_code");
    await addSelectionToChat(page);
    await expect(draftAnnotationChip(page, 1)).toBeVisible();
    await expandDraftAnnotations(page, 1);
    const card = page.getByTestId("chat-response-annotation-card");
    await expect(card).toContainText("第一段包含");
    await expect(card).toContainText("Rudder docs");
    await expect(card).toContainText("inline_code");
    await composer(page).fill("Keep this body when annotations are cleared.");
    await page.getByRole("button", { name: "Clear all annotations" }).click();
    await expect(draftAnnotationChip(page, 1)).toHaveCount(0);
    await expect(finalSource.getByTestId("chat-response-annotation-marker")).toHaveCount(0);
    await expect(composer(page)).toHaveText("Keep this body when annotations are cleared.");
  });

  test("maps and deduplicates an exact selection across Markdown paragraphs", async ({ page }) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Mapping-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await selectVisibleText(
      page,
      finalSource,
      "精确的 CJK 选区。",
      "Second paragraph keeps the selection stable across Markdown blocks.",
    );
    await addSelectionToChat(page);
    await expect(draftAnnotationChip(page, 1)).toBeVisible();

    await selectVisibleText(
      page,
      finalSource,
      "精确的 CJK 选区。",
      "Second paragraph keeps the selection stable across Markdown blocks.",
    );
    await addSelectionToChat(page);
    await expect(draftAnnotationChip(page, 1)).toBeVisible();
    await expandDraftAnnotations(page, 1);
    const card = page.getByTestId("chat-response-annotation-card");
    await expect(card).toContainText("精确的 CJK 选区。");
    await expect(card).toContainText(
      "Second paragraph keeps the selection stable across Markdown blocks.",
    );
    await card.getByRole("button", { name: "Delete annotation 1" }).click();
    await expect(draftAnnotationChip(page, 1)).toHaveCount(0);
    await expect(finalSource.getByTestId("chat-response-annotation-marker")).toHaveCount(0);
    await expect(finalSource.getByTestId("chat-response-annotation-highlight")).toHaveCount(0);
  });

  test("highlights source text, opens only the activated draft, keeps markers clear, and sends a soft-break partial selection", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(
      page,
      `Response-Annotation-Draft-Interaction-${Date.now()}`,
    );
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });

    await selectVisibleText(page, finalSource, "Rudder docs");
    await addSelectionToChat(page);
    const secondSelection = await selectVisibleText(page, finalSource, "skill-creato");
    await addSelectionToChat(page);
    await expect(draftAnnotationChip(page, 2)).toBeVisible();

    const secondMarker = finalSource
      .getByTestId("chat-response-annotation-marker")
      .filter({ hasText: "2" });
    await expect(secondMarker).toBeVisible();
    const sourceHighlights = finalSource.locator(
      `[data-testid="chat-response-annotation-highlight"][data-annotation-id]`,
    );
    await expect(sourceHighlights).toHaveCount(2);
    await expect(sourceHighlights.first().locator(":scope > span")).not.toHaveCount(0);
    await expect(sourceHighlights.last().locator(":scope > span")).not.toHaveCount(0);
    const secondHighlightBoxes = await sourceHighlights.last().locator(":scope > span")
      .evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      }));
    expect(secondHighlightBoxes.some((rect) => (
      rect.left < secondSelection.bounds.right
      && rect.right > secondSelection.bounds.x
      && rect.top < secondSelection.bounds.bottom
      && rect.bottom > secondSelection.bounds.y
    ))).toBe(true);
    const clippingParagraph = finalSource.locator("p")
      .filter({ hasText: "Rudder docs" })
      .first();
    await clippingParagraph.evaluate((element) => {
      Object.assign(element.style, {
        overflowX: "auto",
        whiteSpace: "nowrap",
        width: "120px",
      });
    });
    await expect.poll(() => clippingParagraph.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    )).toBe(true);
    await clippingParagraph.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(sourceHighlights.first().locator(":scope > span")).toHaveCount(0);
    await clippingParagraph.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect(sourceHighlights.first().locator(":scope > span")).not.toHaveCount(0);
    const markerBox = await secondMarker.boundingBox();
    expect(markerBox).toBeTruthy();
    const markerOverlapsSelection = !(
      markerBox!.x + markerBox!.width <= secondSelection.bounds.x
      || markerBox!.x >= secondSelection.bounds.right
      || markerBox!.y + markerBox!.height <= secondSelection.bounds.y
      || markerBox!.y >= secondSelection.bounds.bottom
    );
    expect(markerOverlapsSelection).toBe(false);

    await secondMarker.click();
    const editor = page.getByTestId("chat-response-annotation-editor");
    await expect(editor).toBeVisible();
    await expect(editor).not.toContainText("Selected text:");
    await expect(editor).not.toContainText("skill-creato");
    await expect(editor).not.toContainText("Rudder docs");
    await expect(page.getByTestId("chat-response-annotation-card")).toHaveCount(0);
    const attachmentAction = editor.locator("label[aria-label='Add images or files']");
    await expect(attachmentAction).toHaveText("");
    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-selected-only.png`,
      fullPage: false,
      animations: "disabled",
    });
    await editor.getByPlaceholder("Add an optional comment…").fill("Only edit annotation two.");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);

    const composerLayout = page.getByTestId("chat-composer-layout");
    const composerBefore = await composerLayout.boundingBox();
    expect(composerBefore).toBeTruthy();
    await draftAnnotationChip(page, 2).click();
    const draftPopover = page.getByTestId("chat-response-annotations-draft-popover");
    await expect(draftPopover).toBeVisible();
    await expect(draftPopover).toHaveAttribute("data-side", "top");
    await expect(page.getByTestId("chat-response-annotation-card")).toContainText(
      "Only edit annotation two.",
    );
    const composerAfter = await composerLayout.boundingBox();
    expect(composerAfter).toBeTruthy();
    expect(Math.abs(composerAfter!.height - composerBefore!.height)).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-draft-popover.png`,
      fullPage: false,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(draftPopover).toHaveCount(0);

    const streamRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes(`/api/chats/${seeded.conversationId}/messages/stream`)
    ));
    await page.getByRole("button", { name: "Send" }).click();
    await streamRequest;
    await expect(page.getByText("Failed to send message")).toHaveCount(0);
    const sentTurn = page.getByTestId("chat-user-message-turn").last();
    await expect(sentTurn.getByRole("button", { name: "Show 2 annotations" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("persists Process provenance and restores its exact source after reload", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Process-${Date.now()}`);
    await expandProcess(page, seeded.assistantMessageId);
    const processSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "process_transcript",
      text: FIRST_PROCESS_TEXT,
    });
    await selectVisibleText(page, processSource, "Thinking 过程", "用户约束");
    await addSelectionToChat(page);
    await editAnnotation(page, 1, {
      comment: "Use this visible Process evidence only.",
    });
    await composer(page).fill("Explain the cited Process evidence.");
    await page.getByRole("button", { name: "Send" }).click();

    const sentTurn = page
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: "Explain the cited Process evidence." });
    await expect(sentTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });

    const messagesRes = await page.request.get(
      `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
    );
    expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
    const messages = await messagesRes.json() as Array<{
      id: string;
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          sourceMessageId: string;
          surface: string;
          transcriptKind?: string;
          generationId?: string;
          generationSeqStart?: number;
          generationSeqEnd?: number;
        }>;
      } | null;
    }>;
    const sentUserMessage = messages.find((message) => (
      message.role === "user" && message.body === "Explain the cited Process evidence."
    ));
    expect(sentUserMessage).toEqual(expect.objectContaining({
      structuredPayload: expect.objectContaining({
        inlineAnnotations: [expect.objectContaining({
          sourceMessageId: seeded.assistantMessageId,
          surface: "process_transcript",
          transcriptKind: "thinking",
          generationId: seeded.generationId,
          generationSeqStart: 1,
          generationSeqEnd: 1,
        })],
      }),
    }));

    await page.reload();
    const reloadedTurn = page.locator(
      `[data-testid="chat-user-message-turn"][data-message-id="${sentUserMessage!.id}"]`,
    );
    const sourceProcessToggle = processToggleForAssistant(page, seeded.assistantMessageId);
    await expect(sourceProcessToggle).not.toHaveAttribute("aria-expanded", "true");
    const reloadedCard = await expandSentAnnotations(page, reloadedTurn, 1);
    await reloadedCard
      .getByTestId("chat-response-annotation-sent-card-entry")
      .getByRole("button", { name: "Show source" })
      .click();
    await expect(sourceProcessToggle).toHaveAttribute("aria-expanded", "true");
    await expect(processSource).toBeVisible({ timeout: 15_000 });
    await expect(processSource).toHaveClass(/chat-message-jump-highlight/);
    const restoredProcessSelectionGeometry = await selectVisibleText(
      page,
      processSource,
      "Thinking 过程",
      "用户约束",
      { expectToolbar: false, dispatchSelection: false },
    );
    const restoredProcessMarker = processSource
      .getByTestId("chat-response-annotation-marker")
      .filter({ hasText: "1" });
    await expectMarkerNearSelection(
      restoredProcessMarker,
      processSource,
      restoredProcessSelectionGeometry,
    );
    await expect(reloadedCard).toBeVisible();
    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-process.png`,
      fullPage: false,
      animations: "disabled",
    });
  });

  test("rejects cross-source and cross-Process-block ranges and keeps the toolbar keyboard-safe in narrow layouts", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-A11y-${Date.now()}`);
    const userBubble = page.getByTestId("chat-user-message-bubble").first();
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });

    await selectAcrossRoots(
      page,
      userBubble,
      "production-shaped",
      finalSource,
      "Rudder docs",
    );
    await expect(annotationToolbar(page)).toHaveCount(0);

    await expandProcess(page, seeded.assistantMessageId);
    const firstProcess = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "process_transcript",
      text: FIRST_PROCESS_TEXT,
    });
    const secondProcess = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "process_transcript",
      text: SECOND_PROCESS_TEXT,
    });
    await selectAcrossRoots(
      page,
      firstProcess,
      "Thinking 过程",
      secondProcess,
      "稳定证据",
    );
    await expect(annotationToolbar(page)).toHaveCount(0);

    await selectVisibleText(page, finalSource, "inline_code");
    const toolbar = annotationToolbar(page);
    const addButton = toolbar.getByRole("button", { name: "Add to chat" });
    const sideChatButton = toolbar.getByRole("button", { name: "Ask in side chat" });
    await addButton.focus();
    await page.keyboard.press("ArrowRight");
    await expect(sideChatButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
    await expect(composer(page)).toBeFocused();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await selectVisibleText(page, finalSource, "Rudder docs");
    await expect.poll(async () => {
      const box = await annotationToolbar(page).boundingBox();
      if (!box) return null;
      return {
        left: Math.round(box.x),
        right: Math.round(box.x + box.width),
        buttonHeights: await annotationToolbar(page).getByRole("button").evaluateAll((buttons) =>
          buttons.map((button) => Math.round(button.getBoundingClientRect().height))),
      };
    }).toMatchObject({
      left: expect.any(Number),
      right: expect.any(Number),
      buttonHeights: [
        expect.any(Number),
        expect.any(Number),
      ],
    });
    const mobileButtonHeights = await annotationToolbar(page).getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
    expect(Math.min(...mobileButtonHeights)).toBeGreaterThanOrEqual(44);
    const mobileToolbarBox = await annotationToolbar(page).boundingBox();
    expect(mobileToolbarBox).toBeTruthy();
    expect(mobileToolbarBox!.x).toBeGreaterThanOrEqual(0);
    expect(mobileToolbarBox!.x + mobileToolbarBox!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-mobile.png`,
      fullPage: false,
      animations: "disabled",
    });
    await addSelectionToChat(page);
    const mobileDraftChip = draftAnnotationChip(page, 1);
    await mobileDraftChip.click();
    await expect(page.getByTestId("chat-response-annotation-card")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-response-annotation-card")).toHaveCount(0);
    await expect(mobileDraftChip).toBeFocused();
    await page.getByRole("button", { name: "Clear all annotations" }).click();

    await page.setViewportSize({ width: 1280, height: 820 });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.keyboard.press("Escape");
    await page.getByTestId("workspace-main-card").getByTestId("chat-side-panel-trigger").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await selectVisibleText(page, finalSource, "list target alpha");
    const narrowMainToolbarBox = await annotationToolbar(page).boundingBox();
    const mainCardBox = await page.getByTestId("workspace-main-card").boundingBox();
    expect(narrowMainToolbarBox).toBeTruthy();
    expect(mainCardBox).toBeTruthy();
    expect(narrowMainToolbarBox!.x).toBeGreaterThanOrEqual(mainCardBox!.x);
    expect(narrowMainToolbarBox!.x + narrowMainToolbarBox!.width)
      .toBeLessThanOrEqual(mainCardBox!.x + mainCardBox!.width);
    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-side-panel.png`,
      fullPage: false,
      animations: "disabled",
    });

  });

  test("never promotes an inline visual iframe or a range crossing it into an annotation source", async ({ page }) => {
    const stub = await createInlineVisualRuntimeStub();
    try {
      const orgRes = await page.request.post("/api/orgs", {
        data: { name: `Response-Annotation-Inline-Visual-${Date.now()}` },
      });
      expect(orgRes.ok(), await orgRes.text()).toBe(true);
      const organization = await orgRes.json() as {
        id: string;
        issuePrefix: string;
      };
      const agent = await createE2EChatAgent(page.request, organization.id, {
        name: "Annotation visual agent",
        agentRuntimeType: "process",
        agentRuntimeConfig: {
          command: stub.scriptPath,
          timeoutSec: 30,
        },
      }) as { id: string };
      await page.goto("/");
      await page.evaluate((orgId) => {
        localStorage.setItem("rudder.selectedOrganizationId", orgId);
      }, organization.id);
      await page.goto(
        `/${organization.issuePrefix}/messenger/chat?agentId=${encodeURIComponent(agent.id)}`,
      );
      await composer(page).fill("Render the response with an inline visual.");
      await page.getByRole("button", { name: "Send" }).click();

      const assistant = page.getByTestId("chat-assistant-message").last();
      await expect(assistant).toContainText("Selectable prose before the inline visual.", {
        timeout: 20_000,
      });
      const iframe = assistant.locator("iframe");
      await expect(iframe).toBeVisible({ timeout: 15_000 });
      await expect(iframe).toHaveAttribute("data-chat-annotation-ignore", "");
      await expect(
        iframe.contentFrame().getByText("Iframe-only evidence", { exact: true }),
      ).toBeVisible();

      const source = assistant.locator("[data-chat-annotation-source]").first();
      await selectVisibleText(
        page,
        source,
        "Selectable prose before the inline visual.",
        "Selectable prose after the inline visual.",
        { expectToolbar: false },
      );
      await expect(annotationToolbar(page)).toHaveCount(0);

      await iframe.contentFrame().getByText("Iframe-only evidence", { exact: true }).evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await expect(annotationToolbar(page)).toHaveCount(0);
    } finally {
      await rm(stub.directory, { recursive: true, force: true });
    }
  });

  test("migrates legacy drafts and preserves body, general files, annotation files, and comments after a rejected send", async ({ page }) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Recovery-${Date.now()}`);
    await page.evaluate(({ orgId, conversationId }) => {
      localStorage.setItem("rudder:chat-drafts", JSON.stringify({
        [orgId]: {
          [conversationId]: "Legacy string-only draft",
        },
      }));
    }, { orgId: seeded.organization.id, conversationId: seeded.conversationId });
    await page.reload();
    await expect(composer(page)).toHaveText("Legacy string-only draft", {
      timeout: 30_000,
    });

    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await selectVisibleText(page, finalSource, "Rudder docs");
    await addSelectionToChat(page);
    await editAnnotation(page, 1, {
      comment: "Keep my recovery comment.",
      files: [{
        name: "recover-annotation.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("annotation recovery"),
      }],
    });
    await composer(page).fill("Keep this body after failure");
    const generalFileInput = page.locator('input[type="file"]').first();
    await generalFileInput.setInputFiles({
      name: "recover-general.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("general recovery"),
    });
    await expect(page.getByTestId("chat-pending-attachments")).toContainText("recover-general.txt");

    let rejectedRequests = 0;
    await page.route(`**/api/chats/${seeded.conversationId}/messages/stream`, async (route) => {
      rejectedRequests += 1;
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "Annotation source was rejected for recovery testing." }),
      });
    });
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => rejectedRequests).toBe(1);
    await expect(page.getByText("Annotation source was rejected for recovery testing.")).toBeVisible();
    await expect(composer(page)).toHaveText("Keep this body after failure");
    await expect(page.getByTestId("chat-pending-attachments")).toContainText("recover-general.txt");
    await expect(draftAnnotationChip(page, 1)).toBeVisible();
    await expandDraftAnnotations(page, 1);
    const draftCard = page.getByTestId("chat-response-annotation-card");
    await expect(draftCard).toContainText("Keep my recovery comment.");
    await expect(draftCard).toContainText("recover-annotation.txt");

    await page.reload();
    await expect(composer(page)).toHaveText("Keep this body after failure");
    await expect(draftAnnotationChip(page, 1)).toBeVisible();
    await expandDraftAnnotations(page, 1);
    await expect(page.getByTestId("chat-response-annotation-card")).toContainText(
      "Keep my recovery comment.",
    );
    // Browser File objects are intentionally session-only. The durable quote/comment survives,
    // while both pending file pickers remain unsent until the operator reattaches them.
    await expect(page.getByTestId("chat-pending-attachments")).toHaveCount(0);
    await expect(page.getByTestId("chat-response-annotation-pending-attachment")).toHaveCount(0);
  });

  test("keeps immutable annotations through message edit and remaps their source and files in a UI Fork", async ({ page }) => {
    test.setTimeout(120_000);
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Edit-Fork-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await selectVisibleText(page, finalSource, "Rudder docs");
    await addSelectionToChat(page);
    await editAnnotation(page, 1, {
      comment: "Carry this exact evidence through edit and Fork.",
      files: [{
        name: "edit-fork-annotation.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("immutable edit and fork evidence"),
      }],
    });
    await composer(page).fill("Original annotated edit body");
    await page.getByRole("button", { name: "Send" }).click();

    const originalTurn = page
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: "Original annotated edit body" });
    await expect(originalTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }),
    ).toBeVisible({ timeout: 20_000 });

    const originalMessagesResponse = await page.request.get(
      `/api/chats/${seeded.conversationId}/messages`,
    );
    expect(originalMessagesResponse.ok(), await originalMessagesResponse.text()).toBe(true);
    const originalMessages = await originalMessagesResponse.json() as Array<{
      id: string;
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          id: string;
          sourceMessageId: string;
          attachmentIds: string[];
        }>;
      } | null;
    }>;
    const originalAnnotatedMessage = originalMessages.find((message) => (
      message.role === "user" && message.body === "Original annotated edit body"
    ));
    const originalAnnotation = originalAnnotatedMessage
      ?.structuredPayload
      ?.inlineAnnotations
      ?.[0];
    expect(originalAnnotatedMessage).toBeTruthy();
    expect(originalAnnotation).toMatchObject({
      sourceMessageId: seeded.assistantMessageId,
      attachmentIds: [expect.any(String)],
    });
    const completedReply = [...originalMessages].reverse().find((message) => (
      message.role === "assistant"
      && message.id !== seeded.assistantMessageId
      && message.body === "Streaming reply for chat."
    ));
    expect(completedReply).toBeTruthy();

    await e2eDb
      .update(chatMessages)
      .set({ status: "failed" })
      .where(eq(chatMessages.id, completedReply!.id));
    await page.reload();
    const failedReply = page.locator(
      `[data-testid="chat-assistant-message"][data-message-id="${completedReply!.id}"]`,
    );
    await expect(failedReply.getByRole("button", { name: "Retry" }))
      .toBeVisible({ timeout: 15_000 });
    await failedReply.getByRole("button", { name: "Retry" }).click();

    const retriedTurn = page
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: "Original annotated edit body" });
    await expect(retriedTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("2/2")).toBeVisible({ timeout: 15_000 });
    const retriedCard = await expandSentAnnotations(page, retriedTurn, 1);
    await expect(retriedCard).toContainText("Carry this exact evidence through edit and Fork.");
    await expect(retriedCard.getByText("edit-fork-annotation.txt")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("chat-assistant-message").filter({ hasText: "Streaming reply for chat." }).last(),
    ).toBeVisible({ timeout: 20_000 });

    const originalBubble = retriedTurn.getByTestId("chat-user-message-bubble");
    await originalBubble.hover();
    await retriedTurn.getByRole("button", { name: "Edit message" }).click();
    const inlineEditor = page.getByTestId("chat-inline-message-editor");
    await expect(inlineEditor).toBeVisible();
    await inlineEditor
      .locator(".rudder-mdxeditor-content")
      .fill("Edited annotated edit body");
    await inlineEditor.getByRole("button", { name: "Send" }).click();

    const editedTurn = page
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: "Edited annotated edit body" });
    await expect(editedTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("chat-user-message-turn").filter({ hasText: "Original annotated edit body" }),
    ).toHaveCount(0);
    const editedCard = await expandSentAnnotations(page, editedTurn, 1);
    await expect(editedCard).toContainText("Carry this exact evidence through edit and Fork.");
    await expect(editedCard.getByText("edit-fork-annotation.txt")).toBeVisible();
    await page.keyboard.press("Escape");

    const branchAssistant = page
      .getByTestId("chat-assistant-message")
      .filter({ hasText: "Streaming reply for chat." })
      .last();
    await expect(branchAssistant).toBeVisible({ timeout: 20_000 });
    await branchAssistant.hover();
    const forkResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${seeded.conversationId}/fork`)
    ));
    await branchAssistant.getByRole("button", { name: "Fork from here" }).click();
    const forkResponse = await forkResponsePromise;
    expect(forkResponse.ok(), await forkResponse.text()).toBe(true);
    const forkedConversation = await forkResponse.json() as { id: string };
    await expect(page).toHaveURL(
      new RegExp(`/messenger/chat/${forkedConversation.id}$`),
      { timeout: 15_000 },
    );

    const forkedTurn = page
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: "Edited annotated edit body" });
    await expect(forkedTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });
    const forkedCard = await expandSentAnnotations(page, forkedTurn, 1);
    await expect(forkedCard).toContainText("Carry this exact evidence through edit and Fork.");
    await expect(forkedCard.getByText("edit-fork-annotation.txt")).toBeVisible();

    const forkMessagesResponse = await page.request.get(
      `/api/chats/${forkedConversation.id}/messages`,
    );
    expect(forkMessagesResponse.ok(), await forkMessagesResponse.text()).toBe(true);
    const forkMessages = await forkMessagesResponse.json() as Array<{
      id: string;
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          id: string;
          sourceConversationId: string;
          sourceMessageId: string;
          attachmentIds: string[];
        }>;
      } | null;
      attachments: Array<{ id: string; originalFilename: string | null }>;
    }>;
    const forkedAnnotatedMessage = forkMessages.find((message) => (
      message.role === "user" && message.body === "Edited annotated edit body"
    ));
    const forkedAnnotation = forkedAnnotatedMessage
      ?.structuredPayload
      ?.inlineAnnotations
      ?.[0];
    expect(forkedAnnotation).toMatchObject({
      id: originalAnnotation!.id,
      sourceConversationId: forkedConversation.id,
      attachmentIds: [expect.any(String)],
    });
    expect(forkedAnnotation!.sourceMessageId).not.toBe(seeded.assistantMessageId);
    expect(forkedAnnotation!.attachmentIds[0]).not.toBe(originalAnnotation!.attachmentIds[0]);
    expect(forkedAnnotatedMessage!.attachments).toEqual([
      expect.objectContaining({
        id: forkedAnnotation!.attachmentIds[0],
        originalFilename: "edit-fork-annotation.txt",
      }),
    ]);

    await forkedCard
      .getByTestId("chat-response-annotation-sent-card-entry")
      .getByRole("button", { name: "Show source" })
      .click();
    const forkedSource = annotationSource(page, {
      messageId: forkedAnnotation!.sourceMessageId,
      surface: "assistant_body",
    });
    await expect(forkedSource).toBeVisible({ timeout: 15_000 });
    await expect(forkedSource).toHaveClass(/chat-message-jump-highlight/);
  });

  test("carries annotation count and provenance through Queue edit and Steer delivery", async ({ page }) => {
    test.setTimeout(120_000);
    const seeded = await seedAnnotationChat(
      page,
      `Response-Annotation-Queue-${Date.now()}`,
      { nativeSteerRuntime: true },
    );
    await composer(page).fill("Keep Steer message position stable");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(async () => {
      const response = await page.request.get(`/api/chats/${seeded.conversationId}/queue`);
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json() as { activeGenerationStatus: string | null })
        .activeGenerationStatus;
    }, { timeout: 15_000 }).toMatch(/starting|running/);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await selectVisibleText(page, finalSource, "第一段包含");
    await addSelectionToChat(page);
    await editAnnotation(page, 1, {
      comment: "Keep this staged evidence with Queue and Steer.",
      files: [{
        name: "queue-annotation-evidence.png",
        mimeType: "image/png",
        buffer: ONE_BY_ONE_PNG,
      }],
    });
    await composer(page).fill("Use the annotated list item for the next turn");
    await composer(page).press("Enter");

    const queueItem = page.getByTestId("chat-running-queue-item").first();
    await expect(queueItem).toContainText("Use the annotated list item for the next turn");
    await expect(queueItem).toContainText("1 annotation");
    const queueRes = await page.request.get(`/api/chats/${seeded.conversationId}/queue`);
    expect(queueRes.ok(), await queueRes.text()).toBe(true);
    const queue = await queueRes.json() as {
      items: Array<{
        id: string;
        annotationCount: number;
        payload: {
          body: string;
          inlineAnnotations?: Array<{
            sourceMessageId: string;
            selectedText: string;
            comment: string | null;
            attachmentIds: string[];
          }>;
        };
      }>;
    };
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.annotationCount).toBe(1);
    expect(queue.items[0]!.payload.inlineAnnotations).toEqual([
      expect.objectContaining({
        sourceMessageId: seeded.assistantMessageId,
        selectedText: "第一段包含",
        comment: "Keep this staged evidence with Queue and Steer.",
        // Queue storage keeps uploaded files in a private asset envelope until
        // delivery creates the owning user message and attachment records.
        attachmentIds: [],
      }),
    ]);
    expect(JSON.stringify(queue)).not.toMatch(
      /assetId|objectKey|staged(?:Asset|Attachment|File|Object)|private(?:Asset|Attachment|File|Object)|queue-annotation-evidence\.png/i,
    );

    await queueItem.getByRole("button", { name: "Edit queued message" }).click();
    await page.getByTestId("chat-running-queue-edit").fill(
      "Edited Queue body keeps its annotation",
    );
    await queueItem.getByRole("button", { name: "Save" }).click();
    await expect(queueItem).toContainText("1 annotation");
    const editedQueueRes = await page.request.get(`/api/chats/${seeded.conversationId}/queue`);
    expect(editedQueueRes.ok(), await editedQueueRes.text()).toBe(true);
    const editedQueue = await editedQueueRes.json() as typeof queue;
    expect(editedQueue.items[0]!.annotationCount).toBe(1);
    expect(editedQueue.items[0]!.payload.inlineAnnotations).toEqual([
      expect.objectContaining({
        sourceMessageId: seeded.assistantMessageId,
        comment: "Keep this staged evidence with Queue and Steer.",
        attachmentIds: [],
      }),
    ]);
    expect(JSON.stringify(editedQueue)).not.toMatch(
      /assetId|objectKey|staged(?:Asset|Attachment|File|Object)|private(?:Asset|Attachment|File|Object)|queue-annotation-evidence\.png/i,
    );
    await queueItem.getByRole("button", { name: "Steer" }).click();

    const deliveredTurn = page
      .getByTestId("chat-transcript-steer-message")
      .filter({ hasText: "Edited Queue body keeps its annotation" });
    await expect(deliveredTurn).toBeVisible({ timeout: 30_000 });
    // The native Steer bubble first appears in the live transcript and is then
    // remounted from persisted history. Assert the immutable card only after
    // that handoff so the test exercises the stable, refreshable UI.
    await expect(page.getByRole("button", { name: "Stop streaming" }))
      .toHaveCount(0, { timeout: 30_000 });
    const steeredAssistant = page.getByTestId("chat-assistant-message").last();
    await expect(steeredAssistant).toContainText(
      "User-provided response annotations",
    );
    await expect(steeredAssistant).toContainText("第一段包含");
    await expect(steeredAssistant).toContainText(
      "Keep this staged evidence with Queue and Steer.",
    );
    await expect(steeredAssistant).toContainText(
      "Native steer image received: true",
    );
    await expect(deliveredTurn).toBeVisible({ timeout: 30_000 });
    await expect(deliveredTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible();
    const deliveredCard = await expandSentAnnotations(page, deliveredTurn, 1);
    const deliveredAnnotation = deliveredCard
      .getByTestId("chat-response-annotation-sent-card-entry");
    await expect(deliveredAnnotation).toContainText(
      "Keep this staged evidence with Queue and Steer.",
    );
    await expect(deliveredAnnotation.getByTestId("chat-annotation-image-attachment"))
      .toBeVisible();
    await expect(deliveredCard.getByRole("button", { name: /Edit annotation|Delete annotation/ }))
      .toHaveCount(0);
    await expect(page.getByTestId("chat-running-queue")).toHaveCount(0, { timeout: 30_000 });

    const messagesRes = await page.request.get(`/api/chats/${seeded.conversationId}/messages`);
    expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
    const messages = await messagesRes.json() as Array<{
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          sourceMessageId: string;
          attachmentIds: string[];
        }>;
      } | null;
      attachments: Array<{ id: string; originalFilename: string | null }>;
    }>;
    const deliveredMessage = messages.find((message) => (
      message.role === "user"
      && message.body === "Edited Queue body keeps its annotation"
    ));
    expect(deliveredMessage).toEqual(expect.objectContaining({
      structuredPayload: expect.objectContaining({
        inlineAnnotations: [expect.objectContaining({
          sourceMessageId: seeded.assistantMessageId,
          attachmentIds: [expect.any(String)],
        })],
      }),
    }));
    const deliveredAttachmentId =
      deliveredMessage!.structuredPayload!.inlineAnnotations![0]!.attachmentIds[0]!;
    expect(deliveredMessage!.attachments).toEqual([
      expect.objectContaining({
        id: deliveredAttachmentId,
        originalFilename: "queue-annotation-evidence.png",
      }),
    ]);
  });

  test("opens a provisional Side Chat from an exact annotation without touching the main draft", async ({ page }) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Side-${Date.now()}`);
    await composer(page).fill("Keep this unfinished main-chat draft");
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await selectVisibleText(page, finalSource, "Rudder docs");
    await annotationToolbar(page).getByRole("button", { name: "Ask in side chat" }).click();

    const panel = page.getByTestId("chat-side-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("side-chat-anchor-preview")).toContainText("Rudder docs");
    await expect(panel.getByTestId("side-chat-anchor-preview")).not.toContainText("list target beta");
    await expect(panel.getByRole("button", { name: "Show 1 annotation" })).toBeVisible();
    await expect(composer(page)).toHaveText("Keep this unfinished main-chat draft");

    await panel.getByRole("button", { name: "Show 1 annotation" }).click();
    const provisionalCard = page.getByTestId("chat-response-annotation-card");
    await expect(provisionalCard).toBeVisible();
    await provisionalCard.hover();
    await provisionalCard.getByRole("button", { name: "Edit annotation 1" }).click();
    const provisionalEditor = page.getByTestId("chat-response-annotation-editor");
    await expect(provisionalEditor).toBeVisible();
    await expect(provisionalEditor).toContainText("Selected text:");
    await expect(provisionalEditor).toContainText("Rudder docs");
    await provisionalEditor
      .getByPlaceholder("Add an optional comment…")
      .fill("Side Chat owns this comment and evidence.");
    await provisionalEditor.getByLabel("Add images or files").setInputFiles({
      name: "side-chat-annotation-evidence.png",
      mimeType: "image/png",
      buffer: ONE_BY_ONE_PNG,
    });
    await expect(
      provisionalEditor.getByTestId("chat-response-annotation-pending-attachment"),
    ).toHaveCount(1);
    await provisionalEditor.getByRole("button", { name: "Save", exact: true }).click();

    const sideComposer = panel
      .getByTestId("side-chat-composer")
      .locator(".rudder-mdxeditor-content")
      .first();
    await sideComposer.fill("Explain this exact source in isolation.");
    const createSideChat = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${seeded.conversationId}/side-chats`)
    ));
    const firstSideMessageRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && /\/api\/chats\/[^/]+\/messages\/stream$/.test(request.url())
      && !request.url().includes(`/api/chats/${seeded.conversationId}/messages/stream`)
    ));
    const sideSendButton = panel.getByRole("button", { name: "Send Side Chat message" });
    await sideSendButton.click();
    const createResponse = await createSideChat;
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
    const sideChat = await createResponse.json() as { id: string };
    const sideMessageRequest = await firstSideMessageRequest;
    expect(sideMessageRequest.url()).toContain(`/api/chats/${sideChat.id}/messages/stream`);
    expect(sideMessageRequest.headers()["content-type"]).toContain("multipart/form-data");
    await expect(panel.getByTestId("side-chat-messages")).toContainText(
      "Explain this exact source in isolation.",
      { timeout: 15_000 },
    );
    const sentSideTurn = panel
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: "Explain this exact source in isolation." });
    await expect(sentSideTurn.getByRole("button", { name: "Show 1 annotation" })).toBeVisible();
    const sentSideCard = await expandSentAnnotations(page, sentSideTurn, 1);
    const sentSideAnnotation = sentSideCard
      .getByTestId("chat-response-annotation-sent-card-entry");
    await expect(sentSideAnnotation).toContainText(
      "Side Chat owns this comment and evidence.",
    );
    await expect(sentSideAnnotation.getByTestId("chat-annotation-image-attachment")).toBeVisible();
    await expect(
      sentSideCard.getByRole("button", { name: /Edit annotation|Delete annotation/ }),
    ).toHaveCount(0);
    await expect(composer(page)).toHaveText("Keep this unfinished main-chat draft");

    const sideMessagesRes = await page.request.get(`/api/chats/${sideChat.id}/messages`);
    expect(sideMessagesRes.ok(), await sideMessagesRes.text()).toBe(true);
    const sideMessages = await sideMessagesRes.json() as Array<{
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          sourceConversationId: string;
          sourceMessageId: string;
          selectedText: string;
          comment: string | null;
          attachmentIds: string[];
        }>;
      } | null;
      attachments: Array<{ id: string; originalFilename: string | null }>;
    }>;
    const sentSideMessage = sideMessages.find((message) => (
      message.role === "user"
      && message.body === "Explain this exact source in isolation."
    ));
    expect(sentSideMessage).toEqual(expect.objectContaining({
      role: "user",
      body: "Explain this exact source in isolation.",
      structuredPayload: expect.objectContaining({
        inlineAnnotations: [expect.objectContaining({
          sourceConversationId: seeded.conversationId,
          sourceMessageId: seeded.assistantMessageId,
          selectedText: "Rudder docs",
          comment: "Side Chat owns this comment and evidence.",
          attachmentIds: [expect.any(String)],
        })],
      }),
    }));
    const sideAttachmentId =
      sentSideMessage!.structuredPayload!.inlineAnnotations![0]!.attachmentIds[0]!;
    expect(sentSideMessage!.attachments).toEqual([
      expect.objectContaining({
        id: sideAttachmentId,
        originalFilename: "side-chat-annotation-evidence.png",
      }),
    ]);
  });
});
