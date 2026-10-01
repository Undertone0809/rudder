import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { createDb, heartbeatRuns, nativeSegments, runRuntimeSpans, runtimeBindings } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const db = createDb(E2E_DATABASE_URL);
test.afterAll(async () => { await db.$client.end(); });

// Protocol fixture, not installed-Pi/provider acceptance. Mirrors Pi 0.76's
// native fork-before-user and clone-at-head semantics. It never loads extensions,
// contacts a provider, or fabricates a successful Rudder tool call.
const PI_RPC_FIXTURE = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.76.0"); process.exit(0); }
if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "rpc") process.exit(2);
let file = args[args.indexOf("--session") + 1];
const auditFile = path.join(process.cwd(), "pi-rpc-audit.jsonl");
function load() { return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
function append(entry) { fs.appendFileSync(file, JSON.stringify(entry) + "\n"); }
// Pi initializes its persisted session before answering the first get_state.
// The adapter reads the initial leaf and attests this provider ID before prompt.
if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").trim()) {
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
}
if (load()[0]?.type !== "session" || !load()[0]?.id) throw new Error("Invalid fixture session header");
function entryId() {
  const used = new Set(load().map(entry => entry.id));
  let id;
  do { id = randomBytes(4).toString("hex"); } while (used.has(id));
  return id;
}
function leaf(entries) { return entries.filter(e => e.type !== "session").at(-1)?.id ?? null; }
function reply(request, data) { console.log(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data })); }
function fail(request, error) { console.log(JSON.stringify({ type: "response", id: request.id, command: request.type, success: false, error })); }
function currentMessageBody(input) {
  const marker = "Conversation input:";
  const start = input.lastIndexOf(marker);
  const tail = input.slice(start + marker.length);
  const end = tail.indexOf("\n\nFinal Rudder result reminder:");
  if (start < 0 || end < 0) throw new Error("Missing fixture conversation input envelope");
  return JSON.parse(tail.slice(0, end).trim()).currentMessage.body;
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "get_state") {
    const entries = load();
    reply(request, { sessionFile: file, sessionId: entries[0]?.id, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  } else if (request.type === "fork" || request.type === "clone") {
    const entries = load();
    const selected = entries.find(e => e.id === request.entryId);
    if (request.type === "fork" && (selected?.type !== "message" || selected.message?.role !== "user")) { fail(request, "Invalid entry ID for forking"); return; }
    const boundary = request.type === "clone" ? leaf(entries) : selected.parentId;
    const byId = new Map(entries.map(e => [e.id, e]));
    const branch = []; let current = byId.get(boundary);
    while (current) { branch.unshift(current); current = byId.get(current.parentId); }
    const sourceFile = file;
    file = path.join(path.dirname(file), randomUUID() + ".jsonl");
    const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd(), parentSession: sourceFile };
    fs.writeFileSync(file, [header, ...branch].map(e => JSON.stringify(e)).join("\n") + "\n");
    fs.appendFileSync(auditFile, JSON.stringify({ type: request.type, sourceFile, childFile: file, entryId: request.entryId, boundary }) + "\n");
    reply(request, { cancelled: false });
  } else if (request.type === "prompt") {
    const entries = load();
    const priorLeaf = leaf(entries);
    const input = String(request.message ?? "");
    // Recent context can mention a previous marker. Dispatch only this Send's
    // currentMessage, never the bootstrap/context text surrounding it.
    const body = currentMessageBody(input);
    const label = ["PI_MAIN1", "PI_MAIN2", "PI_SIDE1", "PI_SIDE2"].find(marker => body === marker);
    if (!label) { fail(request, "Unexpected fixture prompt"); return; }
    const priorText = JSON.stringify(entries);
    const text = label === "PI_SIDE1"
      ? "Pi Side1: Main1=" + priorText.includes("Pi Main1") + "; Main2=" + priorText.includes("Pi Main2")
      : label === "PI_SIDE2"
        ? "Pi Side2: Side1=" + priorText.includes("Pi Side1") + "; Main2=" + priorText.includes("Pi Main2")
        : label === "PI_MAIN1" ? "Pi Main1" : "Pi Main2";
    const userId = entryId();
    append({ type: "message", id: userId, parentId: priorLeaf, timestamp: new Date().toISOString(), message: { role: "user", content: input } });
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
    append({ type: "message", id: entryId(), parentId: userId, timestamp: new Date().toISOString(), message });
    fs.appendFileSync(auditFile, JSON.stringify({ type: "prompt", file, label, priorLeaf }) + "\n");
    reply(request, {});
    console.log(JSON.stringify({ type: "message_end", message }));
    console.log(JSON.stringify({ type: "agent_end", messages: [message] }));
  } else { fail(request, "Unsupported fixture RPC: " + request.type); }
});
`;

async function jsonl(file: string): Promise<Array<Record<string, any>>> {
  return (await fs.readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function runsFor(conversationId: string) {
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.chatConversationId, conversationId))
    .orderBy(asc(heartbeatRuns.startedAt));
}

function currentMessageBody(input: string): string {
  const marker = "Conversation input:";
  const start = input.lastIndexOf(marker);
  const tail = input.slice(start + marker.length);
  const end = tail.indexOf("\n\nFinal Rudder result reminder:");
  if (start < 0 || end < 0) throw new Error("Missing fixture conversation input envelope");
  return JSON.parse(tail.slice(0, end).trim()).currentMessage.body;
}

async function send(page: Page, composer: Locator, button: Locator, prompt: string, reply: Locator, text: string) {
  await composer.fill(prompt);
  const streamPromise = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().endsWith("/messages/stream"));
  await button.click();
  const stream = await streamPromise;
  expect(stream.ok(), await stream.text()).toBe(true);
  await stream.finished();
  await expect(reply).toContainText(text, { timeout: 30_000 });
}

async function reader(page: Page, run: typeof heartbeatRuns.$inferSelect, prompt: string, answer: string) {
  const runId = run.id;
  const nativeRecords = await jsonl(run.sessionIdAfter!);
  expect(nativeRecords[0]).toMatchObject({ type: "session", id: run.sessionParamsAfterJson?.providerSessionId });
  const nativeUsers = nativeRecords.filter((record) => record.type === "message"
    && record.message?.role === "user" && currentMessageBody(String(record.message.content)) === prompt);
  expect(nativeUsers).toHaveLength(1);
  const nativeUser = nativeUsers[0]!;
  const nativeAssistants = nativeRecords.filter((record) => record.type === "message"
    && record.message?.role === "assistant" && record.parentId === nativeUser.id);
  expect(nativeAssistants).toHaveLength(1);
  const nativeAssistant = nativeAssistants[0]!;
  expect(nativeUser.id).toMatch(/^[a-f0-9]{8}$/u);
  expect(nativeAssistant.id).toMatch(/^[a-f0-9]{8}$/u);
  expect(nativeAssistant.message.content).toEqual([{ type: "text", text: answer }]);
  expect(run.sessionParamsAfterJson).toMatchObject({
    leafId: nativeAssistant.id, previousLeafId: nativeUser.parentId,
  });
  const response = await page.request.get(`/api/run-intelligence/runs/${runId}/transcript?output=full&order=oldest&turnLimit=200`);
  expect(response.ok(), await response.text()).toBe(true);
  const transcript = await response.json();
  expect(transcript).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
  const entries = transcript.entries.map((item: { entry: Record<string, any> }) => item.entry);
  expect(entries.filter((entry: Record<string, any>) => entry.kind === "user").map((entry: Record<string, any>) => entry.text))
    .toEqual([nativeUser.message.content]);
  expect(entries.filter((entry: Record<string, any>) => entry.kind === "assistant").map((entry: Record<string, any>) => entry.text))
    .toEqual([answer]);
  expect(entries.map((entry: Record<string, any>) => ({ kind: entry.kind, sourceEntryId: entry.sourceEntryId })))
    .toEqual([
      { kind: "user", sourceEntryId: nativeUser.id },
      { kind: "assistant", sourceEntryId: nativeAssistant.id },
    ]);
  const ids = [nativeUser.id as string, nativeAssistant.id as string];
  const spans = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, runId));
  expect(spans).toHaveLength(1);
  expect(spans[0]!.selectorJson).toMatchObject({
    kind: "pi_branch_range", sessionResourceRef: run.sessionIdAfter,
    fromExclusive: nativeUser.parentId, throughInclusive: nativeAssistant.id, leafId: nativeAssistant.id,
  });
  return { runId, spanId: spans[0]!.id, selector: spans[0]!.selectorJson, ids };
}

async function messages(page: Page, conversationId: string) {
  const response = await page.request.get(`/api/chats/${conversationId}/messages`);
  expect(response.ok()).toBe(true);
  return (await response.json() as Array<Record<string, any>>)
    .map(({ id, role, body, runId, status }) => ({ id, role, body, runId, status }));
}

test("Pi Main2 forks historical Main1 natively, keeps Side2 in the child, and reads four exact turns", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-pi-fork-"));
  const command = path.join(directory, "pi-rpc-fixture.mjs");
  await fs.writeFile(command, PI_RPC_FIXTURE, { mode: 0o755 });
  // Retain fixture/session evidence in temp on failure; no broad cleanup/restart.
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Pi Native Fork ${Date.now()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agent = await createE2EChatAgent(page.request, org.id, {
    name: "Pi native fork fixture", agentRuntimeType: "pi_local",
    agentRuntimeConfig: { command, cwd: directory, model: "openai/pi-e2e-fixture" },
  });
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);
  const mainComposer = page.getByTestId("chat-composer-editor-scroll").locator(".rudder-mdxeditor-content").first();
  const mainReply = page.getByTestId("chat-assistant-message").last();
  await send(page, mainComposer, page.getByRole("button", { name: "Send", exact: true }), "PI_MAIN1", mainReply, "Pi Main1");
  const parentId = new URL(page.url()).pathname.split("/").at(-1)!;
  const sourceMessageId = await mainReply.getAttribute("data-message-id");
  expect(sourceMessageId).toBeTruthy();
  await send(page, mainComposer, page.getByRole("button", { name: "Send", exact: true }), "PI_MAIN2", mainReply, "Pi Main2");
  const parentRuns = await runsFor(parentId);
  expect(parentRuns.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
  const parentSession = parentRuns[0]!.sessionIdAfter!;
  expect(parentSession).toBeTruthy();
  expect(parentRuns[1]!.sessionIdBefore).toBe(parentSession);
  expect(parentRuns[1]!.sessionIdAfter).toBe(parentSession);
  const parentBytes = await fs.readFile(parentSession, "utf8");
  const parentMessages = await messages(page, parentId);
  const draft = "Preserve Pi parent draft; never send";
  await mainComposer.fill(draft);
  const source = page.getByTestId("chat-assistant-message").filter({ hasText: "Pi Main1" });
  await source.hover();
  await source.locator('[data-testid="chat-message-actions-trigger"]:visible').click();
  await page.getByTestId("chat-message-actions-menu").getByRole("menuitem", { name: "Open Side Chat" }).click();
  const panel = page.getByTestId("chat-side-panel");
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  const sideComposer = panel.locator('[data-testid="side-chat-composer"]:visible .rudder-mdxeditor-content').first();
  const sideReply = panel.getByTestId("chat-assistant-message").last();
  const childPromise = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().includes(`/api/chats/${parentId}/side-chats`));
  const side1Answer = "Pi Side1: Main1=true; Main2=false";
  await send(page, sideComposer, panel.getByRole("button", { name: "Send Side Chat message" }), "PI_SIDE1", sideReply, side1Answer);
  const childResponse = await childPromise;
  expect(childResponse.ok(), await childResponse.text()).toBe(true);
  expect(childResponse.request().postDataJSON()).toMatchObject({ sourceMessageId });
  const child = await childResponse.json();
  expect(child).toMatchObject({ forkedFromConversationId: parentId, forkedFromMessageId: sourceMessageId });
  const side2Answer = "Pi Side2: Side1=true; Main2=false";
  await send(page, sideComposer, panel.getByRole("button", { name: "Send Side Chat message" }), "PI_SIDE2", sideReply, side2Answer);
  const childRuns = await runsFor(child.id);
  expect(childRuns.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
  const childSession = childRuns[0]!.sessionIdAfter!;
  expect(childSession).toBeTruthy();
  expect(childSession).not.toBe(parentSession);
  expect(childRuns.every((run) => run.sessionIdBefore === childSession && run.sessionIdAfter === childSession)).toBe(true);
  const [binding] = await db.select().from(runtimeBindings).where(eq(runtimeBindings.conversationId, child.id));
  expect(binding).toMatchObject({ continuity: "native", runtimeType: "pi_local" });
  const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, binding!.currentSegmentId!));
  const sourceBoundary = parentRuns[0]!.sessionParamsAfterJson?.leafId;
  expect(sourceBoundary).toEqual(expect.any(String));
  const [sourceSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, parentRuns[0]!.id));
  expect(segment?.providerStateJson?.__rudderNativeForkIntent).toMatchObject({
    status: "accepted", idempotencyKey: `side-chat:${child.id}`,
    source: {
      sourceConversationId: parentId, sourceRunId: parentRuns[0]!.id,
      sourceSpanId: sourceSpan!.id, sourceBoundaryRef: sourceBoundary,
      selectorJson: { kind: "pi_branch_range", throughInclusive: sourceBoundary },
    },
  });
  const audit = await jsonl(path.join(directory, "pi-rpc-audit.jsonl"));
  expect(audit.filter((entry) => entry.type === "prompt").map((entry) => entry.label))
    .toEqual(["PI_MAIN1", "PI_MAIN2", "PI_SIDE1", "PI_SIDE2"]);
  expect(audit.filter((entry) => entry.type === "fork" || entry.type === "clone"))
    .toEqual([expect.objectContaining({ type: "fork", sourceFile: parentSession, childFile: childSession, boundary: sourceBoundary })]);
  const childEntries = await jsonl(childSession);
  const parentEntries = await jsonl(parentSession);
  expect(childEntries.filter((entry) => entry.type === "message").slice(0, 2))
    .toEqual(parentEntries.filter((entry) => entry.type === "message").slice(0, 2));
  expect(JSON.stringify(childEntries)).not.toContain("PI_MAIN2");
  expect(JSON.stringify(childEntries)).not.toContain("Pi Main2");
  expect(await fs.readFile(parentSession, "utf8")).toBe(parentBytes);
  const runs = [...parentRuns, ...childRuns];
  expect(new Set(runs.map((run) => run.id)).size).toBe(4);
  const readers = [];
  for (const [index, run] of runs.entries()) {
    readers.push(await reader(page, run, ["PI_MAIN1", "PI_MAIN2", "PI_SIDE1", "PI_SIDE2"][index]!,
      ["Pi Main1", "Pi Main2", side1Answer, side2Answer][index]!));
  }
  expect(new Set(readers.map((entry) => entry.spanId)).size).toBe(4);
  for (const [index, current] of readers.entries()) {
    for (const other of readers.slice(index + 1)) expect(current.ids.filter((id) => other.ids.includes(id))).toEqual([]);
  }
  const childMessages = await messages(page, child.id);
  expect(await messages(page, parentId)).toEqual(parentMessages);
  await expect(mainComposer).toHaveText(draft);
  await page.reload();
  await expect(panel.getByTestId("side-chat-panel-view")).toBeVisible();
  await expect(sideReply).toContainText(side2Answer);
  await expect(mainComposer).toHaveText(draft);
  await expect(page.getByTestId("chat-assistant-message").filter({ hasText: "Pi Main2" })).toHaveCount(1);
  expect(await messages(page, parentId)).toEqual(parentMessages);
  expect(await messages(page, child.id)).toEqual(childMessages);
  for (const [index, run] of runs.entries()) {
    expect(await reader(page, run, ["PI_MAIN1", "PI_MAIN2", "PI_SIDE1", "PI_SIDE2"][index]!,
      ["Pi Main1", "Pi Main2", side1Answer, side2Answer][index]!)).toEqual(readers[index]);
  }
  expect(await fs.readFile(parentSession, "utf8")).toBe(parentBytes);
  expect((await runsFor(parentId)).map((run) => [run.id, run.sessionIdAfter])).toEqual(parentRuns.map((run) => [run.id, run.sessionIdAfter]));
  expect((await runsFor(child.id)).map((run) => [run.id, run.sessionIdAfter])).toEqual(childRuns.map((run) => [run.id, run.sessionIdAfter]));
  await testInfo.attach("pi-native-fork-fixture-evidence", {
    body: JSON.stringify({ fixtureOnly: true, directory, parentId, childId: child.id, sourceMessageId, parentSession, childSession, readers, audit }),
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("pi-historical-side2-refreshed.png"), fullPage: true });
});
