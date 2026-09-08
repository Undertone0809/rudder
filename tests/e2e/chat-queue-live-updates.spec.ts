import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatConversations, chatGenerations, chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

const db = createDb(E2E_DATABASE_URL);

for (const recovery of ["activity", "reconnect"] as const) {
  test(`idle Chat queue wakes through ${recovery}, polls while queued, then stops`, async ({ page }, testInfo) => {
    const orgResponse = await page.request.post("/api/orgs", { data: { name: `Queue-${recovery}-${randomUUID()}` } });
    expect(orgResponse.ok()).toBe(true);
    const org = await orgResponse.json();
    const agent = await createE2EChatAgent(page.request, org.id);
    const chatId = randomUUID();
    const body = `External queued work ${randomUUID()}`;
    // Seed history rather than invoke a paid agent. A failed previous generation
    // deliberately parks new queued work in the real server's queue dispatcher.
    await db.insert(chatConversations).values({ id: chatId, orgId: org.id, title: "Queue live regression", preferredAgentId: agent.id });
    await db.insert(chatMessages).values({ orgId: org.id, conversationId: chatId, role: "assistant", kind: "message", status: "completed", body: "Idle queue regression history" });
    await db.insert(chatGenerations).values({ orgId: org.id, conversationId: chatId, status: "failed", terminalReason: "runtime_error", completedAt: new Date() });

    const frames: { at: number; dropped: boolean; payload: string }[] = [];
    const transport: { at: number; event: string }[] = [];
    let dropEvents = false;
    let connections = 0;
    let disconnect = () => {};
    // Forward real server frames; only the reconnect case injects a lost-event
    // window and transport close. No HTTP response or application source mocks.
    await page.routeWebSocket(/\/events\/ws$/, (socket) => {
      const server = socket.connectToServer();
      connections += 1;
      transport.push({ at: Date.now(), event: "connect" });
      server.onMessage((message) => {
        frames.push({ at: Date.now(), dropped: dropEvents, payload: message.toString() });
        if (!dropEvents) socket.send(message);
      });
      disconnect = () => { transport.push({ at: Date.now(), event: "close" }); socket.close(); server.close(); };
    });
    const queuePath = `/api/chats/${chatId}/queue`;
    const reads: number[] = [];
    page.on("response", (response) => {
      if (response.request().method() === "GET" && new URL(response.url()).pathname === queuePath && response.ok()) reads.push(Date.now());
    });
    await page.goto(`${E2E_BASE_URL}/${org.issuePrefix}/messenger/chat/${chatId}`);
    await expect(page.getByText("Idle queue regression history", { exact: true })).toBeVisible();
    await expect.poll(() => connections).toBeGreaterThan(0);
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    const idleReads = reads.length;
    await page.waitForTimeout(6500);
    expect(reads.length, "an idle queue must not poll").toBe(idleReads);
    const url = page.url();
    const continuity: string[] = [];
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) continuity.push("navigation"); });
    await page.exposeFunction("recordQueueFocus", (event: string) => continuity.push(event));
    await page.evaluate(() => {
      for (const event of ["focus", "blur", "online", "offline"]) {
        window.addEventListener(event, () => (window as unknown as { recordQueueFocus: (event: string) => void }).recordQueueFocus(event));
      }
    });
    await page.screenshot({ path: testInfo.outputPath(`${recovery}-idle.png`) });
    const unrelatedId = randomUUID();
    await db.insert(chatConversations).values({ id: unrelatedId, orgId: org.id, title: "Unrelated queue", preferredAgentId: agent.id });
    await db.insert(chatGenerations).values({ orgId: org.id, conversationId: unrelatedId, status: "failed", completedAt: new Date() });
    const unrelatedPath = `/api/chats/${unrelatedId}/queue`;
    const unrelated = await page.request.post(unrelatedPath, { data: { clientMutationId: randomUUID(), payload: { body: "Unrelated work" } } });
    expect(unrelated.ok()).toBe(true);
    const unrelatedItem = await unrelated.json();
    await expect.poll(() => frames.some((frame) => frame.payload.includes(unrelatedId) && frame.payload.includes("chat.queue.created"))).toBe(true);
    await page.waitForTimeout(1000);
    expect(reads.length, "another conversation must not wake this queue").toBe(idleReads);
    expect((await page.request.delete(`${unrelatedPath}/${unrelatedItem.id}`, { data: { version: unrelatedItem.version } })).ok()).toBe(true);

    dropEvents = recovery === "reconnect";
    const queuedResponse = await page.request.post(queuePath, { data: { clientMutationId: randomUUID(), payload: { body } } });
    expect(queuedResponse.ok(), await queuedResponse.text()).toBe(true);
    const queued = await queuedResponse.json();
    await expect.poll(() => frames.some((frame) => frame.payload.includes(queued.id) && frame.payload.includes("chat.queue.created"))).toBe(true);
    const persisted = await (await page.request.get(queuePath)).json();
    expect(persisted.items.some((item: { id: string }) => item.id === queued.id)).toBe(true);
    if (recovery === "reconnect") {
      await page.waitForTimeout(2500);
      expect(reads.length, "lost events leave the idle cache untouched").toBe(idleReads);
      expect(await page.getByText(body, { exact: true }).count()).toBe(0);
      const beforeReconnect = connections;
      dropEvents = false;
      disconnect();
      await expect.poll(() => connections).toBeGreaterThan(beforeReconnect);
    }
    await expect(page.getByText(body, { exact: true })).toBeVisible({ timeout: 8000 });
    expect(reads.length, "event/reconnect must wake the actual Chat queue observer").toBeGreaterThan(idleReads);
    const activeReads = reads.length;
    await expect.poll(() => reads.length, { timeout: 6000 }).toBeGreaterThanOrEqual(activeReads + 2);
    expect(page.url()).toBe(url);
    await page.screenshot({ path: testInfo.outputPath(`${recovery}-queued.png`) });

    const cancel = await page.request.delete(`${queuePath}/${queued.id}`, { data: { version: queued.version } });
    expect(cancel.ok(), await cancel.text()).toBe(true);
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    const terminal = await (await page.request.get(queuePath)).json();
    expect((await cancel.json()).status).toBe("cancelled");
    expect(terminal.items.some((item: { id: string }) => item.id === queued.id)).toBe(false);
    await page.waitForTimeout(1000);
    const terminalReads = reads.length;
    await page.waitForTimeout(6500);
    expect(reads.length, "terminal convergence must stop queue polling").toBe(terminalReads);
    expect(page.url()).toBe(url);
    expect(continuity).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${recovery}-terminal.png`) });
    await testInfo.attach("queue-evidence", { body: JSON.stringify({ orgId: org.id, chatId, url, recovery, idleReads, activeReads, terminalReads, reads, connections, continuity, frames, transport, queued, persisted, terminal }), contentType: "application/json" });
  });
}
