import * as codex from "@rudderhq/agent-runtime-codex-local/server";
import { createCodexLocalProviderCapabilities } from "@rudderhq/agent-runtime-codex-local/server";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHistoricalRunNativeTranscriptReader, type HistoricalRunProfileRun } from "../services/run-intelligence.js";
import { createRuntimeNativeTranscriptReaderHook } from "../services/runtime-kernel/provider-capabilities.js";
import { createTranscriptReader } from "../services/runtime-kernel/transcript-reader.js";
import {
  databaseBinding,
  databaseRun,
  databaseSegment,
  databaseSpan,
  mockDatabase,
} from "../services/runtime-kernel/transcript-reader.test-support.js";

// Exercise the actual stdio adapter and public Reader together, without a model
// or persisted provider session. The DB fixture only supplies authorized scope.
const server = String.raw`
import readline from "node:readline";
const items = [
  { type: "userMessage", id: "user-1", content: [{ type: "text", text: "你好🧭" }] },
  { type: "mcpToolCall", id: "tool-1", server: "example", tool: "inspect", result: { ok: true } },
  { type: "agentMessage", id: "assistant-1", text: "Done" },
];
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const cursor = Number(message.params?.cursor ?? 0);
  let result;
  switch (message.method) {
    case "initialized": return;
    case "initialize": result = { userAgent: "synthetic-review" }; break;
    case "thread/read": result = { thread: { id: "thread-1", sessionId: "thread-1", updatedAt: 1726963200, turns: [] } }; break;
    case "thread/turns/list": result = { data: [{ id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" }], nextCursor: null }; break;
    case "thread/items/list": result = { data: [{ turnId: "turn-1", item: items[cursor] }], nextCursor: cursor < items.length - 1 ? String(cursor + 1) : null }; break;
    default: throw new Error("Unexpected provider method: " + message.method);
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
});
`;

function fixture(options?: { legacy?: boolean; script?: string; methods?: Record<string, boolean>; command?: string; args?: string[]; home?: string }) {
  const binding = {
    id: "binding-span-1", orgId: "org-1", hostId: "local", profileId: "profile-1",
    capabilityRevision: "cap-1", workspaceBindingId: null,
  };
  const sessionParams = {
    sessionId: "thread-1", transport: "codex_app_server", profileHostId: binding.hostId,
    profileId: binding.profileId, profileBindingId: binding.id, profileOrgId: binding.orgId,
    capabilityRevision: binding.capabilityRevision,
  };
  const selector = { kind: "codex_turn", threadId: "thread-1", turnId: "turn-1" };
  const runtimeConfig = {
    command: options?.command ?? process.execPath,
    extraArgs: options?.args ?? ["--input-type=module", "-e", options?.script ?? server, "--"],
    cwd: process.cwd(), codexHome: options?.home ?? "/tmp/rudder-synthetic-codex-reader-unused",
    providerVersion: "0.155.0-alpha.9.2",
    nativeCapabilityMethods: options?.methods ?? { threadResume: true, threadRead: true, threadFork: true },
  };
  const run = databaseRun({ agentRuntimeType: "codex_local", agentRuntimeConfig: runtimeConfig,
    runtimeConfig: {}, contextSnapshot: { transcriptSource: "native" } });
  const adapter = createCodexLocalProviderCapabilities({
    binding, command: process.execPath, args: ["--input-type=module", "-e", server, "--"],
    cwd: process.cwd(), env: { CODEX_HOME: "/tmp/rudder-synthetic-codex-reader-unused" }, providerVersion: "0.155.0-alpha.9.2",
    methods: { threadRead: true, threadTurnsList: true, threadItemsList: true },
  });
  const db = mockDatabase({
    run,
    spans: [databaseSpan("span-1", { selectorJson: selector })],
    bindings: [databaseBinding("span-1", { ...binding, runtimeType: "codex_local", continuity: "native" })],
    segments: [databaseSegment("span-1", {
      runtimeType: "codex_local", nativeSessionId: "thread-1", providerStateJson: sessionParams,
    })],
  });
  const nativeReader = options?.legacy
    ? createHistoricalRunNativeTranscriptReader(run as HistoricalRunProfileRun, [])
    : createRuntimeNativeTranscriptReaderHook(() => ({ adapter, binding, profileResolved: true }));
  return {
    db, nativeReader, run, binding, sessionParams, runtimeConfig,
    direct: () => adapter.transcript!.readRange!({
      runtimeType: "codex_local", binding, selector,
      session: { sessionId: "thread-1", sessionDisplayId: "thread-1", sessionParams },
      readerInput: { limit: 50, maxBytes: 8192, maxItemBytes: 4096 },
    }),
  };
}

describe("Codex array budgets through the full Transcript Reader", () => {
  it.each(["exact-array", "items-only", "split-projection"] as const)("preserves all projections at the %s boundary", async (boundary) => {
    const { db, nativeReader, direct } = fixture();
    const result = await direct();
    if (Array.isArray(result) || !("items" in result)) throw new Error("Expected native page");
    const items = result.items!;
    const arrayBytes = Buffer.byteLength(JSON.stringify(items));
    const budget = boundary === "exact-array" ? arrayBytes
      : boundary === "items-only" ? items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
      : Math.max(...items.map(item => Buffer.byteLength(JSON.stringify([item]))));
    const reader = createTranscriptReader(db as never, {
      nativeReader, maxNativeReadBytes: budget, maxNativeItemBytes: budget,
    });
    const ids: string[] = [];
    const revisions = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await reader.readRun({
        orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
        cursor, limit: 50,
      });
      ids.push(...page.items.map(item => item.id));
      revisions.add(page.revision);
      expect(page.availability).toBe("available");
      expect(page.completeness).toBe(page.nextCursor ? "partial" : "complete");
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(ids).toEqual(["user-1", "tool-1", "tool-1:tool_result:1", "assistant-1"]);
    expect(revisions.size).toBe(1);
    expect(pages).toBe(boundary === "exact-array" ? 1 : boundary === "items-only" ? 2 : 4);
  });
});

const request = { orgId: "org-1", runId: "run-1", principal: { type: "board" as const, orgId: "org-1", authorized: true } };

describe("historical Codex read-only pagination proof", () => {
  it.each(["old-three-fields", "missing-methods"])("reads the full Reader with %s without mutating historical identity", async variant => {
    const probe = vi.spyOn(codex, "probeCodexNativeTranscriptPagination");
    try {
      const data = fixture({ legacy: true, home: `/tmp/rudder-codex-history-${variant}`,
        ...(variant === "missing-methods" ? { methods: {} } : {}) });
      const before = JSON.stringify([data.run, data.binding, data.sessionParams]);
      const reference = await data.direct();
      if (Array.isArray(reference) || !("items" in reference)) throw new Error("Expected native reference page");
      const budget = Math.max(...reference.items!.map(item => Buffer.byteLength(JSON.stringify([item]))));
      const reader = createTranscriptReader(data.db as never, { nativeReader: data.nativeReader,
        maxNativeReadBytes: budget, maxNativeItemBytes: budget });
      let cursor: string | null = null;
      const ids: string[] = [];
      const revisions = new Set<string>();
      do {
        const page = await reader.readRun({ ...request, cursor, limit: 50 });
        expect(page.availability).toBe("available");
        expect(page.completeness).toBe(page.nextCursor ? "partial" : "complete");
        ids.push(...page.items.map(item => item.id));
        revisions.add(page.revision);
        cursor = page.nextCursor;
        expect(ids.length).toBeLessThanOrEqual(4);
      } while (cursor);
      expect(ids).toEqual(["user-1", "tool-1", "tool-1:tool_result:1", "assistant-1"]);
      expect(revisions.size).toBe(1);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([data.run, data.binding, data.sessionParams])).toBe(before);
    } finally { probe.mockRestore(); }
  });

  it("rejects conflicting persisted organization attestation before native I/O", async () => {
    const data = fixture({ legacy: true, script: 'throw new Error("must not spawn")' });
    data.sessionParams.profileOrgId = "another-org";
    const page = await createTranscriptReader(data.db as never, { nativeReader: data.nativeReader }).readRun(request);
    expect(page.items).toEqual([]);
    expect(page.availability).toBe("offline");
    expect(page.completeness).not.toBe("complete");
  });

  it("does not substitute the ambient operator home for a missing historical home", async () => {
    const data = fixture({ legacy: true });
    data.runtimeConfig.codexHome = "";
    vi.stubEnv("CODEX_HOME", "/tmp/another-operators-codex-home");
    try {
      const nativeReader = createHistoricalRunNativeTranscriptReader(data.run as HistoricalRunProfileRun, []);
      const page = await createTranscriptReader(data.db as never, { nativeReader }).readRun(request);
      expect(page.availability).toBe("offline");
      expect(page.items).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps a real byte-limit result partial without claiming protocol proof", async () => {
    const data = fixture({ legacy: true, script: server.replace('text: "你好🧭"', 'text: "🧭".repeat(5000)') });
    const reader = createTranscriptReader(data.db as never, { nativeReader: data.nativeReader,
      maxNativeReadBytes: 2048, maxNativeItemBytes: 1024 });
    const page = await reader.readRun(request);
    expect(page.items).toEqual([]);
    expect(page.completeness).toBe("partial");
    expect(page.limitReached).toMatchObject({ reason: "item_bytes", maximum: 1024 });
  });

  it("does not turn an unknown RPC method into supported/full-snapshot capability", async () => {
    const script = server.replace('const cursor =', `if (message.method === "thread/items/list") {
      process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:"unknown method"}})+"\\n"); return;
    }
    const cursor =`);
    const data = fixture({ legacy: true, script });
    const page = await createTranscriptReader(data.db as never, { nativeReader: data.nativeReader }).readRun(request);
    expect(page.items).toEqual([]);
    expect(page.availability).not.toBe("available");
    expect(page.completeness).not.toBe("complete");
  });

  it("binds continuation to executable identity even when its path and version stay unchanged", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-identity-test-"));
    const command = path.join(directory, "codex");
    try {
      const script = `#!${process.execPath}\n${server}`;
      await writeFile(command, script);
      await chmod(command, 0o700);
      const data = fixture({ legacy: true, command, args: [] });
      const reader = createTranscriptReader(data.db as never, { nativeReader: data.nativeReader });
      const first = await reader.readRun({ ...request, limit: 1 });
      expect(first.nextCursor).toBeTruthy();
      await writeFile(command, `${script}\n// changed binary identity\n`);
      await expect(reader.readRun({ ...request, limit: 1, cursor: first.nextCursor }))
        .rejects.toThrow("Transcript cursor provider revision is no longer current");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not reuse proof or a continuation across home/profile environments", async () => {
    const a = fixture({ legacy: true, home: "/tmp/codex-history-scope-a" });
    const first = await createTranscriptReader(a.db as never, { nativeReader: a.nativeReader }).readRun({ ...request, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const b = fixture({ legacy: true, home: "/tmp/codex-history-scope-b" });
    await expect(createTranscriptReader(b.db as never, { nativeReader: b.nativeReader }).readRun({ ...request, cursor: first.nextCursor }))
      .rejects.toThrow("Transcript cursor provider revision is no longer current");
  });

  it("kills a stderr flood during discovery instead of retaining or waiting on it", async () => {
    const data = fixture({ legacy: true, script: 'setInterval(() => process.stderr.write("x".repeat(65537)), 1)' });
    const start = Date.now();
    const page = await createTranscriptReader(data.db as never, { nativeReader: data.nativeReader }).readRun(request);
    expect(page.availability).toBe("offline");
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("bounds aggregate stdout even when each individual frame fits", async () => {
    const script = `const frame=JSON.stringify({method:"ignored",params:"x".repeat(65536)})+"\\n";
      setInterval(() => process.stdout.write(frame), 1);`;
    const data = fixture({ legacy: true, script });
    const start = Date.now();
    const page = await createTranscriptReader(data.db as never, { nativeReader: data.nativeReader }).readRun(request);
    expect(page.availability).toBe("offline");
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("bounds discovery when the child never finishes initialize", async () => {
    const data = fixture({ legacy: true, script: "setInterval(() => {}, 1000)" });
    const start = Date.now();
    const page = await createTranscriptReader(data.db as never, { nativeReader: data.nativeReader }).readRun(request);
    expect(page.availability).toBe("offline");
    expect(Date.now() - start).toBeLessThan(13_000);
  }, 15_000);

  // Opt-in read-only installed-provider proof. The database fixture provides
  // scope; every source item comes from the real existing native session.
  it.runIf(Boolean(process.env.RUDDER_CODEX_HISTORY_PROBE))("reads an existing installed native turn with an old three-field profile", async () => {
    const config = JSON.parse(process.env.RUDDER_CODEX_HISTORY_PROBE!) as {
      command: string; cwd: string; codexHome: string; threadId: string; turnId: string; providerVersion: string; orgId: string;
    };
    const binding = { id: "binding-span-1", orgId: config.orgId, hostId: "local", profileId: "default", capabilityRevision: "historical-cap-1" };
    const sessionParams = { sessionId: config.threadId, transport: "codex_app_server", profileHostId: binding.hostId,
      profileId: binding.profileId, profileOrgId: binding.orgId, profileBindingId: binding.id, capabilityRevision: binding.capabilityRevision };
    const profile = { runtimeType: "codex_local", command: config.command, cwd: config.cwd, codexHome: config.codexHome,
      providerVersion: config.providerVersion, nativeCapabilityMethods: { threadRead: true, threadResume: true, threadFork: true } };
    const run = databaseRun({ orgId: config.orgId, agentRuntimeType: "codex_local",
      agentRuntimeConfig: { command: "/must-not-use-current-agent-cli" }, runtimeConfig: {},
      contextSnapshot: { transcriptSource: "native", runtimeProviderProfile: profile } });
    const selector = { kind: "codex_turn", threadId: config.threadId, turnId: config.turnId };
    const db = mockDatabase({ run,
      spans: [databaseSpan("span-1", { selectorJson: selector })],
      bindings: [databaseBinding("span-1", { ...binding, runtimeType: "codex_local", continuity: "native" })],
      segments: [databaseSegment("span-1", { orgId: config.orgId, runtimeType: "codex_local",
        nativeSessionId: config.threadId, providerStateJson: sessionParams })],
    });
    const before = JSON.stringify([run, profile, binding, sessionParams]);
    const reader = createTranscriptReader(db as never, {
      nativeReader: createHistoricalRunNativeTranscriptReader(run as HistoricalRunProfileRun, [{
        id: "historical-config-revision", createdAt: new Date("2026-09-21T00:00:00Z"),
        beforeConfig: {}, afterConfig: { agentRuntimeType: "codex_local", agentRuntimeConfig: { command: config.command } },
      }]),
      maxNativeReadBytes: 1024 * 1024, maxNativeItemBytes: 256 * 1024,
    });
    const ids: string[] = [];
    const revisions = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await reader.readRun({ orgId: config.orgId, runId: "run-1",
        principal: { type: "board", orgId: config.orgId, authorized: true }, limit: 1, cursor });
      expect(page.availability).toBe("available");
      expect(page.limitReached).toBeFalsy();
      expect(page.completeness).toBe(page.nextCursor ? "partial" : "complete");
      ids.push(...page.items.map(item => item.id));
      revisions.add(page.revision);
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(30);
    } while (cursor);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(revisions.size).toBe(1);
    expect(JSON.stringify([run, profile, binding, sessionParams])).toBe(before);
    console.info(JSON.stringify({ proof: "installed-old-profile-full-reader", pages, items: ids.length, revisions: revisions.size }));
  }, 30_000);
});
