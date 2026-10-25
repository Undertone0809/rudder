import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { createDb } from "../../packages/db/src/index.js";
import { startNativeChatFixture } from "./support/native-chat-fixture";
import { nativeSmokeFixtureOptions } from "./support/native-smoke";

const ANSWER = "synthetic answer";
const MESSAGE_BODY = "Complete one native work item before checking the retry boundary.";
const SMOKE_TIMEOUT = 180_000;

type Fixture = Awaited<ReturnType<typeof startNativeChatFixture>>;

type PublicMessage = {
  id: string;
  role: string;
  kind: string;
  status: string;
  body: string;
  runId: string | null;
  replyingAgentId: string | null;
  chatTurnId: string | null;
  turnVariant: number;
  supersededAt?: string | null;
};

type PublicSendPayload = {
  body: string;
  clientMutationId: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
  editUserMessageId?: string | null;
};

type NativeRunRow = {
  id: string;
  status: string;
  executionAuthority: string;
  generationId: string | null;
  resultJson: Record<string, unknown> | null;
};

type NativeGenerationRow = {
  id: string;
  status: string;
  executionAuthority: string;
  sourceMessageId: string;
  sourceTurnVariant: number;
};

type NativeMessageRow = {
  id: string;
  role: string;
  kind: string;
  status: string;
  body: string;
  runId: string | null;
  replyingAgentId: string | null;
  clientMutationId: string | null;
  chatTurnId: string | null;
  turnVariant: number;
  supersededAt: string | null;
};

type DurableState = {
  runs: NativeRunRow[];
  generations: NativeGenerationRow[];
  messages: NativeMessageRow[];
};

type ProviderEvent = {
  received?: { method?: string };
  turnStart?: unknown;
};

let fixtureOptions: Awaited<ReturnType<typeof nativeSmokeFixtureOptions>> | null = null;

test.describe("@smoke Native Chat request boundary", () => {
  test.describe.configure({ timeout: SMOKE_TIMEOUT });

  test.beforeAll(async () => {
    test.setTimeout(SMOKE_TIMEOUT);
    fixtureOptions = await nativeSmokeFixtureOptions();
  });

  test("rejects legacy retry/edit input before creating another native run", async ({ page }) => {
    if (!fixtureOptions) throw new Error("Native fixture binaries were not prepared in beforeAll");
    const fixture = await startNativeChatFixture(fixtureOptions);
    let passed = false;
    try {
      await page.addInitScript((orgId: string) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      }, fixture.orgId);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(`${fixture.publicUrl}/native-${fixture.orgId}/messenger/chat/${fixture.chatId}`);
      const composer = page.locator(".rudder-mdxeditor-content").first();
      await expect(composer).toBeVisible({ timeout: 30_000 });

      const sendPath = `/api/chats/${fixture.chatId}/messages/stream`;
      const firstSendPromise = page.waitForRequest((request) => (
        request.method() === "POST" && new URL(request.url()).pathname === sendPath
      ));
      await composer.fill(MESSAGE_BODY);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const firstSend = await firstSendPromise;
      const firstPayload = firstSend.postDataJSON() as PublicSendPayload;
      expect(firstPayload).toMatchObject({
        body: MESSAGE_BODY,
        clientMutationId: expect.any(String),
      });
      expect(firstPayload.clientMutationId.trim()).not.toBe("");

      await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: MESSAGE_BODY })).toHaveCount(1);
      await expect(page.getByTestId("chat-assistant-message").filter({ hasText: ANSWER })).toHaveCount(1, {
        timeout: 60_000,
      });

      const messagesResponse = await page.request.get(`${fixture.publicUrl}/api/chats/${fixture.chatId}/messages`);
      const messagesBody = await messagesResponse.text();
      expect(messagesResponse.ok(), messagesBody).toBe(true);
      const publicMessages = JSON.parse(messagesBody) as PublicMessage[];
      const userMessage = publicMessages.find((message) => message.role === "user" && message.body === MESSAGE_BODY);
      const assistantMessage = publicMessages.find((message) => (
        message.role === "assistant" && message.body === ANSWER && message.status === "completed"
      ));
      expect(userMessage).toBeTruthy();
      expect(assistantMessage).toBeTruthy();
      expect(userMessage!.id).toEqual(expect.any(String));
      expect(assistantMessage!.chatTurnId).toBe(userMessage!.chatTurnId);
      expect(assistantMessage!.runId).toEqual(expect.any(String));

      await expect.poll(async () => (await readDurableState(fixture)).runs.map((run) => run.status), {
        timeout: 60_000,
      }).toEqual(["succeeded"]);

      const before = await readDurableState(fixture);
      expect(before.runs).toHaveLength(1);
      expect(before.generations).toHaveLength(1);
      expect(before.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(before.messages.filter((message) => message.role === "assistant")).toHaveLength(1);

      const [run] = before.runs;
      const [generation] = before.generations;
      expect(run).toMatchObject({
        id: assistantMessage!.runId,
        status: "succeeded",
        executionAuthority: "native_rust",
        generationId: generation.id,
      });
      expect(generation).toMatchObject({
        status: "completed",
        executionAuthority: "native_rust",
        sourceMessageId: userMessage!.id,
        sourceTurnVariant: userMessage!.turnVariant,
      });
      expect(before.messages.find((message) => message.id === userMessage!.id)).toMatchObject({
        role: "user",
        body: MESSAGE_BODY,
        chatTurnId: userMessage!.chatTurnId,
      });
      expect(before.messages.find((message) => message.id === assistantMessage!.id)).toMatchObject({
        role: "assistant",
        status: "completed",
        body: ANSWER,
        runId: run.id,
        replyingAgentId: fixture.agentId,
        chatTurnId: userMessage!.chatTurnId,
      });
      const finalization = (run.resultJson?.nativeChatFinalization as {
        result?: { runId?: string; assistantMessageId?: string };
      } | undefined)?.result;
      expect(finalization).toMatchObject({ runId: run.id, assistantMessageId: assistantMessage!.id });

      const providerEventsBefore = await readProviderEvents(fixture);
      expect(providerEventsBefore.filter((event) => event.turnStart !== undefined)).toHaveLength(1);

      // Match the actual UI wire shape: editIntent stays local in Chat.tsx,
      // while its legacy Retry request sends a concrete editUserMessageId.
      const legacyRetryPayload: PublicSendPayload = {
        body: firstPayload.body,
        clientMutationId: randomUUID(),
        modelOverride: firstPayload.modelOverride ?? null,
        effortOverride: firstPayload.effortOverride ?? null,
        editUserMessageId: userMessage!.id,
      };
      const rejected = await page.evaluate(async ({ chatId, payload }) => {
        const response = await fetch(`/api/chats/${chatId}/messages/stream`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return { status: response.status, body: await response.json() as unknown };
      }, { chatId: fixture.chatId, payload: legacyRetryPayload });
      expect(rejected).toEqual({ status: 422, body: { error: "unsupported_chat_input" } });

      // Re-read after a short settlement window so a rejected request cannot
      // hide a late admission or provider launch behind its immediate 422.
      for (let sample = 0; sample < 5; sample += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await readDurableState(fixture)).toEqual(before);
        expect(await readProviderEvents(fixture)).toEqual(providerEventsBefore);
      }

      passed = true;
    } finally {
      await fixture.stop({ preserveRoot: !passed });
    }
  });
});

async function readDurableState(fixture: Fixture): Promise<DurableState> {
  const db = createDb(fixture.databaseUrl);
  try {
    const runs = await db.$client`
      SELECT id::text AS id, status, execution_authority AS "executionAuthority",
             chat_generation_id::text AS "generationId", result_json AS "resultJson"
      FROM heartbeat_runs
      WHERE org_id=${fixture.orgId}::uuid AND chat_conversation_id=${fixture.chatId}::uuid
        AND execution_authority='native_rust'
      ORDER BY created_at, id`;
    const generations = await db.$client`
      SELECT id::text AS id, status, execution_authority AS "executionAuthority",
             source_message_id::text AS "sourceMessageId", source_turn_variant AS "sourceTurnVariant"
      FROM chat_generations
      WHERE org_id=${fixture.orgId}::uuid AND conversation_id=${fixture.chatId}::uuid
        AND execution_authority='native_rust'
      ORDER BY created_at, id`;
    const messages = await db.$client`
      SELECT id::text AS id, role, kind, status, body, run_id::text AS "runId",
             replying_agent_id::text AS "replyingAgentId", client_mutation_id AS "clientMutationId",
             chat_turn_id::text AS "chatTurnId", turn_variant AS "turnVariant",
             superseded_at::text AS "supersededAt"
      FROM chat_messages
      WHERE org_id=${fixture.orgId}::uuid AND conversation_id=${fixture.chatId}::uuid
      ORDER BY created_at, id`;
    return {
      runs: runs as NativeRunRow[],
      generations: generations as NativeGenerationRow[],
      messages: messages as NativeMessageRow[],
    };
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function readProviderEvents(fixture: Fixture): Promise<ProviderEvent[]> {
  const raw = await readFile(fixture.providerEventsPath, "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ProviderEvent);
}
