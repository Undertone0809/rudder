import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_ROOT } from "./support/e2e-env";

type Projection = {
  run: { status: string; externalRunId: string | null; sessionIdAfter: string | null;
    finishedAt: string | null; resultJson: unknown; contextSnapshot: { transcriptSource: string } };
  source: string;
  availability: string;
  completeness: string;
  revision: string;
  page: { hasMore: boolean };
  trace: { turnCount: number };
  entries: Array<{ id: string; sourceEntryId: string;
    entry: { kind: string; sourceEntryId: string; text?: string; [key: string]: unknown };
    output: unknown }>;
};

const objectRows = (projection: Projection) => projection.entries.filter((item) => item.sourceEntryId.startsWith("tobj_v1_"));
const nativeRows = (projection: Projection) => projection.entries.filter((item) => !item.sourceEntryId.startsWith("tobj_v1_"));
// step-N is a projection position, not immutable source provenance. Compare
// canonical object IDs + complete entry/output payload, never positional IDs.
const canonicalObject = (item: Projection["entries"][number]) => ({
  sourceEntryId: item.sourceEntryId, entry: item.entry, output: item.output,
});
function assertObjectProvenance(projection: Projection) {
  const objects = objectRows(projection);
  expect(new Set(objects.map((item) => item.sourceEntryId)).size).toBe(objects.length);
  for (const item of objects) {
    expect(item.sourceEntryId).toMatch(/^tobj_v1_[a-f0-9-]+:entry:.+$/);
    expect(item.entry.sourceEntryId).toBe(item.sourceEntryId);
  }
}
// Trace-backed allowlist for this fixture only: startup configuration/skills/
// instructions diagnostics, init identity, and turn-start notification. This
// is NOT a policy for dropping real reasoning, tools, or assistant process.
const startupDiagnostic = /^\[rudder\] (?:Mirrored shared Codex auth into isolated home |Removed \d+ inherited Codex MCP configuration tables from |Removed \d+ inherited Codex notify hook from |Removed \d+ unsupported inherited Codex service_tier entry from |Added a disabled Codex plugins default to |Added a disabled Codex bundled-skills default to |Using Rudder-managed Codex home |Disabled \d+ external Codex skill paths in |Prepared isolated Git config at |Realized \d+ Rudder-managed Codex skill entries in |Using operator HOME |Loaded agent instructions file: |Loaded agent tool notes file: |Loaded agent memory instructions file: )[^\r\n]+$/;
function assertStartupObjects(projection: Projection) {
  assertObjectProvenance(projection);
  for (const { entry } of objectRows(projection)) {
    expect(["stdout", "init", "system"]).toContain(entry.kind);
    if (entry.kind === "stdout") expect(entry.text?.trim()).toMatch(startupDiagnostic);
    else if (entry.kind === "init") {
      expect(entry.model).toBe("gpt-5.4");
      expect(entry.sessionId).toEqual(expect.any(String));
      expect(entry.sessionId).not.toBe("");
    } else expect(entry.text).toBe("turn started");
  }
}
function assertUnpublishedNative(projection: Projection) {
  expect(projection).toMatchObject({ completeness: "unknown", page: { hasMore: false }, trace: { turnCount: 0 },
    run: { status: "running", externalRunId: null, sessionIdAfter: null, finishedAt: null,
      resultJson: null, contextSnapshot: { transcriptSource: "native" } } });
  // Public run metadata exposes unresolved completion identity, not the raw
  // Span selector. Object availability must not imply native publication.
  expect(nativeRows(projection)).toEqual([]);
  expect(projection.entries.filter((item) => item.entry.kind === "user" || item.entry.kind === "assistant")).toEqual([]);
  assertStartupObjects(projection);
  if (objectRows(projection).length > 0) {
    expect(projection).toMatchObject({ source: "native_plus_objects", availability: "available" });
  } else {
    expect(projection).toMatchObject({ source: "native", availability: "pending", entries: [] });
  }
}
function assertObjectsPreserved(baseline: Projection, projection: Projection) {
  assertObjectProvenance(projection);
  const current = new Map(objectRows(projection).map((item) => [item.sourceEntryId, canonicalObject(item)]));
  for (const item of objectRows(baseline)) {
    expect(current.get(item.sourceEntryId)).toEqual(canonicalObject(item));
  }
}
function assertStartupRetirement(baseline: Projection, projection: Projection) {
  assertStartupObjects(baseline);
  assertStartupObjects(projection);
  const prior = new Map(objectRows(baseline).map((item) => [item.sourceEntryId, canonicalObject(item)]));
  // Complete native preference may retire transient startup objects. Any that
  // remain must keep their own source ID/payload, never masquerade as native.
  for (const item of objectRows(projection)) {
    if (prior.has(item.sourceEntryId)) expect(canonicalObject(item)).toEqual(prior.get(item.sourceEntryId));
  }
}
function assertPublishedNative(projection: Projection, userId: string, assistantId: string, marker: string) {
  expect(projection).toMatchObject({ availability: "available", completeness: "complete", page: { hasMore: false } });
  expect(projection.source).toBe(objectRows(projection).length ? "native_plus_objects" : "native");
  assertObjectProvenance(projection);
  const authoritative = nativeRows(projection);
  expect(authoritative).toHaveLength(2);
  expect(authoritative.filter((item) => item.entry.kind === "user")).toMatchObject([
    { sourceEntryId: userId, entry: { sourceEntryId: userId } },
  ]);
  expect(authoritative.filter((item) => item.entry.kind === "assistant")).toMatchObject([
    { sourceEntryId: assistantId, entry: { sourceEntryId: assistantId, text: marker } },
  ]);
}

// Protocol-fixture E2E through public Chat/Run/Reader + rendered Run Detail.
// Native publication phases have no API interception, DB mutation, real Codex
// inference, or retained-log fallback. The bounded UI regression phase below
// injects empty/missing only in the Run Detail response while the real fixture
// run remains held; it does not claim the native Reader emitted missing.
// Packet v5: preserve startup objects before publication; complete native
// history may retire them (Plan W12 temporary stdout), not claim equivalence.
test("native Run transcript preserves available diagnostics until exact native publication and terminal reload", async ({ page, context }, testInfo) => {
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
  const stream = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().endsWith("/messages/stream"));
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
    assertUnpublishedNative(pending);
    const detailUrl = `/${org.urlKey}/agents/${agent.urlKey}/runs/${runId}`;
    const uiRead = () => runPage.waitForResponse((response) => response.request().method() === "GET"
      && response.url().includes(`/api/run-intelligence/runs/${runId}/transcript`));
    const initialUiRead = uiRead();
    await runPage.goto(detailUrl);
    const initialUiResponse = await initialUiRead;
    expect(initialUiResponse.ok()).toBe(true);
    const initialUiProjection = await initialUiResponse.json() as Projection;
    // Actual Run Detail DOM has no role=tabpanel wrapper. The existing Expand
    // transcript control identifies its rounded card, not the Replies card.
    const transcript = runPage.locator(".run-detail-container div.rounded-2xl")
      .filter({ has: runPage.getByRole("button", { name: "Expand transcript", exact: true }) });
    await expect(transcript).toHaveCount(1);
    await expect(transcript).toBeVisible();
    const assertSingleFinal = async () => {
      await expect(transcript.getByText("Final response", { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(transcript.getByText(marker, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(transcript.getByText(marker, { exact: true })).toHaveCount(1);
    };
    const assertRenderedUnpublished = async (projection: Projection) => {
      assertUnpublishedNative(projection);
      // Bind the positive render oracle to this UI request, not an earlier API
      // snapshot: canonical diagnostics may grow while native output is held.
      if (objectRows(projection).length > 0) {
        const count = projection.entries.length;
        await expect(transcript.getByText(`${count} ${count === 1 ? "entry" : "entries"}`, { exact: true })).toBeVisible();
      } else {
        await expect(transcript.getByText("Waiting for transcript...", { exact: true })).toBeVisible();
      }
    };
    await assertRenderedUnpublished(initialUiProjection);
    await expect(transcript.getByText("Transcript missing.", { exact: true })).toHaveCount(0);
    await expect(transcript.getByRole("alert").filter({ hasText: /Transcript unavailable:/i })).toHaveCount(0);
    expect(await missingAlerts()).toEqual([]);
    await runPage.screenshot({ path: path.join(directory, "native-running-unpublished.png"), fullPage: true });
    const reloadedUiRead = uiRead();
    await runPage.reload();
    const reloadedUiResponse = await reloadedUiRead;
    expect(reloadedUiResponse.ok()).toBe(true);
    const reloadedUiProjection = await reloadedUiResponse.json() as Projection;
    await expect(transcript).toBeVisible();
    await assertRenderedUnpublished(reloadedUiProjection);
    const pendingReload = await readProjection();
    assertUnpublishedNative(pendingReload);
    assertObjectsPreserved(pending, pendingReload);
    await expect(transcript.getByText("Transcript missing.", { exact: true })).toHaveCount(0);
    await expect(transcript.getByRole("alert").filter({ hasText: /Transcript unavailable:/i })).toHaveCount(0);
    expect(await missingAlerts()).toEqual([]);

    // Nadia live-empty UI regression: native pending is already covered above.
    // Hold the SAME fixture run and explicitly inject missing + empty into only
    // this page's read response, without changing backend/span/native state.
    const transcriptRoute = `**/api/run-intelligence/runs/${runId}/transcript?*`;
    let missingReads = 0;
    await runPage.route(transcriptRoute, async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const projection = await response.json() as Projection;
      assertUnpublishedNative(projection);
      missingReads++;
      await route.fulfill({ response, json: { ...projection, availability: "missing", entries: [],
        trace: { ...projection.trace, turnCount: 0 }, page: { ...projection.page, hasMore: false } } });
    });
    try {
      for (let read = 0; read < 2; read++) {
        const readsBeforeReload = missingReads;
        const missingUiRead = uiRead();
        await runPage.reload();
        const missingUiResponse = await missingUiRead;
        expect(missingUiResponse.ok()).toBe(true);
        expect(await missingUiResponse.json()).toMatchObject({ availability: "missing", entries: [],
          run: { status: "running" } });
        await expect.poll(() => missingReads).toBeGreaterThan(readsBeforeReload);
        await expect(transcript.getByText("Waiting for transcript...", { exact: true })).toBeVisible();
        await expect(transcript.getByText("Transcript missing.", { exact: true })).toHaveCount(0);
        await expect(transcript.getByRole("alert").filter({ hasText: /Transcript unavailable:/i })).toHaveCount(0);
        expect(await missingAlerts()).toEqual([]);
      }
      await runPage.screenshot({ path: path.join(directory, "native-running-empty-missing-waiting.png"), fullPage: true });
    } finally {
      await runPage.unroute(transcriptRoute);
    }
    const restoredUiRead = uiRead();
    await runPage.reload();
    const restoredUiResponse = await restoredUiRead;
    expect(restoredUiResponse.ok()).toBe(true);
    await assertRenderedUnpublished(await restoredUiResponse.json() as Projection);

    await writeFile(`${gate}.release`, "release");
    let available: Projection | undefined;
    await expect.poll(async () => {
      available = await readProjection();
      return { availability: available.availability, completeness: available.completeness,
        nativeKinds: nativeRows(available).map((item) => item.entry.kind) };
    }, { timeout: 30_000 }).toEqual({ availability: "available", completeness: "complete", nativeKinds: ["user", "assistant"] });
    // Publication may coincide with terminalization; do not fabricate an
    // available-while-running state or mutate a native span to force one.
    await expect.poll(async () => {
      const response = await page.request.get(`/api/agent-runs/${runId}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).status;
    }, { timeout: 30_000 }).toBe("succeeded");
    expect(await (await stream).finished()).toBeNull();
    await assertSingleFinal();
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
    assertPublishedNative(available!, user[0].id, assistant[0].id, marker);
    assertStartupRetirement(pendingReload, available!);
    const terminal = await readProjection();
    assertPublishedNative(terminal, user[0].id, assistant[0].id, marker);
    assertStartupRetirement(available!, terminal);
    await runPage.screenshot({ path: path.join(directory, "native-available-terminal.png"), fullPage: true });
    const terminalUiRead = uiRead();
    await runPage.reload();
    expect((await terminalUiRead).ok()).toBe(true);
    await assertSingleFinal();
    await expect(transcript.getByText("Transcript missing.", { exact: true })).toHaveCount(0);
    await expect(transcript.getByRole("alert").filter({ hasText: /Transcript unavailable:/i })).toHaveCount(0);
    expect(await missingAlerts()).toEqual([]);
    const refreshed = await readProjection();
    assertPublishedNative(refreshed, user[0].id, assistant[0].id, marker);
    assertStartupRetirement(terminal, refreshed);
    expect(identities(refreshed)).toEqual(identities(terminal));
    expect(refreshed.revision).toBe(terminal.revision);
    await runPage.screenshot({ path: path.join(directory, "native-terminal-reload.png"), fullPage: true });
    await testInfo.attach("native-publication-evidence", { body: JSON.stringify({ orgId: org.id, agentId: agent.id,
      criteriaPacket: "native-publication-v5", runId, ready, pending, initialUiProjection, reloadedUiProjection,
      pendingReload, available, terminal, refreshed,
      emptyMissingUiRegression: { responseOnlyInjection: true, actualReaderMissingClaim: false,
        heldRunStatus: "running", missingReads, reloads: 2 },
      startupObjectPolicy: "trace-classified startup diagnostics may retire after complete native publication; not equivalent to native content or proof of real process-gap preservation",
      unresolvedNativeEvidence: { rawSpanSelectorExposed: false, publicProof: "running + unknown completeness + null completion identity + no native rows" },
      artifactDirectory: directory }), contentType: "application/json" });
  } finally {
    await writeFile(`${gate}.release`, "release");
    await runPage.close();
  }
});
