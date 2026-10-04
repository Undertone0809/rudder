import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatMessageTranscriptEntries,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
  runtimeSourceAliases,
} from "../../packages/db/src/index.ts";
import type { ChatMessage } from "../../packages/shared/src/index.ts";
import { nativeForkContentHash } from "../../server/src/services/chats.native-fork-aliases.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import {
  E2E_CODEX_APP_SERVER_STUB,
  E2E_CODEX_STUB,
  E2E_DATABASE_URL,
  E2E_ROOT,
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
const ORDERED_LIST_BODY = [
  "## 现在必须由你做的",
  "",
  "1. 确认未来 7 天采用上面的用户获取 Goal。",
  "2. 从 X 候选中选择并亲自回复约 20 条。",
  "3. 恢复 Desktop Browser，在 Apps 中注册并打开任务树 App。",
  "4. 决定 Goal 系统是否成为下一条产品主线。",
  "5. 给现金流/兼职事项一个明确状态：继续、已解决或延期。",
].join("\n");
const FIRST_PROCESS_TEXT = "可见 Thinking 过程：先核对数据与用户约束。";
const SECOND_PROCESS_TEXT = "第二个 Thinking 区块：再比较稳定证据。";
const NATIVE_REASONING_TEXT = "Native reasoning fixture: stable visible thinking source.";
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

type SeededNativeAnnotationChat = {
  organization: SeededAnnotationChat["organization"];
  agent: { id: string };
  conversationId: string;
  assistantMessageId: string;
  runId: string;
};

function sourceHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createBlockingCountingChatRuntime(outputDir: string) {
  const directory = join(outputDir, "pre-generation-retry-runtime");
  await mkdir(directory, { recursive: true });
  const scriptPath = join(directory, "codex-retry-gated.sh");
  const invocationPath = join(directory, "invocations");
  const releasePath = join(directory, "release-provider");
  await writeFile(invocationPath, "", "utf8");
  await writeFile(scriptPath, `#!/bin/sh
set -eu
case " $* " in
  *" --version "*|*" generate-json-schema "*) exec "${E2E_CODEX_APP_SERVER_STUB}" "$@" ;;
esac
printf '%s\\n' "$*" >> "${invocationPath}"
while [ ! -f "${releasePath}" ]; do sleep 0.05; done
exec "${E2E_CODEX_APP_SERVER_STUB}" "$@"
`, "utf8");
  await chmod(scriptPath, 0o755);
  return { scriptPath, invocationPath, releasePath };
}

type CapturedChatMutationPart =
  | { kind: "field"; name: string; value: string }
  | { kind: "file"; name: string; fileName: string; mimeType: string; lastModified: number; bytes: number[] };

type CapturedChatMutation =
  | { kind: "json"; body: string }
  | { kind: "multipart"; parts: CapturedChatMutationPart[] };

async function installChatMutationCapture(page: Page, mutationPath: string) {
  await page.evaluate((path) => {
    type Part =
      | { kind: "field"; name: string; value: string }
      | { kind: "file"; name: string; fileName: string; mimeType: string; lastModified: number; bytes: number[] };
    type Mutation = { kind: "json"; body: string } | { kind: "multipart"; parts: Part[] };
    const target = window as Window & { __rudderCapturedChatMutations?: Mutation[] };
    target.__rudderCapturedChatMutations = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && new URL(requestUrl, window.location.href).pathname === path) {
        if (init?.body instanceof FormData) {
          const parts = await Promise.all(Array.from(init.body.entries()).map(async ([name, value]) => {
            if (value instanceof File) {
              return {
                kind: "file" as const,
                name,
                fileName: value.name,
                mimeType: value.type,
                lastModified: value.lastModified,
                bytes: Array.from(new Uint8Array(await value.arrayBuffer())),
              };
            }
            return { kind: "field" as const, name, value };
          }));
          target.__rudderCapturedChatMutations?.push({ kind: "multipart", parts });
        } else if (typeof init?.body === "string") {
          target.__rudderCapturedChatMutations?.push({ kind: "json", body: init.body });
        }
      }
      return originalFetch(input, init);
    };
  }, mutationPath);
}

async function readChatMutationCaptures(page: Page): Promise<CapturedChatMutation[]> {
  return page.evaluate(() => {
    const target = window as Window & { __rudderCapturedChatMutations?: CapturedChatMutation[] };
    return target.__rudderCapturedChatMutations ?? [];
  });
}

async function replayCapturedChatMutation(
  page: Page,
  mutationPath: string,
  mutation: CapturedChatMutation,
) {
  return page.evaluate(async ({ path, captured }) => {
    let body: BodyInit;
    const headers: Record<string, string> = {};
    if (captured.kind === "json") {
      body = captured.body;
      headers["content-type"] = "application/json";
    } else {
      const form = new FormData();
      for (const part of captured.parts) {
        if (part.kind === "field") {
          form.append(part.name, part.value);
        } else {
          const file = new File(
            [new Uint8Array(part.bytes)],
            part.fileName,
            { type: part.mimeType, lastModified: part.lastModified },
          );
          form.append(part.name, file, part.fileName);
        }
      }
      body = form;
    }
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers,
      body,
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  }, { path: mutationPath, captured: mutation });
}

async function failFirstChatUserActivityWrite(orgId: string, conversationId: string) {
  const suffix = conversationId.replaceAll("-", "").slice(0, 20);
  const functionName = `e2e_fail_first_chat_user_activity_${suffix}`;
  const triggerName = `e2e_fail_first_chat_user_activity_${suffix}`;
  const sequenceName = `e2e_chat_user_activity_attempt_${suffix}`;
  await e2eDb.execute(sql.raw(`CREATE SEQUENCE ${sequenceName} START WITH 1`));
  await e2eDb.execute(sql.raw(`
    CREATE FUNCTION ${functionName}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.org_id = '${orgId}'::uuid
        AND NEW.entity_type = 'chat'
        AND NEW.entity_id = '${conversationId}'
        AND NEW.action = 'chat.message_added'
        AND NEW.details->>'role' = 'user' THEN
        IF nextval('${sequenceName}') = 1 THEN
          RAISE EXCEPTION 'E2E one-shot post-commit user activity failure';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
  `));
  await e2eDb.execute(sql.raw(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON activity_log
    FOR EACH ROW EXECUTE FUNCTION ${functionName}();
  `));
  return async () => {
    await e2eDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON activity_log`));
    await e2eDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    await e2eDb.execute(sql.raw(`DROP SEQUENCE IF EXISTS ${sequenceName}`));
  };
}

async function seedAnnotationChat(
  page: Page,
  name: string,
  options: {
    nativeSteerRuntime?: boolean;
    runtimeCommand?: string;
    runtimeReplyBody?: string;
    finalBody?: string;
    readyText?: string;
  } = {},
): Promise<SeededAnnotationChat> {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as SeededAnnotationChat["organization"];
  const agent = await createE2EChatAgent(
    page.request,
    organization.id,
    options.runtimeCommand
      ? {
        name: "Annotation Agent",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: options.runtimeCommand,
          chatAppServerEnabled: true,
          ...(options.runtimeReplyBody ? {
            env: { RUDDER_E2E_CODEX_REPLY_BODY: options.runtimeReplyBody },
          } : {}),
        },
      }
      : options.nativeSteerRuntime
      ? {
        name: "Annotation Agent",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: join(E2E_ROOT, "fixtures", "codex-native-session.mjs"),
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
  const finalBody = options.finalBody ?? FINAL_BODY;
  const readyText = options.readyText ?? "Rudder docs";

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
      body: finalBody,
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
    frozenBodyHash: sourceHash(finalBody),
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
  ).toContainText(readyText, { timeout: 30_000 });

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

async function selectFromTextToNextBlockStart(
  page: Page,
  root: Locator,
  startNeedle: string,
  endNeedle: string,
) {
  await root.evaluate((sourceRoot, selection) => {
    const findText = (needle: string) => {
      const walker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const element = node.parentElement;
          return element?.closest("[data-chat-annotation-ignore]")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const offset = text.indexOf(needle);
        if (offset >= 0) return { node, offset };
      }
      throw new Error(`Could not find block-boundary selection text: ${needle}`);
    };
    const start = findText(selection.startNeedle);
    const end = findText(selection.endNeedle);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const browserSelection = window.getSelection();
    browserSelection?.removeAllRanges();
    browserSelection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    sourceRoot.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { startNeedle, endNeedle });
  await expect(annotationToolbar(page)).toBeVisible({ timeout: 5_000 });
}

async function gateAnnotationSourceDigests(page: Page) {
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __releaseAnnotationDigest?: (index: number) => void;
      __annotationDigestCount?: () => number;
    };
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const releases: Array<() => void> = [];
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: (...args: Parameters<SubtleCrypto["digest"]>) => new Promise<ArrayBuffer>(
        (resolve, reject) => {
          void originalDigest(...args).then(
            (result) => releases.push(() => resolve(result)),
            reject,
          );
        },
      ),
    });
    runtime.__releaseAnnotationDigest = (index) => releases[index]?.();
    runtime.__annotationDigestCount = () => releases.length;
  });
}

async function waitForAnnotationSourceDigest(page: Page, count: number) {
  await expect.poll(() => annotationSourceDigestCount(page)).toBe(count);
}

async function annotationSourceDigestCount(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __annotationDigestCount?: () => number }
  ).__annotationDigestCount?.() ?? 0);
}

async function releaseAnnotationSourceDigest(page: Page, index: number) {
  await page.evaluate((releaseIndex) => (
    window as typeof window & { __releaseAnnotationDigest?: (index: number) => void }
  ).__releaseAnnotationDigest?.(releaseIndex), index);
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

async function expectToolbarNearSelection(
  page: Page,
  selection: SelectionGeometry,
) {
  await expect.poll(async () => {
    const box = await annotationToolbar(page).boundingBox();
    if (!box) return null;
    const toolbarCenterX = box.x + box.width / 2;
    const selectionCenterX = selection.bounds.x + selection.bounds.width / 2;
    const verticalGap = Math.min(
      Math.abs(box.y + box.height - selection.bounds.y),
      Math.abs(box.y - selection.bounds.bottom),
    );
    return {
      horizontalDistance: Math.round(Math.abs(toolbarCenterX - selectionCenterX)),
      verticalGap: Math.round(verticalGap),
    };
  }).toEqual({
    horizontalDistance: expect.any(Number),
    verticalGap: expect.any(Number),
  });
  const box = await annotationToolbar(page).boundingBox();
  expect(box).toBeTruthy();
  const toolbarCenterX = box!.x + box!.width / 2;
  const selectionCenterX = selection.bounds.x + selection.bounds.width / 2;
  expect(Math.abs(toolbarCenterX - selectionCenterX))
    .toBeLessThanOrEqual(box!.width / 2 + selection.bounds.width / 2 + 24);
  expect(Math.min(
    Math.abs(box!.y + box!.height - selection.bounds.y),
    Math.abs(box!.y - selection.bounds.bottom),
  )).toBeLessThanOrEqual(48);
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
  test("annotates a native Chat thinking entry through Reader validation", async ({ page }) => {
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Response-Annotation-Native-Only-${Date.now()}` },
    });
    expect(orgResponse.ok(), await orgResponse.text()).toBe(true);
    const organization = await orgResponse.json() as SeededNativeAnnotationChat["organization"];
    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "Native Annotation Agent",
      command: join(E2E_ROOT, "fixtures", "codex-native-session.mjs"),
    }) as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agent.id}`);
    await composer(page).fill("Native annotation reasoning fixture marker. Create a stable native reply.");
    const nativeStream = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith("/messages/stream")
    ));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await (await nativeStream).finished();
    const sourceAssistant = page.getByTestId("chat-assistant-message").last();
    await expect(sourceAssistant).toContainText("Native reply 1", { timeout: 30_000 });
    const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    const assistantMessageId = await sourceAssistant.getAttribute("data-message-id");
    expect(assistantMessageId).toBeTruthy();

    const sourceRuns = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, conversationId));
    expect(sourceRuns).toHaveLength(1);
    const run = sourceRuns[0]!;
    expect(run.agentId).toBe(agent.id);
    expect(run.status).toBe("succeeded");
    expect(run.contextSnapshot).toMatchObject({ transcriptSource: "native" });
    const seeded: SeededNativeAnnotationChat = {
      organization,
      agent,
      conversationId,
      assistantMessageId: assistantMessageId!,
      runId: run.id,
    };

    const [assistantRow] = await e2eDb.select().from(chatMessages)
      .where(eq(chatMessages.id, seeded.assistantMessageId));
    expect(assistantRow?.runId).toBe(seeded.runId);
    const sourceSpans = await e2eDb.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, seeded.runId));
    expect(sourceSpans.length).toBeGreaterThan(0);
    const span = sourceSpans[0];
    if (!span) throw new Error("Expected the native Chat Run to have a bound runtime span");
    expect(span).toMatchObject({ orgId: organization.id, runId: seeded.runId });
    expect(span.supplementalObjectRef).toEqual(expect.any(String));
    // Native Reader provenance does not prove supplement coverage; retain its recovery pointer.
    expect(run.contextSnapshot).toMatchObject({
      nativeTranscriptRetention: {
        status: "cleanup_failed",
        reason: "supplement_native_coverage_unproven",
        retryCount: 1,
        recovery: expect.arrayContaining([
          expect.objectContaining({
            kind: "transcript_supplement",
            objectRef: span.supplementalObjectRef,
            spanId: span.id,
          }),
        ]),
      },
    });
    const [binding] = await e2eDb.select().from(runtimeBindings)
      .where(eq(runtimeBindings.id, span.bindingId));
    if (!binding) throw new Error("Expected the native Run span to reference its Chat binding");
    expect(binding).toMatchObject({
      id: span.bindingId,
      orgId: organization.id,
      conversationId: seeded.conversationId,
    });
    const [segment] = await e2eDb.select().from(nativeSegments)
      .where(eq(nativeSegments.id, span.segmentId));
    expect(segment).toMatchObject({ id: span.segmentId, bindingId: binding.id, orgId: organization.id });

    const readerResponse = await page.request.get(
      `/api/run-intelligence/runs/${seeded.runId}/transcript?output=full&order=oldest&turnLimit=50&includeOutput=false&maxChars=4000`,
    );
    expect(readerResponse.ok(), await readerResponse.text()).toBe(true);
    const readerPage = await readerResponse.json() as {
      source?: string;
      availability?: string;
      completeness?: string;
      entries?: Array<{
        sourceEntryId?: string;
        entry?: {
          kind?: string;
          text?: string;
          sourceEntryId?: string;
          generationId?: string;
          generationSeqStart?: number;
          generationSeqEnd?: number;
        };
      }>;
    };
    expect(readerPage.source).toBe("native");
    expect(readerPage.availability).toBe("available");
    expect(readerPage.completeness).toBe("complete");
    // Use the real Reader projection, not an intercepted or reconstructed entry.
    const readerEntry = readerPage.entries?.find((candidate) => (
      candidate.entry?.kind === "thinking"
      && candidate.entry.text === NATIVE_REASONING_TEXT
    ));
    expect(readerEntry?.sourceEntryId).toEqual(expect.any(String));
    const sourceEntryId = readerEntry!.sourceEntryId!;
    expect(readerEntry?.entry?.sourceEntryId).toBe(sourceEntryId);
    expect(readerEntry?.entry).not.toHaveProperty("generationId");
    expect(readerEntry?.entry).not.toHaveProperty("generationSeqStart");
    expect(readerEntry?.entry).not.toHaveProperty("generationSeqEnd");

    const runEvents = await e2eDb.select({ eventType: heartbeatRunEvents.eventType })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seeded.runId));
    expect(runEvents.some((event) => event.eventType === "transcript.entry")).toBe(false);
    const sourceGenerations = await e2eDb.select({ id: chatGenerations.id })
      .from(chatGenerations).where(eq(chatGenerations.conversationId, seeded.conversationId));
    expect(sourceGenerations.length).toBeGreaterThan(0);
    const generationEvents = (await Promise.all(sourceGenerations.map(({ id }) => (
      e2eDb.select({ eventKind: chatGenerationEvents.eventKind })
        .from(chatGenerationEvents).where(eq(chatGenerationEvents.generationId, id))
    )))).flat();
    expect(generationEvents.some((event) => event.eventKind === "transcript")).toBe(false);
    const legacyTranscriptRows = await e2eDb.select({ entrySeq: chatMessageTranscriptEntries.entrySeq })
      .from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.orgId, organization.id));
    expect(legacyTranscriptRows).toEqual([]);

    const processItem = sourceAssistant.locator(
      "xpath=preceding-sibling::*[@data-testid='chat-transcript-item'][1]",
    );
    const processToggle = processItem
      .getByRole("button", { name: /Worked for|Show process|Hide process/ })
      .first();
    if (await processToggle.getAttribute("aria-expanded") !== "true") {
      await processToggle.click();
    }
    const assistantBlock = processItem.locator(
      `[data-run-transcript-block="true"][data-run-transcript-block-id="${sourceEntryId}"]`,
    );
    await expect(sourceAssistant).toContainText("Native reply 1");
    await expect(assistantBlock).toHaveCount(1);
    await expect(assistantBlock).toHaveAttribute("data-run-transcript-block-stable", "true");
    await expect(assistantBlock).toHaveAttribute("data-run-transcript-block-type", "thinking");
    await expect(assistantBlock).toContainText(NATIVE_REASONING_TEXT);
    await expect(assistantBlock).not.toContainText("Native reply 1");
    await selectVisibleText(page, assistantBlock, NATIVE_REASONING_TEXT);
    await addSelectionToChat(page);
    await editAnnotation(page, 1, {
      comment: "Keep this thinking evidence tied to the native Reader source.",
    });

    const submittedBody = "Review the cited native thinking evidence.";
    const messagesPath = `/api/chats/${seeded.conversationId}/messages/stream`;
    await installChatMutationCapture(page, messagesPath);
    await composer(page).fill(submittedBody);
    await page.getByRole("button", { name: "Send" }).click();
    const sentTurn = page
      .getByTestId("chat-user-message-turn")
      .filter({ hasText: submittedBody });
    await expect(sentTurn.getByRole("button", { name: "Show 1 annotation" }))
      .toBeVisible({ timeout: 15_000 });

    const mutationCaptures = await readChatMutationCaptures(page);
    const mutation = mutationCaptures[0];
    if (mutationCaptures.length !== 1 || mutation?.kind !== "json") {
      throw new Error("Expected one captured native annotation JSON chat mutation");
    }
    const submittedMutation = JSON.parse(mutation.body) as {
      clientMutationId?: string;
      inlineAnnotations?: Array<Record<string, unknown>>;
    };
    expect(submittedMutation.inlineAnnotations).toEqual([
      expect.objectContaining({
        selectedText: NATIVE_REASONING_TEXT,
        comment: "Keep this thinking evidence tied to the native Reader source.",
        surface: "agent_run_transcript",
        sourceRunId: seeded.runId,
        sourceAgentId: seeded.agent.id,
        sourceMemberIds: [sourceEntryId],
        sourceEntryId,
      }),
    ]);

    const messagesResponse = await page.request.get(
      `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
    );
    expect(messagesResponse.ok(), await messagesResponse.text()).toBe(true);
    const messages = await messagesResponse.json() as Array<{
      id: string;
      role: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<Record<string, unknown>>;
        __chatTranscript?: unknown;
      } | null;
    }>;
    const sourceMessage = messages.find((message) => message.id === seeded.assistantMessageId);
    expect(sourceMessage?.structuredPayload ?? {}).not.toHaveProperty("__chatTranscript");
    const submittedMessage = messages.find((message) => (
      message.role === "user" && message.body === submittedBody
    ));
    expect(submittedMessage?.structuredPayload?.inlineAnnotations).toEqual([
      expect.objectContaining({
        surface: "agent_run_transcript",
        sourceRunId: seeded.runId,
        sourceAgentId: seeded.agent.id,
        sourceEntryId,
        sourceMemberIds: [sourceEntryId],
        selectedText: NATIVE_REASONING_TEXT,
        comment: "Keep this thinking evidence tied to the native Reader source.",
      }),
    ]);

    const unavailableSourceEntryId = randomUUID();
    const invalidMutation = {
      kind: "json" as const,
      body: JSON.stringify({
        ...submittedMutation,
        clientMutationId: randomUUID(),
        inlineAnnotations: submittedMutation.inlineAnnotations!.map((annotation) => ({
          ...annotation,
          sourceEntryId: unavailableSourceEntryId,
          sourceMemberIds: [unavailableSourceEntryId],
        })),
      }),
    };
    const rejectedReplay = await replayCapturedChatMutation(page, messagesPath, invalidMutation);
    expect(rejectedReplay.status, rejectedReplay.body).toBe(422);

    const messagesAfterRejectResponse = await page.request.get(
      `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
    );
    expect(messagesAfterRejectResponse.ok(), await messagesAfterRejectResponse.text()).toBe(true);
    const messagesAfterReject = await messagesAfterRejectResponse.json() as typeof messages;
    expect(messagesAfterReject.filter((message) => (
      message.role === "user" && message.body === submittedBody
    ))).toHaveLength(1);
  });

  test("keeps a real pointer selection visibly active after async anchor recovery", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(page, `Response-Selection-Stability-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    const paragraph = finalSource.getByText(
      "Second paragraph keeps the selection stable across Markdown blocks.",
      { exact: true },
    );
    await expect(finalSource).toBeVisible({ timeout: 15_000 });
    await expect(paragraph).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", {
      name: "Jump to source message for Rudder docs",
    })).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => {
      try {
        await paragraph.evaluate((element) => element.scrollIntoView({
          behavior: "instant",
          block: "center",
        }));
        return true;
      } catch {
        return false;
      }
    }).toBe(true);
    await gateAnnotationSourceDigests(page);
    await expect.poll(() => paragraph.evaluate(async (element) => {
      const before = element.getBoundingClientRect();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const after = element.getBoundingClientRect();
      return Math.max(
        Math.abs(after.x - before.x),
        Math.abs(after.y - before.y),
        Math.abs(after.width - before.width),
        Math.abs(after.height - before.height),
      );
    })).toBeLessThan(0.5);
    let pointerSelection = { collapsed: true, text: "" };
    let recoveryDigestIndex = -1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const paragraphBox = await paragraph.boundingBox();
      expect(paragraphBox).toBeTruthy();
      const y = paragraphBox!.y + Math.min(12, paragraphBox!.height / 4);
      const startX = paragraphBox!.x + 8;
      const endX = paragraphBox!.x + Math.min(paragraphBox!.width - 8, 320);
      const pointerTargets = await page.evaluate(({ startX, endX, y }) => {
        const targetText = (x: number) => document.elementFromPoint(x, y)?.textContent?.trim() ?? "";
        return { start: targetText(startX), end: targetText(endX) };
      }, { startX, endX, y });
      expect(pointerTargets.start).toContain("Second paragraph keeps the selection stable");
      expect(pointerTargets.end).toContain("Second paragraph keeps the selection stable");
      const digestCountBefore = await annotationSourceDigestCount(page);
      await page.mouse.move(startX, y);
      await page.mouse.down();
      await page.mouse.move(startX + 40, y, { steps: 4 });
      await page.waitForTimeout(16);
      await page.mouse.move(startX + 160, y, { steps: 8 });
      await page.waitForTimeout(16);
      await page.mouse.move(endX, y, { steps: 12 });
      await page.waitForTimeout(16);
      await page.mouse.up();
      pointerSelection = await page.evaluate(() => ({
        collapsed: window.getSelection()?.isCollapsed ?? true,
        text: window.getSelection()?.toString() ?? "",
      }));
      if (
        !pointerSelection.collapsed
        && pointerSelection.text.includes("paragraph keeps the selection stable")
        && !pointerSelection.text.includes("第一段包含")
      ) {
        await expect.poll(() => annotationSourceDigestCount(page)).toBeGreaterThan(digestCountBefore);
        recoveryDigestIndex = await annotationSourceDigestCount(page) - 1;
        break;
      }
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.waitForTimeout(50);
    }
    expect(pointerSelection.collapsed).toBe(false);
    expect(pointerSelection.text).toContain("paragraph keeps the selection stable");
    expect(pointerSelection.text).not.toContain("第一段包含");
    expect(recoveryDigestIndex).toBeGreaterThanOrEqual(0);

    const beforeRecovery = await page.evaluate(() => ({
      activeTestId: (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
      collapsed: window.getSelection()?.isCollapsed ?? true,
      text: window.getSelection()?.toString() ?? "",
    }));
    expect(beforeRecovery.collapsed).toBe(false);
    expect(beforeRecovery.text).toContain("paragraph keeps the selection stable");
    expect(beforeRecovery.text).not.toContain("第一段包含");

    await releaseAnnotationSourceDigest(page, recoveryDigestIndex);
    await expect(annotationToolbar(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const selection = window.getSelection();
      return {
        activeTestId: (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
        collapsed: selection?.isCollapsed ?? true,
        highlightCount: CSS.highlights.get("rudder-chat-pending-selection")?.size ?? 0,
        rangeCount: selection?.rangeCount ?? 0,
        text: selection?.toString() ?? "",
      };
    })).toEqual({
      activeTestId: beforeRecovery.activeTestId,
      collapsed: false,
      highlightCount: 1,
      rangeCount: 1,
      text: beforeRecovery.text,
    });
    await page.screenshot({
      path: testInfo.outputPath("chat-pointer-selection-stays-highlighted.png"),
      fullPage: false,
      animations: "disabled",
    });
  });

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
    await composer(page).focus();
    await expect(firstMarker).not.toBeFocused();
    await firstMarker.hover();
    const markerHoverDetails = page.getByTestId("chat-response-annotation-hover-tooltip");
    await expect(markerHoverDetails).toBeVisible();
    await expect(markerHoverDetails).toContainText("第一段包含");
    await expect(markerHoverDetails).toContainText(
      "Please verify this CJK and Markdown claim.",
    );
    await page.mouse.move(1, 1);
    await expect(markerHoverDetails).toBeHidden();
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
    const sentChip = sentTurn.getByRole("button", { name: "Show 2 annotations" });
    await expect(sentChip).toBeVisible({
      timeout: 15_000,
    });
    await expect(sentTurn.getByTestId("chat-user-message-bubble")).toHaveCount(0);
    await sentChip.hover();
    const sentHoverDetails = page.getByTestId("chat-response-annotation-hover-tooltip");
    await expect(sentHoverDetails).toBeVisible();
    await expect(sentHoverDetails).toContainText("第一段包含");
    await expect(sentHoverDetails).toContainText(
      "Please verify this CJK and Markdown claim.",
    );
    await expect(sentHoverDetails).toContainText(
      "Second paragraph keeps the selection stable across Markdown blocks.",
    );
    await page.mouse.move(1, 1);
    await expect(sentHoverDetails).toBeHidden();
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
    ).toBeVisible({ timeout: 30_000 });

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
    await expect(reloadedTurn.getByTestId("chat-user-message-bubble")).toHaveCount(0);
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

  test("sends multiple ordered-list annotations when one selection ends at the next block", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(
      page,
      `Response-Annotation-Ordered-List-${Date.now()}`,
      { finalBody: ORDERED_LIST_BODY, readyText: "现在必须由你做的" },
    );
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    const orderedItems = [
      "确认未来 7 天采用上面的用户获取 Goal。",
      "从 X 候选中选择并亲自回复约 20 条。",
      "恢复 Desktop Browser，在 Apps 中注册并打开任务树 App。",
      "决定 Goal 系统是否成为下一条产品主线。",
      "给现金流/兼职事项一个明确状态：继续、已解决或延期。",
    ];

    for (const item of orderedItems) {
      await selectVisibleText(page, finalSource, item, item);
      await addSelectionToChat(page);
    }
    await selectFromTextToNextBlockStart(
      page,
      finalSource,
      "现在必须由你做的",
      orderedItems[0]!,
    );
    await addSelectionToChat(page);
    await expect(draftAnnotationChip(page, 6)).toBeVisible();

    const streamRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes(`/api/chats/${seeded.conversationId}/messages/stream`)
    ));
    await page.getByRole("button", { name: "Send" }).click();
    await streamRequest;
    await expect(page.getByText("Failed to send message")).toHaveCount(0);

    const sentTurn = page.getByTestId("chat-user-message-turn").last();
    const sentChip = sentTurn.getByRole("button", { name: "Show 6 annotations" });
    await expect(sentChip).toBeVisible({
      timeout: 15_000,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await sentChip.hover();
    const hoverTriggerId = await sentChip
      .locator("..")
      .getAttribute("data-annotation-hover-trigger");
    expect(hoverTriggerId).toBeTruthy();
    const hoverDetails = page
      .locator(`[data-annotation-hover-content="${hoverTriggerId}"]`)
      .getByTestId("chat-response-annotation-hover-details");
    await expect(hoverDetails.first()).toContainText(orderedItems.at(-1)!);
    const scrollMetrics = await hoverDetails.evaluateAll((elements) => elements.map((element) => ({
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
    })));
    expect(scrollMetrics.some(({ clientHeight, scrollHeight }) => scrollHeight > clientHeight))
      .toBe(true);
    expect(scrollMetrics.every(({ overflowY }) => overflowY === "auto")).toBe(true);
    await sentChip.focus();
    await page.keyboard.press("End");
    await expect.poll(() => hoverDetails.evaluateAll((elements) => (
      Math.max(...elements.map((element) => element.scrollTop))
    ))).toBeGreaterThan(0);
    await page.screenshot({
      path: `/tmp/rudder-response-annotations-${testInfo.workerIndex}-ordered-list.png`,
      fullPage: false,
      animations: "disabled",
    });

    const messagesRes = await page.request.get(
      `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
    );
    expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
    const messages = await messagesRes.json() as Array<{
      role: string;
      body: string;
      structuredPayload: { inlineAnnotations?: Array<{ selectedText: string }> } | null;
    }>;
    const sentUserMessage = [...messages].reverse().find((message) => (
      message.role === "user" && message.structuredPayload?.inlineAnnotations?.length === 6
    ));
    expect(sentUserMessage).toBeTruthy();
    expect(sentUserMessage!.body).toBe("");
    expect(sentUserMessage!.structuredPayload!.inlineAnnotations!.map((annotation) => annotation.selectedText))
      .toEqual([...orderedItems, "现在必须由你做的"]);
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

  test("keeps assistant and Process toolbars anchored across source DOM replacement", async ({ page }, testInfo) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Replacement-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await gateAnnotationSourceDigests(page);
    await selectVisibleText(
      page,
      finalSource,
      "Second paragraph",
      "Second paragraph",
      { expectToolbar: false },
    );
    await waitForAnnotationSourceDigest(page, 1);
    await finalSource.evaluate((sourceRoot) => {
      sourceRoot.replaceWith(sourceRoot.cloneNode(true));
    });
    const replacedFinalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    const restoredFinalGeometry = await selectVisibleText(
      page,
      replacedFinalSource,
      "Second paragraph",
      "Second paragraph",
      { expectToolbar: false, dispatchSelection: false },
    );
    await releaseAnnotationSourceDigest(page, 0);
    await expectToolbarNearSelection(page, restoredFinalGeometry);

    await expandProcess(page, seeded.assistantMessageId);
    const processSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "process_transcript",
      text: FIRST_PROCESS_TEXT,
    });
    await selectVisibleText(
      page,
      processSource,
      "核对数据",
      "核对数据",
      { expectToolbar: false },
    );
    await waitForAnnotationSourceDigest(page, 2);
    await processSource.evaluate((sourceRoot) => {
      sourceRoot.replaceWith(sourceRoot.cloneNode(true));
    });
    const replacedProcessSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "process_transcript",
      text: FIRST_PROCESS_TEXT,
    });
    const restoredProcessGeometry = await selectVisibleText(
      page,
      replacedProcessSource,
      "核对数据",
      "核对数据",
      { expectToolbar: false, dispatchSelection: false },
    );
    await releaseAnnotationSourceDigest(page, 1);
    await expectToolbarNearSelection(page, restoredProcessGeometry);
    await page.screenshot({
      path: `/tmp/rudder-response-annotation-replacement-${testInfo.workerIndex}.png`,
      fullPage: false,
      animations: "disabled",
    });

    await replacedProcessSource.evaluate((sourceRoot) => sourceRoot.remove());
    await expect(annotationToolbar(page)).toHaveCount(0);
  });

  test("ignores an older source-hash result after a newer selection wins", async ({ page }) => {
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Race-${Date.now()}`);
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });
    await gateAnnotationSourceDigests(page);

    await selectVisibleText(
      page,
      finalSource,
      "第一段包含",
      "第一段包含",
      { expectToolbar: false },
    );
    const latestGeometry = await selectVisibleText(
      page,
      finalSource,
      "Second paragraph",
      "Second paragraph",
      { expectToolbar: false },
    );
    await waitForAnnotationSourceDigest(page, 2);
    await releaseAnnotationSourceDigest(page, 1);
    await expect(annotationToolbar(page)).toBeVisible();
    await expectToolbarNearSelection(page, latestGeometry);
    const winningBox = await annotationToolbar(page).boundingBox();

    await releaseAnnotationSourceDigest(page, 0);
    await page.waitForTimeout(50);
    expect(await annotationToolbar(page).boundingBox()).toEqual(winningBox);
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
    await expect(editor).not.toContainText("Selected excerpt");
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

  test("clips each block of a cross-container highlight to its own scrolling ancestor", async ({ page }) => {
    const seeded = await seedAnnotationChat(
      page,
      `Response-Annotation-Cross-Container-${Date.now()}`,
    );
    const finalSource = annotationSource(page, {
      messageId: seeded.assistantMessageId,
      surface: "assistant_body",
    });

    await selectVisibleText(
      page,
      finalSource,
      "Rudder docs",
      "Second paragraph keeps",
    );
    await addSelectionToChat(page);
    const highlight = finalSource.getByTestId("chat-response-annotation-highlight");
    const highlightRects = highlight.locator(":scope > span");
    await expect(highlightRects).not.toHaveCount(0);
    const initialRectCount = await highlightRects.count();
    expect(initialRectCount).toBeGreaterThan(1);

    const clippingParagraph = finalSource.locator("p")
      .filter({ hasText: "Rudder docs" })
      .first();
    await clippingParagraph.evaluate((element) => {
      Object.assign(element.style, {
        overflowX: "auto",
        whiteSpace: "nowrap",
        width: "120px",
      });
      element.scrollLeft = element.scrollWidth;
    });
    await expect.poll(() => highlightRects.count()).toBeLessThan(initialRectCount);
    const paragraphBox = await clippingParagraph.boundingBox();
    expect(paragraphBox).toBeTruthy();
    const visibleRects = await highlightRects.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    }));
    const firstBlockRects = visibleRects.filter((rect) => (
      rect.top < paragraphBox!.y + paragraphBox!.height
      && rect.bottom > paragraphBox!.y
    ));
    expect(firstBlockRects.every((rect) => (
      rect.left >= paragraphBox!.x - 1
      && rect.right <= paragraphBox!.x + paragraphBox!.width + 1
    ))).toBe(true);
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

  test("persists a proven pre-generation failure and retries its annotated input exactly once", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const runtime = await createBlockingCountingChatRuntime(testInfo.outputDir);
    const savedInput = "Keep this saved input and its evidence through one retry";
    const annotationComment = "Preserve this source note and attached evidence.";
    const seeded = await seedAnnotationChat(page, `Pre-Generation-Retry-${Date.now()}`, {
      runtimeCommand: runtime.scriptPath,
    });
    let removeFailureTrigger: (() => Promise<void>) | null = null;
    let syntheticActiveGenerationId: string | null = null;
    try {
      const finalSource = annotationSource(page, {
        messageId: seeded.assistantMessageId,
        surface: "assistant_body",
      });
      await selectVisibleText(page, finalSource, "Rudder docs");
      await addSelectionToChat(page);
      await editAnnotation(page, 1, {
        comment: annotationComment,
        files: [{
          name: "pre-generation-retry-evidence.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Keep this exact attached evidence."),
        }],
      });
      await composer(page).fill(savedInput);
      removeFailureTrigger = await failFirstChatUserActivityWrite(
        seeded.organization.id,
        seeded.conversationId,
      );

      const initialGenerations = await e2eDb
        .select({ id: chatGenerations.id })
        .from(chatGenerations)
        .where(eq(chatGenerations.conversationId, seeded.conversationId));
      expect(initialGenerations.map(({ id }) => id)).toEqual([seeded.generationId]);

      const messagesPath = `/api/chats/${seeded.conversationId}/messages/stream`;
      await installChatMutationCapture(page, messagesPath);
      const originalRequestPromise = page.waitForRequest((request) => (
        request.method() === "POST" && new URL(request.url()).pathname === messagesPath
      ));
      await page.getByRole("button", { name: "Send" }).click();
      const originalRequest = await originalRequestPromise;
      const initialFailure = page.getByTestId("chat-assistant-message").filter({
        hasText: "Your input was saved, but the reply did not start.",
      });
      await expect(initialFailure).toBeVisible({ timeout: 20_000 });
      const originalResponse = await originalRequest.response();
      expect(originalResponse?.status()).toBe(201);
      const originalContentType = (await originalRequest.allHeaders())["content-type"];
      const originalMutationCaptures = await readChatMutationCaptures(page);
      const originalMutation = originalMutationCaptures[0];
      if (originalMutationCaptures.length !== 1 || originalMutation?.kind !== "multipart") {
        throw new Error("Expected one captured original multipart chat mutation for replay");
      }
      expect(originalContentType).toContain("multipart/form-data");

      const firstMessagesResponse = await page.request.get(
        `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
      );
      expect(firstMessagesResponse.ok(), await firstMessagesResponse.text()).toBe(true);
      const firstMessages = await firstMessagesResponse.json() as Array<{
        id: string;
        role: string;
        status: string;
        body: string;
        chatTurnId: string | null;
        turnVariant: number;
        runId: string | null;
        supersededAt: string | null;
        structuredPayload: {
          inlineAnnotations?: Array<{
            id: string;
            sourceMessageId: string;
            attachmentIds: string[];
            comment: string | null;
          }>;
          recoverableFailure?: {
            code?: string;
            phase?: string;
            runId?: string | null;
            dispatchEvidence?: Record<string, unknown>;
          };
        } | null;
        attachments: Array<{ id: string; originalFilename: string | null }>;
      }>;
      const originalUser = firstMessages.find((message) => (
        message.role === "user" && message.body === savedInput
      ));
      const preGenerationFailure = firstMessages.find((message) => (
        message.role === "assistant"
        && message.status === "failed"
        && message.body === "Your input was saved, but the reply did not start."
      ));
      expect(originalUser).toBeTruthy();
      expect(preGenerationFailure).toMatchObject({
        runId: null,
        chatTurnId: originalUser!.chatTurnId,
        turnVariant: originalUser!.turnVariant,
        structuredPayload: {
          recoverableFailure: {
            code: "chat_input_persisted_reply_not_started",
            phase: "pre_generation",
            runId: null,
            dispatchEvidence: {
              originalDispatch: "not_started",
              orgId: seeded.organization.id,
              conversationId: seeded.conversationId,
              userMessageId: originalUser!.id,
              chatTurnId: originalUser!.chatTurnId,
              turnVariant: originalUser!.turnVariant,
            },
          },
        },
      });
      const originalAnnotation = originalUser?.structuredPayload?.inlineAnnotations?.[0];
      expect(originalAnnotation).toMatchObject({
        sourceMessageId: seeded.assistantMessageId,
        comment: annotationComment,
        attachmentIds: [expect.any(String)],
      });
      expect(originalUser?.attachments.map(({ originalFilename }) => originalFilename))
        .toContain("pre-generation-retry-evidence.txt");

      const [originalUserRow] = await e2eDb
        .select({
          id: chatMessages.id,
          chatTurnId: chatMessages.chatTurnId,
          turnVariant: chatMessages.turnVariant,
          clientMutationId: chatMessages.clientMutationId,
        })
        .from(chatMessages)
        .where(eq(chatMessages.id, originalUser!.id));
      expect(originalUserRow?.clientMutationId).toBeTruthy();
      expect(await readFile(runtime.invocationPath, "utf8")).toBe("");
      const afterPreGenerationFailure = await e2eDb
        .select({ id: chatGenerations.id })
        .from(chatGenerations)
        .where(eq(chatGenerations.conversationId, seeded.conversationId));
      expect(afterPreGenerationFailure.map(({ id }) => id)).toEqual([seeded.generationId]);

      await page.reload({ waitUntil: "domcontentloaded" });
      const persistedFailure = page.getByTestId("chat-assistant-message").filter({
        hasText: "Your input was saved, but the reply did not start.",
      });
      await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: savedInput }))
        .toHaveCount(1);
      await expect(persistedFailure.getByRole("button", { name: "Retry" })).toBeVisible();
      const persistedTurn = page
        .getByTestId("chat-user-message-turn")
        .filter({ hasText: savedInput })
        .last();
      await expect(persistedTurn.getByRole("button", { name: "Show 1 annotation" }))
        .toBeVisible();
      const persistedAnnotationCard = await expandSentAnnotations(page, persistedTurn, 1);
      await expect(persistedAnnotationCard).toContainText(annotationComment);
      await expect(persistedAnnotationCard.getByText("pre-generation-retry-evidence.txt"))
        .toBeVisible();
      await page.keyboard.press("Escape");

      syntheticActiveGenerationId = randomUUID();
      await e2eDb.insert(chatGenerations).values({
        id: syntheticActiveGenerationId,
        orgId: seeded.organization.id,
        conversationId: seeded.conversationId,
        status: "running",
      });
      const activeRetry = await page.request.post(messagesPath, {
        data: {
          body: savedInput,
          editUserMessageId: originalUser!.id,
          clientMutationId: randomUUID(),
          modelOverride: null,
          effortOverride: null,
        },
      });
      expect(activeRetry.status()).toBe(409);
      expect(await activeRetry.json()).toMatchObject({
        details: { code: "chat_retry_generation_active" },
      });
      await e2eDb.delete(chatGenerations)
        .where(eq(chatGenerations.id, syntheticActiveGenerationId));
      syntheticActiveGenerationId = null;

      const originalMutationReplay = await replayCapturedChatMutation(page, messagesPath, originalMutation);
      expect(originalMutationReplay.status).toBe(200);
      const replayEvents = originalMutationReplay.body
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { type: string; messages?: unknown[] });
      expect(replayEvents.map(({ type }) => type)).toEqual(["ack", "final"]);
      expect(replayEvents[1]).toMatchObject({ type: "final", messages: [] });
      expect(await readFile(runtime.invocationPath, "utf8")).toBe("");

      await installChatMutationCapture(page, messagesPath);
      const retryRequestPromise = page.waitForRequest((request) => (
        request.method() === "POST" && new URL(request.url()).pathname === messagesPath
      ));
      await persistedFailure.getByRole("button", { name: "Retry" }).click();
      const retryRequest = await retryRequestPromise;
      const retryContentType = (await retryRequest.allHeaders())["content-type"];
      const retryMutationCaptures = await readChatMutationCaptures(page);
      const retryMutation = retryMutationCaptures[0];
      if (retryMutationCaptures.length !== 1 || !retryMutation || !retryContentType) {
        throw new Error("Expected one captured intentional Retry mutation for at-most-once replay");
      }
      await expect.poll(async () => (
        (await readFile(runtime.invocationPath, "utf8")).trim().split(/\r?\n/).filter(Boolean)
      ), { timeout: 20_000 }).toHaveLength(1);

      const variantsWhileRetryRuns = await e2eDb
        .select({
          id: chatMessages.id,
          body: chatMessages.body,
          chatTurnId: chatMessages.chatTurnId,
          turnVariant: chatMessages.turnVariant,
          clientMutationId: chatMessages.clientMutationId,
          supersededAt: chatMessages.supersededAt,
        })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.orgId, seeded.organization.id),
          eq(chatMessages.conversationId, seeded.conversationId),
          eq(chatMessages.role, "user"),
          eq(chatMessages.chatTurnId, originalUser!.chatTurnId!),
        ));
      expect(variantsWhileRetryRuns).toHaveLength(2);
      const retryVariant = variantsWhileRetryRuns.find(({ id }) => id !== originalUser!.id);
      expect(retryVariant).toMatchObject({
        body: savedInput,
        chatTurnId: originalUser!.chatTurnId,
        turnVariant: originalUser!.turnVariant + 1,
        clientMutationId: expect.any(String),
        supersededAt: null,
      });
      expect(retryVariant?.clientMutationId).not.toBe(originalUserRow!.clientMutationId);
      expect(variantsWhileRetryRuns.find(({ id }) => id === originalUser!.id)?.supersededAt)
        .toBeTruthy();

      const generationsWhileRetryRuns = await e2eDb
        .select({ id: chatGenerations.id })
        .from(chatGenerations)
        .where(eq(chatGenerations.conversationId, seeded.conversationId));
      expect(generationsWhileRetryRuns).toHaveLength(2);
      expect(generationsWhileRetryRuns.map(({ id }) => id)).toContain(seeded.generationId);

      const concurrentRetry = await page.request.post(messagesPath, {
        data: {
          body: savedInput,
          editUserMessageId: retryVariant!.id,
          clientMutationId: randomUUID(),
          modelOverride: null,
          effortOverride: null,
        },
      });
      expect(concurrentRetry.status()).toBe(409);
      const afterConcurrentRetry = await e2eDb
        .select({ id: chatGenerations.id })
        .from(chatGenerations)
        .where(eq(chatGenerations.conversationId, seeded.conversationId));
      expect(afterConcurrentRetry).toHaveLength(2);
      expect((await readFile(runtime.invocationPath, "utf8")).trim().split(/\r?\n/).filter(Boolean))
        .toHaveLength(1);

      await writeFile(runtime.releasePath, "release provider\n", "utf8");
      await expect(
        page.getByTestId("chat-assistant-message").filter({
          hasText: "Initial App Server reply (marker-false)",
        }).last(),
      ).toBeVisible({ timeout: 60_000 });
      const retriedTurn = page
        .getByTestId("chat-user-message-turn")
        .filter({ hasText: savedInput })
        .last();
      await expect(retriedTurn.getByRole("button", { name: "Show 1 annotation" }))
        .toBeVisible();
      const retriedAnnotationCard = await expandSentAnnotations(page, retriedTurn, 1);
      await expect(retriedAnnotationCard).toContainText(annotationComment);
      await expect(retriedAnnotationCard.getByText("pre-generation-retry-evidence.txt"))
        .toBeVisible();
      await page.keyboard.press("Escape");

      const retryMutationReplay = await replayCapturedChatMutation(page, messagesPath, retryMutation);
      expect(retryMutationReplay.status).toBe(200);
      const retryReplayEvents = retryMutationReplay.body
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { type: string; messages?: unknown[] });
      expect(retryReplayEvents.map(({ type }) => type)).toEqual(["ack", "final"]);
      expect(retryReplayEvents[1]).toMatchObject({ type: "final", messages: [] });

      const staleRetry = await page.request.post(messagesPath, {
        data: {
          body: savedInput,
          editUserMessageId: originalUser!.id,
          clientMutationId: randomUUID(),
          modelOverride: null,
          effortOverride: null,
        },
      });
      expect(staleRetry.status()).toBe(409);
      expect(await staleRetry.json()).toMatchObject({
        details: { code: "chat_retry_source_not_current" },
      });

      const finalMessagesResponse = await page.request.get(
        `/api/chats/${seeded.conversationId}/messages?includeTranscript=true`,
      );
      expect(finalMessagesResponse.ok(), await finalMessagesResponse.text()).toBe(true);
      const finalMessages = await finalMessagesResponse.json() as typeof firstMessages;
      const finalVariants = finalMessages.filter((message) => (
        message.role === "user"
        && message.chatTurnId === originalUser!.chatTurnId
        && message.body === savedInput
      ));
      expect(finalVariants).toHaveLength(2);
      const finalRetryVariant = finalVariants.find(({ id }) => id !== originalUser!.id);
      expect(finalRetryVariant?.structuredPayload?.inlineAnnotations?.[0]).toMatchObject({
        sourceMessageId: seeded.assistantMessageId,
        comment: annotationComment,
        attachmentIds: [expect.any(String)],
      });
      expect(finalRetryVariant?.attachments.map(({ originalFilename }) => originalFilename))
        .toContain("pre-generation-retry-evidence.txt");
      const finalGenerations = await e2eDb
        .select({ id: chatGenerations.id })
        .from(chatGenerations)
        .where(eq(chatGenerations.conversationId, seeded.conversationId));
      expect(finalGenerations).toHaveLength(2);
      expect((await readFile(runtime.invocationPath, "utf8")).trim().split(/\r?\n/).filter(Boolean))
        .toHaveLength(1);
    } finally {
      await writeFile(runtime.releasePath, "release provider\n", "utf8");
      if (syntheticActiveGenerationId) {
        await e2eDb.delete(chatGenerations)
          .where(eq(chatGenerations.id, syntheticActiveGenerationId));
      }
      await removeFailureTrigger?.();
    }
  });

  test("keeps immutable annotations through message edit and remaps their source and files in a UI Fork", async ({ page }) => {
    test.setTimeout(120_000);
    const seeded = await seedAnnotationChat(page, `Response-Annotation-Edit-Fork-${Date.now()}`, {
      runtimeCommand: join(E2E_ROOT, "fixtures", "codex-native-session.mjs"),
      runtimeReplyBody: "Streaming reply for chat.",
    });
    const streamPath = `/api/chats/${seeded.conversationId}/messages/stream`;
    const waitForTurnResponse = (body: string, editUserMessageId: string) => page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === streamPath
      && response.request().postDataJSON()?.body === body
      && response.request().postDataJSON()?.editUserMessageId === editUserMessageId
    ));
    async function completedPublicTurn(response: Response, body: string): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
      expect(response.status()).toBe(201);
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        type: string; generationId?: string; userMessage?: ChatMessage;
      }>;
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "ack")).toHaveLength(1);
      expect(events.filter((event) => event.type === "final")).toHaveLength(1);
      const ack = events.find((event) => event.type === "ack")!;
      expect(ack.generationId).toEqual(expect.any(String));
      expect(ack.userMessage).toMatchObject({
        orgId: seeded.organization.id, conversationId: seeded.conversationId, role: "user", body,
      });
      let completed: { user: ChatMessage; assistant: ChatMessage } | null = null;
      await expect.poll(async () => {
        const messagesResponse = await page.request.get(`/api/chats/${seeded.conversationId}/messages`);
        expect(messagesResponse.ok(), await messagesResponse.text()).toBe(true);
        const messages = await messagesResponse.json() as ChatMessage[];
        const user = messages.find((message) => message.id === ack.userMessage!.id && message.body === body);
        const assistant = user && messages.find((message) => (
          message.role === "assistant" && message.status === "completed"
          && message.body === "Streaming reply for chat."
          && message.chatTurnId === user.chatTurnId && message.turnVariant === user.turnVariant
          && message.generationId === ack.generationId && message.runId
        ));
        if (!user || !assistant) return false;
        const [generation] = await e2eDb.select().from(chatGenerations).where(and(
          eq(chatGenerations.orgId, seeded.organization.id),
          eq(chatGenerations.conversationId, seeded.conversationId),
          eq(chatGenerations.id, ack.generationId!),
        ));
        const [run] = await e2eDb.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.orgId, seeded.organization.id),
          eq(heartbeatRuns.chatConversationId, seeded.conversationId),
          eq(heartbeatRuns.id, assistant.runId!),
        ));
        const queueResponse = await page.request.get(`/api/chats/${seeded.conversationId}/queue`);
        expect(queueResponse.ok(), await queueResponse.text()).toBe(true);
        const queue = await queueResponse.json() as { activeGenerationId: string | null };
        if (generation?.status !== "completed" || !generation.runtimeTerminalAt || !generation.completedAt
          || run?.status !== "succeeded" || !run.finishedAt || run.terminalEffectsPending
          || queue.activeGenerationId !== null) return false;
        completed = { user, assistant };
        return true;
      }, { timeout: 20_000 }).toBe(true);
      await expect(page.getByRole("button", { name: "Stop streaming", exact: true })).toHaveCount(0);
      return completed!;
    }
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
    const retryResponse = waitForTurnResponse("Original annotated edit body", originalAnnotatedMessage!.id);
    await failedReply.getByRole("button", { name: "Retry" }).click();
    const retry = await completedPublicTurn(await retryResponse, "Original annotated edit body");

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
    const editResponse = waitForTurnResponse("Edited annotated edit body", retry.user.id);
    await inlineEditor.getByRole("button", { name: "Send" }).click();
    const edited = await completedPublicTurn(await editResponse, "Edited annotated edit body");
    expect(edited.user.id).not.toBe(retry.user.id);
    expect(edited.user.chatTurnId).toBe(retry.user.chatTurnId);
    expect(edited.user.turnVariant).toBe(retry.user.turnVariant + 1);
    expect(edited.assistant.id).not.toBe(retry.assistant.id);
    expect(edited.assistant.generationId).not.toBe(retry.assistant.generationId);
    await expect(inlineEditor).toHaveCount(0);

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

    const branchAssistant = page.locator(
      `[data-testid="chat-assistant-message"][data-message-id="${edited.assistant.id}"]`,
    );
    await expect(branchAssistant).toContainText("Streaming reply for chat.");
    await expect(branchAssistant).toBeVisible({ timeout: 20_000 });
    await branchAssistant.hover();
    const forkResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${seeded.conversationId}/fork`)
    ));
    await expect(branchAssistant.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
    await branchAssistant.getByRole("button", { name: "More message actions" }).filter({ visible: true }).click();
    await page.getByTestId("chat-fork-more-action").click();
    const forkResponse = await forkResponsePromise;
    expect(forkResponse.request().postDataJSON()).toMatchObject({ sourceMessageId: edited.assistant.id });
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

  test("preserves native Reader annotation provenance and files through message edit and UI Fork", async ({ page }) => {
    test.setTimeout(120_000);
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Response-Annotation-Native-Edit-Fork-${Date.now()}` },
    });
    expect(orgResponse.ok(), await orgResponse.text()).toBe(true);
    const organization = await orgResponse.json() as SeededNativeAnnotationChat["organization"];
    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "Native Annotation Edit Fork Agent",
      command: join(E2E_ROOT, "fixtures", "codex-native-session.mjs"),
    }) as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agent.id}`);
    await composer(page).fill("Native annotation reasoning fixture marker. Create a stable native reply.");
    const nativeStream = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith("/messages/stream")
    ));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await (await nativeStream).finished();
    const sourceAssistant = page.getByTestId("chat-assistant-message").last();
    await expect(sourceAssistant).toContainText("Native reply 1", { timeout: 30_000 });
    const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    const assistantMessageId = await sourceAssistant.getAttribute("data-message-id");
    expect(assistantMessageId).toBeTruthy();

    const sourceRuns = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, conversationId));
    expect(sourceRuns).toHaveLength(1);
    const sourceRun = sourceRuns[0]!;
    expect(sourceRun.agentId).toBe(agent.id);
    expect(sourceRun.status).toBe("succeeded");
    expect(sourceRun.contextSnapshot).toMatchObject({ transcriptSource: "native" });
    const seeded: SeededNativeAnnotationChat = {
      organization,
      agent,
      conversationId,
      assistantMessageId: assistantMessageId!,
      runId: sourceRun.id,
    };
    const [assistantRow] = await e2eDb.select().from(chatMessages)
      .where(eq(chatMessages.id, seeded.assistantMessageId));
    expect(assistantRow?.runId).toBe(seeded.runId);
    const sourceSpans = await e2eDb.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, seeded.runId));
    expect(sourceSpans.length).toBeGreaterThan(0);
    const span = sourceSpans[0];
    if (!span) throw new Error("Expected the native Chat Run to have a bound runtime span");
    expect(span).toMatchObject({ orgId: organization.id, runId: seeded.runId });
    const [binding] = await e2eDb.select().from(runtimeBindings)
      .where(eq(runtimeBindings.id, span.bindingId));
    if (!binding) throw new Error("Expected the native Run span to reference its Chat binding");
    expect(binding).toMatchObject({
      id: span.bindingId,
      orgId: organization.id,
      conversationId: seeded.conversationId,
    });
    const [segment] = await e2eDb.select().from(nativeSegments)
      .where(eq(nativeSegments.id, span.segmentId));
    expect(segment).toMatchObject({ id: span.segmentId, bindingId: binding.id, orgId: organization.id });

    type NativeReaderEntry = {
      sourceEntryId?: string;
      entry?: {
        kind?: string;
        text?: string;
        sourceEntryId?: string;
        generationId?: string;
        generationSeqStart?: number;
        generationSeqEnd?: number;
      };
    };
    type NativeReaderPage = {
      source?: string;
      availability?: string;
      completeness?: string;
      entries?: NativeReaderEntry[];
    };
    async function readNativeReader(runId: string) {
      const response = await page.request.get(
        `/api/run-intelligence/runs/${runId}/transcript?output=full&order=oldest&turnLimit=50&includeOutput=false&maxChars=4000`,
      );
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as NativeReaderPage;
    }
    const readerPage = await readNativeReader(seeded.runId);
    expect(readerPage).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    const readerEntry = readerPage.entries?.find((candidate) => (
      candidate.entry?.kind === "thinking"
      && candidate.entry.text === NATIVE_REASONING_TEXT
    ));
    expect(readerEntry?.sourceEntryId).toEqual(expect.any(String));
    const sourceEntryId = readerEntry!.sourceEntryId!;
    expect(readerEntry?.entry?.sourceEntryId).toBe(sourceEntryId);
    expect(readerEntry?.entry).not.toHaveProperty("generationId");
    expect(readerEntry?.entry).not.toHaveProperty("generationSeqStart");
    expect(readerEntry?.entry).not.toHaveProperty("generationSeqEnd");
    const sourceTuple = {
      sourceRunId: seeded.runId,
      sourceAgentId: seeded.agent.id,
      sourceEntryId,
      sourceMemberIds: [sourceEntryId],
    };

    const runEvents = await e2eDb.select({ eventType: heartbeatRunEvents.eventType })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seeded.runId));
    expect(runEvents.some((event) => event.eventType === "transcript.entry")).toBe(false);
    const sourceGenerations = await e2eDb.select({ id: chatGenerations.id })
      .from(chatGenerations).where(eq(chatGenerations.conversationId, seeded.conversationId));
    expect(sourceGenerations.length).toBeGreaterThan(0);
    const generationEvents = (await Promise.all(sourceGenerations.map(({ id }) => (
      e2eDb.select({ eventKind: chatGenerationEvents.eventKind })
        .from(chatGenerationEvents).where(eq(chatGenerationEvents.generationId, id))
    )))).flat();
    expect(generationEvents.some((event) => event.eventKind === "transcript")).toBe(false);
    const legacyTranscriptRows = await e2eDb.select({ entrySeq: chatMessageTranscriptEntries.entrySeq })
      .from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.orgId, organization.id));
    expect(legacyTranscriptRows).toEqual([]);

    const processItem = sourceAssistant.locator(
      "xpath=preceding-sibling::*[@data-testid='chat-transcript-item'][1]",
    );
    const processToggle = processItem
      .getByRole("button", { name: /Worked for|Show process|Hide process/ })
      .first();
    if (await processToggle.getAttribute("aria-expanded") !== "true") {
      await processToggle.click();
    }
    const assistantBlock = processItem.locator(
      `[data-run-transcript-block="true"][data-run-transcript-block-id="${sourceEntryId}"]`,
    );
    await expect(assistantBlock).toHaveCount(1);
    await expect(assistantBlock).toHaveAttribute("data-run-transcript-block-stable", "true");
    await expect(assistantBlock).toHaveAttribute("data-run-transcript-block-type", "thinking");
    await expect(assistantBlock).toContainText(NATIVE_REASONING_TEXT);
    await expect(assistantBlock).not.toContainText("Native reply 1");
    await selectVisibleText(page, assistantBlock, NATIVE_REASONING_TEXT);
    await addSelectionToChat(page);

    const annotationComment = "Carry this exact native Reader evidence through edit and Fork.";
    const attachmentContent = "native Reader edit and fork attachment evidence";
    const attachmentBytes = Buffer.from(attachmentContent, "utf8");
    await editAnnotation(page, 1, {
      comment: annotationComment,
      files: [{
        name: "native-edit-fork-annotation.txt",
        mimeType: "text/plain",
        buffer: attachmentBytes,
      }],
    });

    const streamPath = `/api/chats/${seeded.conversationId}/messages/stream`;
    const waitForTurnResponse = (body: string, editUserMessageId?: string) => page.waitForResponse((response) => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== streamPath) return false;
      const data = response.request().postDataJSON() as { body?: string; editUserMessageId?: string | null } | null;
      return data?.body === body && (data.editUserMessageId ?? undefined) === editUserMessageId;
    });
    async function completedNativeTurn(
      response: Response,
      body: string,
      expectedReply: string,
    ): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
      expect(response.status()).toBe(201);
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        type: string;
        generationId?: string;
        userMessage?: ChatMessage;
      }>;
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "ack")).toHaveLength(1);
      expect(events.filter((event) => event.type === "final")).toHaveLength(1);
      const ack = events.find((event) => event.type === "ack")!;
      expect(ack.generationId).toEqual(expect.any(String));
      expect(ack.userMessage).toMatchObject({
        orgId: seeded.organization.id,
        conversationId: seeded.conversationId,
        role: "user",
        body,
      });
      let completed: { user: ChatMessage; assistant: ChatMessage } | null = null;
      await expect.poll(async () => {
        const response = await page.request.get(`/api/chats/${seeded.conversationId}/messages`);
        expect(response.ok(), await response.text()).toBe(true);
        const messages = await response.json() as ChatMessage[];
        const user = messages.find((message) => message.id === ack.userMessage!.id && message.body === body);
        const assistant = user && messages.find((message) => (
          message.role === "assistant" && message.status === "completed"
          && message.body === expectedReply
          && message.chatTurnId === user.chatTurnId && message.turnVariant === user.turnVariant
          && message.generationId === ack.generationId && message.runId
        ));
        if (!user || !assistant?.runId) return false;
        const [generation] = await e2eDb.select().from(chatGenerations).where(and(
          eq(chatGenerations.orgId, seeded.organization.id),
          eq(chatGenerations.conversationId, seeded.conversationId),
          eq(chatGenerations.id, ack.generationId!),
        ));
        const [run] = await e2eDb.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.orgId, seeded.organization.id),
          eq(heartbeatRuns.chatConversationId, seeded.conversationId),
          eq(heartbeatRuns.id, assistant.runId),
        ));
        const queueResponse = await page.request.get(`/api/chats/${seeded.conversationId}/queue`);
        expect(queueResponse.ok(), await queueResponse.text()).toBe(true);
        const queue = await queueResponse.json() as { activeGenerationId: string | null };
        if (generation?.status !== "completed" || !generation.runtimeTerminalAt || !generation.completedAt
          || run?.status !== "succeeded" || !run.finishedAt || run.terminalEffectsPending
          || queue.activeGenerationId !== null) return false;
        completed = { user, assistant };
        return true;
      }, { timeout: 20_000 }).toBe(true);
      await expect(page.getByRole("button", { name: "Stop streaming", exact: true })).toHaveCount(0);
      return completed!;
    }

    const messagesPath = streamPath;
    await installChatMutationCapture(page, messagesPath);
    const originalBody = "Original native annotated edit body";
    await composer(page).fill(originalBody);
    const originalResponse = waitForTurnResponse(originalBody);
    await page.getByRole("button", { name: "Send" }).click();
    const original = await completedNativeTurn(await originalResponse, originalBody, "Native reply 2");
    const originalTurn = page.getByTestId("chat-user-message-turn").filter({ hasText: originalBody });
    await expect(originalTurn.getByRole("button", { name: "Show 1 annotation" })).toBeVisible({ timeout: 15_000 });

    const captures = await readChatMutationCaptures(page);
    const capture = captures[0];
    if (captures.length !== 1 || capture?.kind !== "multipart") {
      throw new Error("Expected one captured native annotation multipart chat mutation");
    }
    const annotationsField = capture.parts.find((part) => (
      part.kind === "field" && part.name === "inlineAnnotations"
    ));
    if (!annotationsField || annotationsField.kind !== "field") {
      throw new Error("Expected captured native inline annotation provenance");
    }
    const submittedAnnotations = JSON.parse(annotationsField.value) as Array<Record<string, unknown>>;
    expect(submittedAnnotations).toHaveLength(1);
    const submittedAnnotation = submittedAnnotations[0]!;
    expect(submittedAnnotation).toMatchObject({
      selectedText: NATIVE_REASONING_TEXT,
      comment: annotationComment,
      surface: "agent_run_transcript",
      ...sourceTuple,
      anchorKind: "text",
      attachmentFileIndexes: [0],
    });
    const capturedFile = capture.parts.find((part) => part.kind === "file");
    expect(capturedFile).toMatchObject({
      fileName: "native-edit-fork-annotation.txt",
      mimeType: "text/plain",
      bytes: [...attachmentBytes],
    });

    type NativeAnnotation = {
      id: string;
      selectedText: string;
      comment: string | null;
      surface: string;
      sourceRunId: string;
      sourceAgentId: string;
      sourceEntryId: string;
      sourceMemberIds: string[];
      attachmentIds: string[];
    };
    type NativeAnnotationMessage = {
      id: string;
      role: string;
      body: string;
      runId?: string | null;
      chatTurnId: string | null;
      turnVariant: number;
      structuredPayload: { inlineAnnotations?: NativeAnnotation[] } | null;
      transcript?: Array<{
        kind: string;
        text?: string;
        sourceEntryId?: string;
      }>;
      attachments: Array<{
        id: string;
        originalFilename: string | null;
        contentPath: string;
      }>;
    };
    async function getConversationMessages(id: string, includeTranscript = false) {
      const response = await page.request.get(
        `/api/chats/${id}/messages${includeTranscript ? "?includeTranscript=true" : ""}`,
      );
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as NativeAnnotationMessage[];
    }
    async function expectAttachmentContent(contentPath: string) {
      const response = await page.request.get(contentPath);
      expect(response.ok(), await response.text()).toBe(true);
      expect((await response.body()).toString("utf8")).toBe(attachmentContent);
    }
    const originalMessages = await getConversationMessages(seeded.conversationId);
    const originalAnnotatedMessage = originalMessages.find((message) => (
      message.role === "user" && message.body === originalBody
    ));
    const originalAnnotation = originalAnnotatedMessage?.structuredPayload?.inlineAnnotations?.[0];
    expect(originalAnnotation).toMatchObject({
      id: submittedAnnotation.id,
      selectedText: NATIVE_REASONING_TEXT,
      comment: annotationComment,
      surface: "agent_run_transcript",
      ...sourceTuple,
      attachmentIds: [expect.any(String)],
    });
    const originalAttachment = originalAnnotatedMessage?.attachments.find(({ id }) => (
      originalAnnotation?.attachmentIds.includes(id)
    ));
    expect(originalAttachment).toMatchObject({ originalFilename: "native-edit-fork-annotation.txt" });
    await expectAttachmentContent(originalAttachment!.contentPath);

    const originalBubble = originalTurn.getByTestId("chat-user-message-bubble");
    await originalBubble.hover();
    await originalTurn.getByRole("button", { name: "Edit message" }).click();
    const inlineEditor = page.getByTestId("chat-inline-message-editor");
    await expect(inlineEditor).toBeVisible();
    await inlineEditor.locator(".rudder-mdxeditor-content").fill("Edited native annotated edit body");
    const editedBody = "Edited native annotated edit body";
    const editResponse = waitForTurnResponse(editedBody, original.user.id);
    await inlineEditor.getByRole("button", { name: "Send" }).click();
    const edited = await completedNativeTurn(await editResponse, editedBody, "Native reply 3");
    expect(edited.user.id).not.toBe(original.user.id);
    expect(edited.user.chatTurnId).toBe(original.user.chatTurnId);
    expect(edited.user.turnVariant).toBe(original.user.turnVariant + 1);
    expect(edited.assistant.id).not.toBe(original.assistant.id);
    expect(edited.assistant.generationId).not.toBe(original.assistant.generationId);
    await expect(inlineEditor).toHaveCount(0);

    const editedMessages = await getConversationMessages(seeded.conversationId);
    const editedAnnotatedMessage = editedMessages.find((message) => (
      message.id === edited.user.id && message.body === editedBody
    ));
    const editedAnnotation = editedAnnotatedMessage?.structuredPayload?.inlineAnnotations?.[0];
    expect(editedAnnotation).toMatchObject({
      id: originalAnnotation!.id,
      selectedText: NATIVE_REASONING_TEXT,
      comment: annotationComment,
      surface: "agent_run_transcript",
      ...sourceTuple,
      attachmentIds: [expect.any(String)],
    });
    const editedAttachment = editedAnnotatedMessage?.attachments.find(({ id }) => (
      editedAnnotation?.attachmentIds.includes(id)
    ));
    expect(editedAttachment).toMatchObject({ originalFilename: "native-edit-fork-annotation.txt" });
    await expectAttachmentContent(editedAttachment!.contentPath);

    const editedTurn = page.getByTestId("chat-user-message-turn").filter({ hasText: editedBody });
    await expect(editedTurn.getByRole("button", { name: "Show 1 annotation" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-user-message-turn").filter({ hasText: originalBody })).toHaveCount(0);
    const editedCard = await expandSentAnnotations(page, editedTurn, 1);
    await expect(editedCard).toContainText(annotationComment);
    await expect(editedCard.getByText("native-edit-fork-annotation.txt")).toBeVisible();
    await page.keyboard.press("Escape");

    const branchAssistant = page.locator(
      `[data-testid="chat-assistant-message"][data-message-id="${edited.assistant.id}"]`,
    );
    await expect(branchAssistant).toContainText("Native reply 3");
    await branchAssistant.hover();
    const forkResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/chats/${seeded.conversationId}/fork`)
    ));
    await branchAssistant.getByRole("button", { name: "More message actions" }).filter({ visible: true }).click();
    await page.getByTestId("chat-fork-more-action").click();
    const forkResponse = await forkResponsePromise;
    expect(forkResponse.request().postDataJSON()).toMatchObject({ sourceMessageId: edited.assistant.id });
    expect(forkResponse.ok(), await forkResponse.text()).toBe(true);
    const forkedConversation = await forkResponse.json() as { id: string };
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${forkedConversation.id}$`), { timeout: 15_000 });

    const forkedTurn = page.getByTestId("chat-user-message-turn").filter({ hasText: editedBody });
    await expect(forkedTurn.getByRole("button", { name: "Show 1 annotation" })).toBeVisible({ timeout: 15_000 });
    const forkedCard = await expandSentAnnotations(page, forkedTurn, 1);
    await expect(forkedCard).toContainText(annotationComment);
    await expect(forkedCard.getByText("native-edit-fork-annotation.txt")).toBeVisible();

    const forkMessages = await getConversationMessages(forkedConversation.id, true);
    const forkedAnnotatedMessage = forkMessages.find((message) => (
      message.role === "user" && message.body === editedBody
    ));
    const forkedAnnotation = forkedAnnotatedMessage?.structuredPayload?.inlineAnnotations?.[0];
    expect(forkedAnnotation).toMatchObject({
      id: originalAnnotation!.id,
      selectedText: NATIVE_REASONING_TEXT,
      comment: annotationComment,
      surface: "agent_run_transcript",
      ...sourceTuple,
      attachmentIds: [expect.any(String)],
    });
    expect(forkedAnnotation!.attachmentIds[0]).not.toBe(editedAnnotation!.attachmentIds[0]);
    const forkedAttachment = forkedAnnotatedMessage?.attachments.find(({ id }) => (
      forkedAnnotation!.attachmentIds.includes(id)
    ));
    expect(forkedAttachment).toMatchObject({ originalFilename: "native-edit-fork-annotation.txt" });
    await expectAttachmentContent(forkedAttachment!.contentPath);

    const [forkedConversationRow] = await e2eDb.select().from(chatConversations)
      .where(eq(chatConversations.id, forkedConversation.id));
    expect(forkedConversationRow).toMatchObject({
      id: forkedConversation.id,
      orgId: organization.id,
      status: "active",
      conversationKind: "chat",
    });
    const nativeForkAliases = await e2eDb.select().from(runtimeSourceAliases).where(and(
      eq(runtimeSourceAliases.orgId, organization.id),
      eq(runtimeSourceAliases.conversationId, forkedConversation.id),
      eq(runtimeSourceAliases.sourceKind, "chat_fork_native_span"),
      eq(runtimeSourceAliases.runId, seeded.runId),
    ));
    expect(nativeForkAliases).toHaveLength(1);
    const nativeForkAlias = nativeForkAliases[0]!;
    expect(nativeForkAlias).toMatchObject({
      orgId: organization.id,
      conversationId: forkedConversation.id,
      runId: seeded.runId,
      bindingId: span.bindingId,
      segmentId: span.segmentId,
      sourceKind: "chat_fork_native_span",
      principalScopeRef: `org:${organization.id}`,
      readOnly: true,
      expiresAt: null,
      releasedAt: null,
    });
    expect(nativeForkAlias.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(nativeForkAlias.sourceRangeJson).toMatchObject({
      targetCopiedMessageId: expect.any(String),
      sourceConversationId: seeded.conversationId,
      sourceMessageId: seeded.assistantMessageId,
      sourceRunId: seeded.runId,
      sourceSpanId: span.id,
      selectorJson: span.selectorJson,
      selectorSha256: nativeForkContentHash(span.selectorJson),
    });
    const copiedNativeAssistant = forkMessages.find((message) => (
      message.id === nativeForkAlias.sourceRangeJson.targetCopiedMessageId
    ));
    expect(copiedNativeAssistant).toMatchObject({
      role: "assistant",
      runId: null,
    });
    const childHistoryMatches = copiedNativeAssistant?.transcript?.filter((entry) => (
      entry.sourceEntryId === forkedAnnotation!.sourceEntryId
    )) ?? [];
    expect(childHistoryMatches).toHaveLength(1);
    expect(childHistoryMatches[0]).toMatchObject({
      kind: "thinking",
      text: forkedAnnotation!.selectedText,
      sourceEntryId: forkedAnnotation!.sourceEntryId,
    });
    expect(await e2eDb.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.orgId, organization.id),
        eq(heartbeatRuns.chatConversationId, forkedConversation.id),
      ))).toEqual([]);

    const organizationRuns = await e2eDb.select({ id: heartbeatRuns.id })
      .from(heartbeatRuns).where(eq(heartbeatRuns.orgId, organization.id));
    const organizationRunEvents = (await Promise.all(organizationRuns.map(({ id }) => (
      e2eDb.select({ eventType: heartbeatRunEvents.eventType })
        .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, id))
    )))).flat();
    expect(organizationRunEvents.some((event) => event.eventType === "transcript.entry")).toBe(false);
    const organizationGenerations = await e2eDb.select({ id: chatGenerations.id })
      .from(chatGenerations).where(eq(chatGenerations.orgId, organization.id));
    const organizationGenerationEvents = (await Promise.all(organizationGenerations.map(({ id }) => (
      e2eDb.select({ eventKind: chatGenerationEvents.eventKind })
        .from(chatGenerationEvents).where(eq(chatGenerationEvents.generationId, id))
    )))).flat();
    expect(organizationGenerationEvents.some((event) => event.eventKind === "transcript")).toBe(false);
    const organizationTranscriptRows = await e2eDb.select({ entrySeq: chatMessageTranscriptEntries.entrySeq })
      .from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.orgId, organization.id));
    expect(organizationTranscriptRows).toEqual([]);

    await forkedCard
      .getByTestId("chat-response-annotation-sent-card-entry")
      .getByRole("button", { name: "Show source" })
      .click();
    await expect(page).toHaveURL(new RegExp(
      `/agents/${seeded.agent.id}/runs/${seeded.runId}(?:[/?#]|$)`,
    ));
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
    // Native Steer continues the active turn; it need not create a second
    // assistant bubble. The reply itself must still reach Chat from history.
    const steeredAssistant = page.getByTestId("chat-assistant-message").filter({
      hasText: "Native steer applied: Edited Queue body keeps its annotation",
    });
    await expect(steeredAssistant).toContainText(
      "Native steer applied: Edited Queue body keeps its annotation",
      { timeout: 30_000 },
    );
    await expect(steeredAssistant).toContainText(
      "User-provided annotations:",
      { timeout: 30_000 },
    );
    await expect(steeredAssistant).toContainText("第一段包含");
    await expect(steeredAssistant).toContainText(
      "Keep this staged evidence with Queue and Steer.",
    );
    await expect(steeredAssistant).toContainText(
      "Native steer image received: true",
    );
    await expect(page.getByRole("button", { name: "Stop streaming" }))
      .toHaveCount(0, { timeout: 30_000 });
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

    const nativeRuns = await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.chatConversationId, seeded.conversationId));
    expect(nativeRuns).toHaveLength(1);
    expect(nativeRuns[0]!.status).toBe("succeeded");
    const transcriptRes = await page.request.get(`/api/run-intelligence/runs/${nativeRuns[0]!.id}/transcript`);
    expect(transcriptRes.ok(), await transcriptRes.text()).toBe(true);
    const nativeTranscript = await transcriptRes.json() as {
      source: string;
      availability: string;
      completeness: string;
      rows: Array<{ kind: string; preview?: string }>;
    };
    expect(nativeTranscript).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(nativeTranscript.rows.some((row) => row.kind === "user"
      && row.preview?.includes("Edited Queue body keeps its annotation"))).toBe(true);

    const messagesRes = await page.request.get(`/api/chats/${seeded.conversationId}/messages`);
    expect(messagesRes.ok(), await messagesRes.text()).toBe(true);
    const messages = await messagesRes.json() as Array<{
      role: string;
      status: string;
      body: string;
      structuredPayload: {
        inlineAnnotations?: Array<{
          sourceMessageId: string;
          attachmentIds: string[];
        }>;
      } | null;
      attachments: Array<{ id: string; originalFilename: string | null }>;
    }>;
    expect(messages.some((message) => message.role === "assistant"
      && message.status === "completed"
      && message.body.includes("Native steer applied: Edited Queue body keeps its annotation"))).toBe(true);
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
    await expect(panel.getByTestId("side-chat-anchor-preview")).toHaveCount(0);
    await expect(panel).not.toContainText("From the main chat");
    await expect(panel.getByRole("button", { name: "Show 1 annotation" })).toBeVisible();
    await expect(composer(page)).toHaveText("Keep this unfinished main-chat draft");

    await panel.getByRole("button", { name: "Show 1 annotation" }).click();
    const provisionalCard = page.getByTestId("chat-response-annotation-card");
    await expect(provisionalCard).toBeVisible();
    await provisionalCard.hover();
    await provisionalCard.getByRole("button", { name: "Edit annotation 1" }).click();
    const provisionalEditor = page.getByTestId("chat-response-annotation-editor");
    await expect(provisionalEditor).toBeVisible();
    await expect(provisionalEditor).toContainText("Selected excerpt");
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
