import { expect, test, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { chatGenerations, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

type Organization = { id: string; issuePrefix: string };
type Chat = { id: string };

async function createNetworkStub() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-network-wait-e2e-"));
  const statePath = path.join(root, "state");
  const commandPath = path.join(root, "codex");
  await writeFile(statePath, "offline\n", "utf8");
  await writeFile(commandPath, `#!/usr/bin/env node
import fs from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (fs.readFileSync(process.env.RUDDER_NETWORK_WAIT_STATE, "utf8").trim() !== "online") {
    console.error("Error: connect ECONNREFUSED provider");
    process.exitCode = 1;
    return;
  }
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_E2E__";
  const body = "Recovered after network.";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-network-wait", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { id: "msg-network-wait", type: "agent_message", text: body + " " + sentinel + JSON.stringify({ kind: "message", body, structuredPayload: null }) },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    result: body + " " + sentinel + JSON.stringify({ kind: "message", body, structuredPayload: null }),
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }) + "\\n");
});
`, "utf8");
  await chmod(commandPath, 0o755);
  return { commandPath, statePath };
}

async function createChatFixture(page: Page, commandPath: string, statePath: string, name: string) {
  const orgRes = await page.request.post("/api/orgs", { data: { name: `${name}-${Date.now()}` } });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as Organization;
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Network Wait Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: commandPath,
        env: { RUDDER_NETWORK_WAIT_STATE: statePath },
        modelFallbacks: [],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: name,
      preferredAgentId: agent.id,
      initialMessage: { body: "Network wait test setup." },
    },
  });
  expect(chatRes.ok()).toBe(true);
  return { organization, chat: await chatRes.json() as Chat, agent };
}

async function openChat(page: Page, organization: Organization, chat: Chat) {
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
  await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible({ timeout: 15_000 });
}

async function readQueueStatus(page: Page, chatId: string) {
  const response = await page.request.get(`/api/chats/${chatId}/queue`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { activeGenerationStatus?: string | null; activeGenerationId?: string | null };
  return body;
}

async function sendAndWaitForNetwork(page: Page) {
  await page.locator(".rudder-mdxeditor-content").first().fill("Please answer after the network returns.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Waiting for network", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
}

test("projects the recovered assistant reply without refreshing a network-waiting Chat", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await createNetworkStub();
  const fixture = await createChatFixture(page, stub.commandPath, stub.statePath, "Network wait resume");
  type ProjectedMessage = { role: string; generationId?: string | null; status?: string; body?: string };
  const messageReads: Array<Promise<{
    observedAt: number;
    status: number;
    messages: ProjectedMessage[] | null;
  }>> = [];
  const recordMessagesResponse = (response: PlaywrightResponse) => {
    const url = new URL(response.url());
    if (response.request().method() !== "GET" || url.pathname !== `/api/chats/${fixture.chat.id}/messages`) return;
    const observedAt = Date.now();
    messageReads.push(response.json().then(
      (body: unknown) => ({
        observedAt,
        status: response.status(),
        messages: Array.isArray(body) ? body as ProjectedMessage[] : null,
      }),
      () => ({ observedAt, status: response.status(), messages: null }),
    ));
  };
  page.on("response", recordMessagesResponse);
  await page.goto("/");
  await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), fixture.organization.id);
  await openChat(page, fixture.organization, fixture.chat);

  await sendAndWaitForNetwork(page);
  const waitingObservedAt = Date.now();
  const waitingQueue = await readQueueStatus(page, fixture.chat.id);
  expect(waitingQueue.activeGenerationStatus).toBe("waiting_for_network");
  expect(waitingQueue.activeGenerationId).toBeTruthy();
  const generationId = waitingQueue.activeGenerationId!;

  await expect.poll(async () => {
    const reads = await Promise.all(messageReads);
    return reads.filter((read) => read.observedAt >= waitingObservedAt).length;
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const earlyReads = (await Promise.all(messageReads)).filter((read) => read.observedAt >= waitingObservedAt);
  expect(earlyReads[0]?.status).toBe(200);
  expect(earlyReads[0]?.messages).not.toBeNull();
  expect(earlyReads[0]?.messages?.some((message) => (
    message.role === "assistant" && message.generationId === generationId && message.status !== "streaming"
  ))).toBe(false);
  expect(earlyReads.every((read) => read.status === 200 && !read.messages?.some((message) => (
    message.role === "assistant" && message.generationId === generationId && message.status !== "streaming"
  )))).toBe(true);
  expect(await readQueueStatus(page, fixture.chat.id)).toMatchObject({
    activeGenerationId: generationId,
    activeGenerationStatus: "waiting_for_network",
  });

  await writeFile(stub.statePath, "online\n", "utf8");
  await e2eDb
    .update(heartbeatRuns)
    .set({ networkWaitNextRetryAt: new Date(Date.now() - 1_000) })
    .where(eq(heartbeatRuns.chatConversationId, fixture.chat.id));

  await expect.poll(async () => (await readQueueStatus(page, fixture.chat.id)).activeGenerationStatus, { timeout: 75_000 })
    .toBe(null);
  const [generation] = await e2eDb
    .select({ status: chatGenerations.status })
    .from(chatGenerations)
    .where(eq(chatGenerations.id, generationId));
  expect(generation?.status).toBe("completed");
  const runs = await e2eDb
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.chatConversationId, fixture.chat.id));
  expect(runs.length).toBeGreaterThan(0);
  await expect.poll(async () => {
    const reads = await Promise.all(messageReads);
    return reads.some((read) => read.messages?.some((message) => (
      message.role === "assistant"
      && message.generationId === generationId
      && message.status === "completed"
      && message.body === "Recovered after network."
    )));
  }, { timeout: 20_000 }).toBe(true);
  await expect(page.getByText("Recovered after network.", { exact: true })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByText("Waiting for network", { exact: true })).toHaveCount(0);
  page.off("response", recordMessagesResponse);
});

test("Stop terminates a Chat that is waiting for network", async ({ page }) => {
  test.setTimeout(60_000);
  const stub = await createNetworkStub();
  const fixture = await createChatFixture(page, stub.commandPath, stub.statePath, "Network wait stop");
  await page.goto("/");
  await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), fixture.organization.id);
  await openChat(page, fixture.organization, fixture.chat);

  await sendAndWaitForNetwork(page);
  await expect.poll(async () => (await readQueueStatus(page, fixture.chat.id)).activeGenerationStatus, { timeout: 15_000 })
    .toBe("waiting_for_network");
  await page.getByRole("button", { name: "Stop streaming" }).click();

  await expect.poll(async () => (await readQueueStatus(page, fixture.chat.id)).activeGenerationStatus, { timeout: 20_000 })
    .toBe(null);
  const generations = await e2eDb
    .select({ status: chatGenerations.status, terminalReason: chatGenerations.terminalReason })
    .from(chatGenerations)
    .where(eq(chatGenerations.conversationId, fixture.chat.id));
  expect(generations[0]).toMatchObject({ status: "stopped", terminalReason: "operator_stop" });
});
