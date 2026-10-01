import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_ROOT } from "./support/e2e-env";

type Projection = {
  source: string;
  availability: string;
  completeness: string;
  revision: string;
  page: { hasMore: boolean };
  entries: Array<{ id: string; sourceEntryId: string; entry: { kind: string; sourceEntryId: string; text?: string } }>;
};

// Protocol-fixture E2E through public Chat/Run/Reader + rendered Run Detail.
// No API interception, DB mutation, real Codex inference, or retained-log fallback.
test("native Run transcript waits for publication then retains exact source IDs after terminal reload", async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "rudder-native-live-transcript-"));
  const nonce = randomUUID().replaceAll("-", "");
  const gate = path.join(directory, nonce);
  const marker = `NATIVE_LIVE_REPLY_${nonce}`;
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Native publication ${nonce}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agent = await createE2EChatAgent(page.request, org.id, {
    name: "Native publication inspector",
    agentRuntimeConfig: { command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
      model: "gpt-5.4", chatAppServerEnabled: true,
      env: { RUDDER_E2E_NATIVE_TRANSCRIPT_GATE: directory } },
  });
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await composer.fill(`Native transcript publication nonce: ${nonce}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Keep the submitting Chat mounted; navigating it away could cancel its stream.
  const runPage = await context.newPage();
  await runPage.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __nativePublicationMissingAlerts: seen });
    new MutationObserver(() => {
      const text = document.querySelector(".run-detail-container")?.textContent ?? "";
      if (/Transcript missing\.|Transcript unavailable:/i.test(text)) seen.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const missingAlerts = () => runPage.evaluate(() =>
    (window as unknown as { __nativePublicationMissingAlerts: string[] }).__nativePublicationMissingAlerts);
  let runId = "";
  try {
    let ready: { threadId: string; turnId: string; userItemId: string; historyPath: string } | undefined;
    await expect.poll(async () => {
      try { ready = JSON.parse(await readFile(`${gate}.ready.json`, "utf8")); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }, { timeout: 30_000 }).toBe(true);
    expect(ready).toBeDefined();
    const runsResponse = await page.request.get(`/api/orgs/${org.id}/agent-runs?agentId=${agent.id}&limit=10`);
    expect(runsResponse.ok()).toBe(true);
    const runs = await runsResponse.json() as Array<{ id: string; status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    runId = runs[0].id;
    const readProjection = async (): Promise<Projection> => {
      const response = await page.request.get(`/api/run-intelligence/runs/${runId}/transcript?output=full&order=oldest&turnLimit=200&maxChars=20000`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const pending = await readProjection();
    expect(pending).toMatchObject({ source: "native", availability: "pending", completeness: "unknown", entries: [] });
    const detailUrl = `/${org.urlKey}/agents/${agent.urlKey}/runs/${runId}`;
    await runPage.goto(detailUrl);
    const transcript = runPage.locator(".run-detail-container");
    await expect(transcript).toContainText("Waiting for transcript...");
    await expect(transcript.getByText("Transcript missing.", { exact: true })).toHaveCount(0);
    expect(await missingAlerts()).toEqual([]);
    await runPage.screenshot({ path: path.join(directory, "native-running-pending.png"), fullPage: true });
    await runPage.reload();
    await expect(transcript).toContainText("Waiting for transcript...");
    expect(await readProjection()).toMatchObject({ source: "native", availability: "pending", entries: [] });
    expect(await missingAlerts()).toEqual([]);

    await writeFile(`${gate}.release`, "release");
    let available: Projection | undefined;
    await expect.poll(async () => {
      available = await readProjection();
      return available.availability;
    }, { timeout: 30_000 }).toBe("available");
    expect(available).toMatchObject({ source: "native", completeness: "complete", page: { hasMore: false } });
    // Publication may coincide with terminalization; do not fabricate an
    // available-while-running state or mutate a native span to force one.
    await expect.poll(async () => {
      const response = await page.request.get(`/api/agent-runs/${runId}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).status;
    }, { timeout: 30_000 }).toBe("succeeded");
    await expect(transcript).toContainText(marker, { timeout: 20_000 });
    await expect(transcript.getByText(marker, { exact: true })).toHaveCount(1);
    expect(await missingAlerts()).toEqual([]);
    const native = JSON.parse(await readFile(ready!.historyPath, "utf8")) as {
      id: string; turns: Array<{ id: string; items: Array<{ id: string; type: string; text?: string }> }>;
    };
    expect(native.id).toBe(ready!.threadId);
    expect(native.turns).toHaveLength(1);
    expect(native.turns[0].id).toBe(ready!.turnId);
    const user = native.turns[0].items.filter((item) => item.type === "userMessage");
    const assistant = native.turns[0].items.filter((item) => item.type === "agentMessage");
    expect(user).toHaveLength(1);
    expect(user[0].id).toBe(ready!.userItemId);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe(marker);
    const identities = (projection: Projection) => projection.entries.map((item) => ({
      id: item.id, sourceEntryId: item.sourceEntryId,
      entrySourceId: item.entry.sourceEntryId, kind: item.entry.kind,
    }));
    expect(available!.entries).toHaveLength(2);
    expect(available!.entries.filter((item) => item.entry.kind === "user")).toMatchObject([
      { sourceEntryId: user[0].id, entry: { sourceEntryId: user[0].id } },
    ]);
    expect(available!.entries.filter((item) => item.entry.kind === "assistant")).toMatchObject([
      { sourceEntryId: assistant[0].id, entry: { sourceEntryId: assistant[0].id, text: marker } },
    ]);
    const terminal = await readProjection();
    expect(identities(terminal)).toEqual(identities(available!));
    await runPage.screenshot({ path: path.join(directory, "native-available-terminal.png"), fullPage: true });
    await runPage.reload();
    await expect(transcript).toContainText(marker);
    await expect(transcript.getByText(marker, { exact: true })).toHaveCount(1);
    await expect(transcript.getByText("Transcript missing.", { exact: true })).toHaveCount(0);
    expect(await missingAlerts()).toEqual([]);
    const refreshed = await readProjection();
    expect(refreshed).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(identities(refreshed)).toEqual(identities(terminal));
    expect(refreshed.revision).toBe(terminal.revision);
    await runPage.screenshot({ path: path.join(directory, "native-terminal-reload.png"), fullPage: true });
    await testInfo.attach("native-publication-evidence", { body: JSON.stringify({ orgId: org.id, agentId: agent.id,
      runId, ready, pending, available, terminal, refreshed, artifactDirectory: directory }), contentType: "application/json" });
  } finally {
    await writeFile(`${gate}.release`, "release");
    await runPage.close();
  }
});
