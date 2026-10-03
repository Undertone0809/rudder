import type { AgentRuntimeControlHandle } from "@rudderhq/agent-runtime-utils";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeCodexNativeTranscriptPagination, resumeCodexNativeThread } from "./app-server-native.js";
import {
  createCodexLocalProviderCapabilities,
  createCodexLocalProviderCapabilityResolver,
  type CodexAppServerProfileTransport,
  type CodexProviderBindingRef,
  type CodexProviderSessionRef,
} from "./native-capabilities.js";

let root = "";
let fakeServer = "";
let capturePath = "";

const binding: CodexProviderBindingRef = {
  hostId: "local",
  profileId: "profile-a",
  capabilityRevision: "cap-1",
};

const session: CodexProviderSessionRef = {
  sessionId: "parent-thread",
  sessionDisplayId: "parent-thread",
  sessionParams: { sessionId: "parent-thread", rootSessionId: "root-1", transport: "codex_app_server",
    profileHostId: binding.hostId, profileId: binding.profileId, capabilityRevision: binding.capabilityRevision },
};

function resultItems(
  result: readonly Record<string, unknown>[] | { items?: readonly Record<string, unknown>[] },
): readonly Record<string, unknown>[] {
  if ("items" in result) return result.items ?? [];
  return result as readonly Record<string, unknown>[];
}

async function capturedRequests(): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(capturePath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function profile(overrides: Partial<CodexAppServerProfileTransport> = {}): CodexAppServerProfileTransport {
  return {
    binding,
    command: process.execPath,
    args: [fakeServer],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      CODEX_HOME: path.join(root, "codex-home"),
      RUDDER_NATIVE_CAPTURE: capturePath,
    },
    providerVersion: "0.155.0-alpha.9.2",
    methods: { threadResume: true, threadRead: true, threadFork: true, threadReadFullSnapshot: true },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-native-"));
  fakeServer = path.join(root, "fake-app-server.mjs");
  capturePath = path.join(root, "requests.ndjson");
  await fs.writeFile(fakeServer, `
import fs from "node:fs";
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const capture = (message) => {
  if (process.env.RUDDER_NATIVE_CAPTURE) {
    fs.appendFileSync(process.env.RUDDER_NATIVE_CAPTURE, JSON.stringify(message) + "\\n", "utf8");
  }
};
const parentTurns = [
  {
    id: "turn-1",
    status: "completed",
    itemsView: { type: "full" },
    items: [
      { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Inspect the renderer" }] },
      { type: "mcpToolCall", id: "tool-1", server: "rudder", tool: "rudder_issue_context", result: { issueId: "issue-1", status: "open" } },
      { type: "agentMessage", id: "assistant-1", text: "The renderer is healthy." },
    ],
  },
  {
    id: "turn-2",
    status: "inProgress",
    itemsView: { type: "full" },
    items: [{ type: "agentMessage", id: "assistant-2", text: "Still running" }],
  },
];
const childTurns = [{
  id: "child-turn-1",
  status: "completed",
  itemsView: { type: "full" },
  items: [{ type: "agentMessage", id: "child-assistant-1", text: "Child branch" }],
}];
const nativeSnapshot = () => process.env.RUDDER_NATIVE_STATE_PATH
  ? JSON.parse(fs.readFileSync(process.env.RUDDER_NATIVE_STATE_PATH, "utf8")) : null;
if (process.env.RUDDER_NATIVE_CHANGED_RESULT === "1") parentTurns[0].items[1].result.status = "done";
const thread = (id, turns, forkedFromId = null) => ({
  id,
  sessionId: id === "child-thread" ? "child-root" : "root-1",
  forkedFromId,
  ephemeral: false,
  model: "gpt-test",
  modelProvider: "openai",
  cwd: process.cwd(),
  updatedAt: nativeSnapshot()?.updatedAt ?? Number(process.env.RUDDER_NATIVE_UPDATED_AT || 1726963200),
  turns,
});

capture({ kind: "process", cwd: process.cwd(), codexHome: process.env.CODEX_HOME ?? null });
capture({ kind: "argv", args: process.argv.slice(2) });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", serverInfo: { version: "0.155.0-alpha.9.2" } } });
    return;
  }
  if (message.method === "thread/read") {
    if (process.env.RUDDER_NATIVE_MUTATE_AFTER_PROOF === "1"
      && fs.readFileSync(process.env.RUDDER_NATIVE_CAPTURE, "utf8").split("\\n")
        .filter(line => line && JSON.parse(line).method === "thread/read").length === 2) {
      const snapshot = nativeSnapshot();
      snapshot.turns[0].items[0].content[0].text = "Changed";
      fs.writeFileSync(process.env.RUDDER_NATIVE_STATE_PATH, JSON.stringify(snapshot), "utf8");
    }
    if (process.env.RUDDER_NATIVE_HANG_READ === "1") return;
    if (process.env.RUDDER_NATIVE_BAD_READ === "1") {
      send({ id: message.id, result: { thread: thread(message.params.threadId, [{
        id: "turn-1",
        status: "completed",
        itemsView: { type: "notLoaded" },
        items: [],
      }]) } });
      return;
    }
    send({ id: message.id, result: { thread: thread(message.params.threadId, message.params.includeTurns === false ? [] : nativeSnapshot()?.turns ?? parentTurns) } });
    return;
  }
  if (message.method === "thread/turns/list") {
    const prefix = Array.from({length:Number(process.env.RUDDER_NATIVE_PREFIX_TURNS || 0)}, (_,i)=>({id:'old-'+i,status:'completed'}));
    const turns = [...prefix, ...(nativeSnapshot()?.turns ?? parentTurns)];
    const index = Number(message.params.cursor || 0);
    const turn = turns[index];
    send({id:message.id,result:{data:turn?[{...turn,items:[],itemsView:'notLoaded'}]:[],nextCursor:index+1<turns.length?String(index+1):null}});
    return;
  }
  if (message.method === "thread/items/list") {
    const turn = (nativeSnapshot()?.turns ?? parentTurns).find(t=>t.id===message.params.turnId);
    const index = Number(message.params.cursor || 0);
    const item = turn?.items[index];
    if (item && process.env.RUDDER_NATIVE_OVERSIZED === '1' && index===Number(process.env.RUDDER_NATIVE_OVERSIZED_INDEX||0)) item.text = '😀'.repeat(8192);
    send({id:message.id,result:{data:item?[{item,turnId:process.env.RUDDER_NATIVE_WRONG_TURN === '1'?'foreign-turn':turn.id}]:[],
      nextCursor:process.env.RUDDER_NATIVE_STUCK === '1' ? message.params.cursor : index+1<(turn?.items.length||0)?String(index+1):null}});
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: thread(message.params.threadId, []) } });
    return;
  }
  if (message.method === "thread/fork") {
    const childId = process.env.RUDDER_NATIVE_BAD_FORK === "1" ? message.params.threadId : "child-thread";
    const returnedTurns = process.env.RUDDER_NATIVE_BAD_FORK_BOUNDARY === "1"
      ? [...childTurns, { ...childTurns[0], id: "child-turn-extra" }]
      : childTurns;
    send({ id: message.id, result: { thread: thread(childId, returnedTurns, message.params.threadId) } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
});
`, "utf8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Codex native history and fork capabilities", () => {
  function pagedProfile(env: Record<string, string> = {}) {
    const base = profile();
    return profile({ methods: { threadRead: true, threadTurnsList: true, threadItemsList: true }, env: { ...base.env, ...env } });
  }
  const pageInput = {
    runtimeType: "codex_local", session, binding,
    selector: { kind: "codex_turn", threadId: "parent-thread", turnId: "turn-1" },
    readerInput: { readonly: true, scope: "run", limit: 1, maxBytes: 8192, maxItemBytes: 4096 },
  };
  async function fixedRangeFixture(paged: boolean) {
    const statePath = path.join(root, "native-history.json");
    const state = { updatedAt: 1726963200, turns: [{ id: "turn-1", status: "completed",
      itemsView: { type: "full" }, items: [
        { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Inspect" }] },
        { type: "mcpToolCall", id: "tool-1", server: "rudder", tool: "rudder_issue_context",
          result: { issueId: "issue-1", status: "open" } },
        { type: "agentMessage", id: "assistant-1", text: "Answer" },
      ] as Record<string, unknown>[] }] };
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    const base = profile();
    const transport = profile({ ...base, env: { ...base.env, RUDDER_NATIVE_STATE_PATH: statePath },
      methods: paged ? { threadRead: true, threadTurnsList: true, threadItemsList: true } : base.methods });
    return { state, statePath, transport, read: createCodexLocalProviderCapabilities(transport).transcript!.readRange! };
  }

  it.each([false, true])("fixed-range revision survives a later turn appended to native FS (paged=%s)", async (paged) => {
    const { state, statePath, read } = await fixedRangeFixture(paged);
    const first = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(first.availability).toBe("available");
    state.updatedAt += 1;
    state.turns.push({ id: "turn-later", status: "completed", itemsView: { type: "full" },
      items: [{ type: "agentMessage", id: "later-answer", text: "Later answer" }] });
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    const current = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(current.availability).toBe("available");
    expect(current.revision).toBe(first.revision);
    expect(current.items).toEqual(first.items);
    if (paged) {
      expect(first.nextCursor).toEqual(expect.any(String));
      const continued = await read({ ...pageInput, cursor: first.nextCursor }) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
      expect(continued.availability).toBe("available");
      expect(continued.revision).toBe(first.revision);
      expect(continued.items?.[0]?.id).toBe("tool-1");
    }
  });

  it("fixed-range revision invalidates a cursor for same-length tool changes in native FS", async () => {
    const { state, statePath, read } = await fixedRangeFixture(true);
    const first = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(first.nextCursor).toEqual(expect.any(String));
    const originalBytes = Buffer.byteLength(JSON.stringify(state));
    state.turns[0].items[1].result = { issueId: "issue-X", status: "open" };
    expect(Buffer.byteLength(JSON.stringify(state))).toBe(originalBytes);
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    await expect(read({ ...pageInput, cursor: first.nextCursor })).resolves.toMatchObject({
      availability: "incompatible", completeness: "unknown", nextCursor: null,
    });
    const changed = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(changed.revision).not.toBe(first.revision);
  });

  it.each(["unrelated_env", "binary_attestation"] as const)("fixed-range revision and cursor survive irrelevant verified-profile changes: %s", async change => {
    const { statePath, transport } = await fixedRangeFixture(true);
    const rawBefore = await fs.readFile(statePath);
    // Model the historical verifier's ephemeral full-env/binary-stat proof.
    // It remains a protocol/cache identity, not an identity of transcript text.
    const attest = (env: typeof transport.env, binary: string) => createHash("sha256")
      .update(JSON.stringify({ env: Object.entries(env).sort(), binary })).digest("hex");
    const original = { ...transport, transcriptVerificationFingerprint: attest(transport.env, "inode/ctime-1") };
    const first = await createCodexLocalProviderCapabilities(original).transcript!.readRange!(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(first.availability).toBe("available");
    expect(first.nextCursor).toEqual(expect.any(String));
    const env = change === "unrelated_env" ? { ...transport.env, UNRELATED_FIXTURE_ENV: "new-process" } : transport.env;
    const changed = { ...transport, env, transcriptVerificationFingerprint: attest(env,
      change === "binary_attestation" ? "inode/ctime-2" : "inode/ctime-1") };
    expect(changed.transcriptVerificationFingerprint).not.toBe(original.transcriptVerificationFingerprint);
    const read = createCodexLocalProviderCapabilities(changed).transcript!.readRange!;
    const current = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(await fs.readFile(statePath)).toEqual(rawBefore);
    expect(current.items).toEqual(first.items);
    const continuation = await read({ ...pageInput, cursor: first.nextCursor }).then(
      value => ({ value: value as import("./app-server-native.js").CodexNativeTranscriptReadResult, error: null }),
      error => ({ value: null, error: String(error) }),
    );
    console.info("Codex unchanged native revision probe", { change, rawBytesStable: true, projectedItemsStable: true,
      revisionStable: current.revision === first.revision, cursorStable: current.nextCursor === first.nextCursor,
      continuationError: continuation.error });
    expect(current.revision).toBe(first.revision);
    expect(current.nextCursor).toBe(first.nextCursor);
    expect(continuation.error).toBeNull();
    expect(continuation.value).toMatchObject({ availability: "available", revision: first.revision });
    expect(continuation.value?.items?.[0]?.id).toBe("tool-1");
  });

  it.each(["home", "version", "command", "args", "cwd", "profile", "org"] as const)("stable transcript cursor still rejects changed authorized scope before provider IO: %s", async change => {
    const { transport, read } = await fixedRangeFixture(true);
    const first = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(first.nextCursor).toEqual(expect.any(String));
    const changed = { ...transport };
    let authorizedSession = session;
    if (change === "home") changed.env = { ...transport.env, CODEX_HOME: path.join(root, "other-home") };
    if (change === "version") changed.providerVersion = "0.155.0-alpha.9.3";
    if (change === "command") changed.command = path.join(root, "other-codex");
    if (change === "args") changed.args = [...transport.args!, "other-profile-arg"];
    if (change === "cwd") changed.cwd = path.join(root, "other-workspace");
    if (change === "profile") {
      changed.binding = { ...binding, profileId: "profile-other" };
      authorizedSession = { ...session, sessionParams: { ...session.sessionParams, profileId: "profile-other" } };
    }
    if (change === "org") {
      changed.binding = { ...binding, orgId: "org-other", id: "binding-other" };
      authorizedSession = { ...session, sessionParams: { ...session.sessionParams,
        profileOrgId: "org-other", profileBindingId: "binding-other" } };
    }
    const before = await capturedRequests();
    await expect(createCodexLocalProviderCapabilities(changed).transcript!.readRange!({
      ...pageInput, binding: changed.binding, session: authorizedSession, cursor: first.nextCursor,
    })).rejects.toThrow("scoped");
    expect(await capturedRequests()).toEqual(before);
  });

  async function legacyCursorFixture() {
    const f = await fixedRangeFixture(true);
    const transport = { ...f.transport, transcriptVerificationFingerprint: "verified-current-binary-env" };
    const read = createCodexLocalProviderCapabilities(transport).transcript!.readRange!;
    const first = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    const oldScope = createHash("sha256").update(JSON.stringify({ binding: transport.binding,
      threadId: session.sessionId, selector: pageInput.selector, command: transport.command,
      args: transport.args, cwd: transport.cwd, home: transport.env.CODEX_HOME,
      version: transport.providerVersion, verification: transport.transcriptVerificationFingerprint })).digest("hex");
    const native = JSON.parse(await fs.readFile(f.statePath, "utf8"));
    const turn = native.turns[0];
    const oldContent = createHash("sha256").update(JSON.stringify({ scope: oldScope, id: session.sessionId,
      root: "root-1", turn: { ...turn, items: [], itemsView: "notLoaded" } })).update("\0");
    for (const item of turn.items) oldContent.update(JSON.stringify(item)).update("\0");
    // Exact deployed v1 cursor shape/hash, including its old content revision.
    const old = { ...JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")),
      scope: oldScope, revision: `codex:${oldContent.digest("hex")}` };
    return { ...f, transport, read, first, oldCursor: Buffer.from(JSON.stringify(old)).toString("base64url") };
  }

  it.each(["warm", "cold_probe"] as const)("recovers a recognized legacy attestation cursor by reading a fresh first page, never its old progress: %s", async mode => {
    const { read, first, oldCursor, transport } = await legacyCursorFixture();
    const observation = mode === "cold_probe" ? await probeCodexNativeTranscriptPagination(
      { ...pageInput, cursor: oldCursor }, { ...transport, methods: {} },
    ) : null;
    if (observation) expect(observation.verified).toBe(true);
    const fresh = observation?.page ?? await read({ ...pageInput, cursor: oldCursor }) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(fresh).toEqual(first);
    expect(fresh.items?.[0]?.id).toBe("user-1");
    expect(fresh.items?.[0]?.ordinal).toBe(0);
    expect(fresh.nextCursor).not.toBe(oldCursor);
  });

  it.each(["home", "org", "binding", "profile", "version", "fingerprint_unknown"] as const)("legacy cursor recovery fails closed for unproven original authorization: %s", async change => {
    const { transport, oldCursor } = await legacyCursorFixture();
    const changed = { ...transport };
    let authorizedSession = session;
    if (change === "home") changed.env = { ...transport.env, CODEX_HOME: path.join(root, "foreign-home") };
    if (change === "org") {
      changed.binding = { ...binding, orgId: "foreign-org", id: "foreign-binding" };
      authorizedSession = { ...session, sessionParams: { ...session.sessionParams,
        profileOrgId: "foreign-org", profileBindingId: "foreign-binding" } };
    }
    if (change === "binding") {
      changed.binding = { ...binding, id: "foreign-binding" };
      authorizedSession = { ...session, sessionParams: { ...session.sessionParams, profileBindingId: "foreign-binding" } };
    }
    if (change === "profile") {
      changed.binding = { ...binding, profileId: "foreign-profile" };
      authorizedSession = { ...session, sessionParams: { ...session.sessionParams, profileId: "foreign-profile" } };
    }
    if (change === "version") changed.providerVersion = "0.155.0-alpha.9.3";
    if (change === "fingerprint_unknown") changed.transcriptVerificationFingerprint = "different-unknown-old-proof";
    const before = await capturedRequests();
    await expect(createCodexLocalProviderCapabilities(changed).transcript!.readRange!({ ...pageInput,
      session: authorizedSession, binding: changed.binding, cursor: oldCursor,
    })).rejects.toThrow("scoped");
    expect(await capturedRequests()).toEqual(before);
  });

  it("fixed-range control keeps whole-session revision sensitive to later native turns", async () => {
    const { state, statePath, read } = await fixedRangeFixture(false);
    const wholeInput = { ...pageInput, selector: undefined, readerInput: undefined };
    const first = await read(wholeInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    state.updatedAt += 1;
    state.turns.push({ id: "turn-later", status: "completed", itemsView: { type: "full" },
      items: [{ type: "agentMessage", id: "later-answer", text: "Later answer" }] });
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    const changed = await read(wholeInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(changed.availability).toBe("available");
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.items?.some((item) => item.id === "later-answer")).toBe(true);
  });

  it("fixed-range proof rejects item changes between verification and projection", async () => {
    const { transport } = await fixedRangeFixture(true);
    const read = createCodexLocalProviderCapabilities({ ...transport,
      env: { ...transport.env, RUDDER_NATIVE_MUTATE_AFTER_PROOF: "1" } }).transcript!.readRange!;
    await expect(read(pageInput)).resolves.toMatchObject({ items: [], availability: "incompatible", completeness: "unknown" });
  });

  it("fixed-range content proof fails closed at its total byte budget", async () => {
    const { state, statePath, read } = await fixedRangeFixture(true);
    state.turns[0].items = Array.from({ length: 9 }, (_, index) => ({
      type: "agentMessage", id: `large-${index}`, text: "x".repeat(1024 * 1024),
    }));
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    await expect(read(pageInput)).resolves.toMatchObject({ items: [], nextCursor: null,
      availability: "incompatible", completeness: "unknown", revision: expect.stringContaining("byte budget") });
  });
  it("pages exact-turn items with stable revision and preserves split tool call/result projections", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile()).transcript!.readRange!;
    const ids: unknown[] = [];
    const kinds: unknown[] = [];
    const ordinals: unknown[] = [];
    const revisions = new Set();
    let cursor: string | null = null;
    for (let count = 0; count < 10; count += 1) {
      const page = await read({ ...pageInput, cursor });
      expect(Array.isArray(page)).toBe(false);
      if (Array.isArray(page)) throw new Error("expected page");
      const value = page as import("./app-server-native.js").CodexNativeTranscriptReadResult;
      const records = resultItems(value);
      expect(records).toHaveLength(1);
      ids.push(...records.map(r=>r.id)); kinds.push(...records.map(r=>r.kind)); ordinals.push(...records.map(r=>r.ordinal));
      revisions.add(value.revision);
      cursor = value.nextCursor ?? null;
      expect(value.completeness).toBe(cursor ? "partial" : "complete");
      if (!cursor) break;
    }
    expect(ids).toEqual(["user-1", "tool-1", "tool-1:tool_result:1", "assistant-1"]);
    expect(kinds).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(ordinals).toEqual([0, 1, 2, 3]);
    expect(revisions.size).toBe(1);
    const requests = await capturedRequests();
    expect(requests.filter(r=>r.method==="thread/read").every(r=>(r.params as any).includeTurns===false)).toBe(true);
    expect(requests.filter(r=>r.method==="thread/items/list").every(r=>(r.params as any).turnId==="turn-1" && (r.params as any).limit===1)).toBe(true);
    expect(requests.some(r=>r.method==="thread/resume" || r.method==="thread/fork")).toBe(false);
  });
  it("continues bounded turn discovery without loading unrelated history", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile({RUDDER_NATIVE_PREFIX_TURNS:"70"})).transcript!.readRange!;
    const first = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.completeness).toBe("partial");
    const next = await read({...pageInput,cursor:first.nextCursor}) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(next.items?.[0]?.id).toBe("user-1");
    expect(next.revision).toBe(first.revision);
  });
  it("rejects cross-turn cursors before provider I/O and selected content changes on continuation", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile()).transcript!.readRange!;
    const first = await read(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    const before = (await capturedRequests()).length;
    await expect(read({...pageInput,selector:{...pageInput.selector,turnId:"turn-2"},cursor:first.nextCursor})).rejects.toThrow("scoped");
    expect((await capturedRequests()).length).toBe(before);
    const changed = createCodexLocalProviderCapabilities(pagedProfile({RUDDER_NATIVE_CHANGED_RESULT:"1"})).transcript!.readRange!;
    await expect(changed({...pageInput,cursor:first.nextCursor})).resolves.toMatchObject({availability:"incompatible",completeness:"unknown"});
  });
  it("fails closed on oversized frames before parsing or claiming completeness", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile({RUDDER_NATIVE_OVERSIZED:"1"})).transcript!.readRange!;
    await expect(read(pageInput)).resolves.toMatchObject({items:[],nextCursor:null,completeness:"partial",limitReached:{reason:"item_bytes",maximum:4096}});
  });
  it("rejects item pages from a different native turn", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile({RUDDER_NATIVE_WRONG_TURN:"1"})).transcript!.readRange!;
    await expect(read(pageInput)).resolves.toMatchObject({availability:"incompatible",completeness:"unknown"});
  });
  it("retains the unconsumed item after a frame cap and permits retry with a larger budget", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile({RUDDER_NATIVE_OVERSIZED:"1",RUDDER_NATIVE_OVERSIZED_INDEX:"1"})).transcript!.readRange!;
    const first = await read({...pageInput,readerInput:{...pageInput.readerInput,limit:50}}) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(first.items?.map(item=>item.id)).toEqual(["user-1"]);
    expect(first.limitReached).toEqual({reason:"item_bytes",maximum:4096});
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.completeness).toBe("partial");
    const next = await read({...pageInput,cursor:first.nextCursor,readerInput:{...pageInput.readerInput,limit:50,maxBytes:524288,maxItemBytes:262144}}) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    expect(next.items?.map(item=>item.id)).toEqual(["tool-1","tool-1:tool_result:1","assistant-1"]);
    expect(next.completeness).toBe("complete");
    expect(next.revision).toBe(first.revision);
  });
  it("respects output byte budgets across continuation without dropping projections", async () => {
    const read = createCodexLocalProviderCapabilities(pagedProfile()).transcript!.readRange!;
    let cursor: string|null = null;
    const ids:unknown[]=[];
    for(let count=0;count<10;count++) {
      const page = await read({...pageInput,cursor,readerInput:{...pageInput.readerInput,limit:50,maxBytes:1400}}) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
      expect(page.limitReached).toBeUndefined();
      expect((page.items??[]).reduce((bytes,item)=>bytes+Buffer.byteLength(JSON.stringify(item)),0)).toBeLessThanOrEqual(1400);
      ids.push(...(page.items??[]).map(item=>item.id));cursor=page.nextCursor??null;
      if(!cursor)break;
    }
    expect(ids).toEqual(["user-1","tool-1","tool-1:tool_result:1","assistant-1"]);
  });
  it("rejects a non-progressing provider cursor", async () => {
    const first = await createCodexLocalProviderCapabilities(pagedProfile()).transcript!.readRange!(pageInput) as import("./app-server-native.js").CodexNativeTranscriptReadResult;
    const read = createCodexLocalProviderCapabilities(pagedProfile({RUDDER_NATIVE_STUCK:"1"})).transcript!.readRange!;
    await expect(read({...pageInput,cursor:first.nextCursor})).resolves.toMatchObject({availability:"incompatible",completeness:"unknown"});
  });
  it("does not infer full-snapshot history from thread/read method support", async () => {
    const read = createCodexLocalProviderCapabilities(profile({methods:{threadRead:true}})).transcript!.readRange!;
    await expect(read(pageInput)).resolves.toMatchObject({availability:"incompatible",completeness:"unknown"});
    expect(await capturedRequests()).toEqual([]);
  });
  it("rejects missing and mismatched native session attestations before opening a provider", async () => {
    const authorized = { ...binding, id: "binding-a", orgId: "org-a", workspaceBindingId: "workspace-a" };
    const transport = profile({ binding: authorized });
    const capabilities = createCodexLocalProviderCapabilities(transport);
    const params = { ...session.sessionParams, profileBindingId: authorized.id,
      profileOrgId: authorized.orgId, workspaceBindingId: authorized.workspaceBindingId };
    for (const key of ["transport", "profileHostId", "profileId", "profileOrgId", "profileBindingId", "workspaceBindingId", "capabilityRevision"]) {
      for (const value of [undefined, "foreign-identity"]) {
        const foreign = { ...session, sessionParams: { ...params, [key]: value } };
        await expect(capabilities.transcript!.readRange!({
          runtimeType: "codex_local", binding: authorized, session: foreign,
        })).rejects.toThrow("attestation");
        await expect(capabilities.fork!.fork!({
          runtimeType: "codex_local", binding: authorized, session: foreign, boundary: "turn-1",
        })).rejects.toThrow("attestation");
        await expect(resumeCodexNativeThread({
          runtimeType: "codex_local", binding: authorized, session: foreign,
        }, transport)).rejects.toThrow("attestation");
      }
    }
    expect(await capturedRequests()).toEqual([]);
  });

  it("reads one authorized turn, applies direct ranges, and preserves tool results", async () => {
    const resolver = createCodexLocalProviderCapabilityResolver((requested) => {
      expect(requested).toEqual(binding);
      return profile();
    });
    const capabilities = resolver("codex_local", binding)!;
    expect(capabilities.transcript?.evidence).toMatchObject({ status: "supported", profileBound: true });
    expect(capabilities.control?.steer?.evidence).toMatchObject({ status: "supported", profileBound: true });

    const readRange = capabilities.transcript!.readRange!;
    const runResult = await readRange({
      runtimeType: "codex_local",
      session,
      selector: { kind: "codex_turn", threadId: "parent-thread", turnId: "turn-1" },
      binding,
      range: { itemId: "tool-1" },
      readerInput: { readonly: true, scope: "run" },
    });
    const runItems = resultItems(runResult);
    expect(runItems.map((item) => item.id)).toEqual(["user-1", "tool-1", "tool-1:tool_result:1", "assistant-1"]);
    expect(runItems.map((item) => item.entry)).toMatchObject([
      { kind: "user", text: "Inspect the renderer" },
      { kind: "tool_call", toolUseId: "tool-1", name: "mcp__rudder__rudder_issue_context" },
      { kind: "tool_result", toolUseId: "tool-1", isError: false },
      { kind: "assistant", text: "The renderer is healthy." },
    ]);
    expect(runItems[1]?.payload).toMatchObject({
      threadId: "parent-thread",
      turnId: "turn-1",
      item: { type: "mcpToolCall", result: { issueId: "issue-1" } },
    });

    const directResult = await readRange({
      runtimeType: "codex_local",
      session,
      binding,
      range: { fromExclusive: "user-1", throughInclusive: "tool-1" },
    });
    const directItems = resultItems(directResult);
    expect(directItems.map((item) => item.id)).toEqual(["tool-1", "tool-1:tool_result:1"]);

    for (const range of [
      { fromExclusive: "tool-1" },
      { after: "tool-1:tool_result:1" },
    ]) {
      const afterTool = await readRange({ runtimeType: "codex_local", session, binding, range });
      expect(resultItems(afterTool).map((item) => item.id)).toEqual(["assistant-1", "assistant-2"]);
    }
    const boundedTool = await readRange({
      runtimeType: "codex_local", session, binding,
      range: { start: "tool-1", end: "tool-1" },
    });
    expect(resultItems(boundedTool).map((item) => item.id)).toEqual(["tool-1", "tool-1:tool_result:1"]);

    const requests = await capturedRequests();
    expect(requests.find((request) => request.kind === "process")).toMatchObject({
      kind: "process",
      cwd: await fs.realpath(root),
      codexHome: path.join(root, "codex-home"),
    });
    expect(requests.find((request) => request.kind === "argv")).toMatchObject({
      kind: "argv",
      args: ["app-server", "--stdio"],
    });
  });

  it("forks only through a completed turn and preserves lineage across a new native session tree", async () => {
    const capabilities = createCodexLocalProviderCapabilities(profile());
    const fork = capabilities.fork!.fork!;
    const result = await fork({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    });

    expect(result).toMatchObject({
      continuity: "native",
      boundary: "turn-1",
      sourceBoundary: "turn-1",
      identityMap: { "turn-1": "child-turn-1" },
      session: {
        sessionId: "child-thread",
        sessionDisplayId: "child-thread",
        sessionParams: {
          sessionId: "child-thread",
          threadId: "child-thread",
          rootSessionId: "child-root",
          forkedFromId: "parent-thread",
          transport: "codex_app_server",
          profileHostId: "local",
          profileId: "profile-a",
          capabilityRevision: "cap-1",
        },
      },
    });
    expect(result.session.sessionId).not.toBe(session.sessionId);

    const requests = await capturedRequests();
    const forkRequest = requests.find((request) => request.method === "thread/fork");
    expect(forkRequest).toMatchObject({
      method: "thread/fork",
      params: {
        threadId: "parent-thread",
        lastTurnId: "turn-1",
        ephemeral: false,
        excludeTurns: false,
        model: "gpt-test",
        modelProvider: "openai",
        cwd: root,
      },
    });
  });

  it("reports a missing Run boundary without reading the whole session or throwing a server error", async () => {
    const capabilities = createCodexLocalProviderCapabilities(profile());
    await expect(capabilities.transcript!.readRange!({
      runtimeType: "codex_local", session, binding,
      selector: { kind: "codex_turn", threadId: "parent-thread", turnId: null },
      readerInput: { readonly: true, scope: "run" },
    })).resolves.toMatchObject({ items: [], source: "native", availability: "missing", completeness: "unknown" });
    expect(await capturedRequests()).toEqual([]);
  });

  it("uses native resume and refuses an in-progress fork boundary", async () => {
    const current = profile();
    await expect(resumeCodexNativeThread({ runtimeType: "codex_local", session, binding }, current)).resolves.toMatchObject({
      sessionId: "parent-thread",
      sessionParams: { sessionId: "parent-thread", threadId: "parent-thread", rootSessionId: "root-1" },
    });

    const capabilities = createCodexLocalProviderCapabilities(current);
    await expect(capabilities.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-2",
      binding,
    })).rejects.toThrow("only a completed turn is safe to fork");

    const requests = await capturedRequests();
    expect(requests.filter((request) => request.method === "thread/fork")).toHaveLength(0);
    expect(requests.some((request) => request.method === "thread/resume")).toBe(true);
  });

  it("reports provider read/fork failures and transport timeouts explicitly", async () => {
    const badRead = createCodexLocalProviderCapabilities(profile({
      env: { ...profile().env, RUDDER_NATIVE_BAD_READ: "1" },
    }));
    await expect(badRead.transcript!.readRange!({
      runtimeType: "codex_local",
      session,
      binding,
    })).resolves.toMatchObject({
      items: [],
      availability: "incompatible",
      revision: expect.stringContaining("unsupported:"),
    });

    const badFork = createCodexLocalProviderCapabilities(profile({
      env: { ...profile().env, RUDDER_NATIVE_BAD_FORK: "1" },
    }));
    await expect(badFork.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    })).rejects.toMatchObject({
      name: "CodexNativeCapabilityError",
      status: "unsupported",
    });

    const timedOutProfile = profile({
      env: { ...profile().env, RUDDER_NATIVE_HANG_READ: "1" },
    });
    const timedOutCapabilities = createCodexLocalProviderCapabilities(timedOutProfile);
    await expect(timedOutCapabilities.transcript!.readRange!({
      runtimeType: "codex_local",
      session,
      binding,
      signal: AbortSignal.timeout(25),
    })).resolves.toMatchObject({
      items: [],
      availability: "offline",
      revision: expect.stringContaining("unknown:"),
    });
    await expect(timedOutCapabilities.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
      signal: AbortSignal.timeout(25),
    })).rejects.toMatchObject({
      name: "CodexNativeCapabilityError",
      status: "unknown",
      message: expect.stringContaining("unavailable"),
    });
  });

  it("does not launch a profile transport when method support is unknown or unsupported", async () => {
    const unknownRead = createCodexLocalProviderCapabilities(profile({
      methods: { threadResume: true, threadFork: true },
    }));
    await expect(unknownRead.transcript!.readRange!({
      runtimeType: "codex_local",
      session,
      binding,
    })).rejects.toMatchObject({ name: "CodexNativeCapabilityError", status: "unknown" });

    const unsupportedFork = createCodexLocalProviderCapabilities(profile({
      methods: { threadResume: true, threadRead: true, threadFork: false },
    }));
    await expect(unsupportedFork.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    })).rejects.toMatchObject({ name: "CodexNativeCapabilityError", status: "unsupported" });

    expect(await capturedRequests()).toEqual([]);
  });

  it("rejects a fork response that includes turns after the requested boundary", async () => {
    const capabilities = createCodexLocalProviderCapabilities(profile({
      env: { ...profile().env, RUDDER_NATIVE_BAD_FORK_BOUNDARY: "1" },
    }));
    await expect(capabilities.fork!.fork!({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
      binding,
    })).rejects.toMatchObject({
      name: "CodexNativeCapabilityError",
      status: "unsupported",
      message: expect.stringContaining("exactly the 1 turn through boundary turn-1"),
    });
  });

  it("returns explicit unknown or unsupported capability evidence before transport I/O", () => {
    const resolver = createCodexLocalProviderCapabilityResolver(undefined);
    const unbound = resolver("codex_local", null)!;
    expect(unbound.transcript?.evidence).toMatchObject({ status: "unknown" });
    expect(unbound.fork?.evidence).toMatchObject({ status: "unknown" });

    const unsupported = resolver("codex_local", binding)!;
    expect(unsupported.transcript?.evidence).toMatchObject({ status: "unknown" });

    const versionUnknown = createCodexLocalProviderCapabilities(profile({ providerVersion: null }));
    expect(versionUnknown.transcript?.evidence).toMatchObject({ status: "unknown" });
    expect(versionUnknown.fork?.evidence).toMatchObject({ status: "unknown" });

    const methodUnsupported = createCodexLocalProviderCapabilities(profile({ methods: { threadRead: false, threadFork: false } }));
    expect(methodUnsupported.transcript?.evidence).toMatchObject({ status: "unsupported" });
    expect(methodUnsupported.fork?.evidence).toMatchObject({ status: "unsupported" });

    const mismatched = createCodexLocalProviderCapabilityResolver(() => profile({
      binding: { ...binding, profileId: "other-profile" },
    }))!("codex_local", binding)!;
    expect(mismatched.transcript?.evidence).toMatchObject({ status: "unsupported" });
    expect(mismatched.fork?.evidence).toMatchObject({ status: "unsupported" });

    const mismatchedOptionalIdentity = createCodexLocalProviderCapabilityResolver(() => profile({
      binding: { ...binding, orgId: "org-2" },
    }))!("codex_local", { ...binding, orgId: "org-1" })!;
    expect(mismatchedOptionalIdentity.transcript?.evidence).toMatchObject({ status: "unsupported" });
    expect(mismatchedOptionalIdentity.fork?.evidence).toMatchObject({ status: "unsupported" });
  });

  it("forwards native control hooks to the live App Server handle", async () => {
    const resolver = createCodexLocalProviderCapabilityResolver((requested) => {
      expect(requested).toEqual(binding);
      return profile();
    });
    const capabilities = resolver("codex_local", binding)!;
    const steer = vi.fn().mockResolvedValue({
      disposition: "accepted_current" as const,
      providerThreadId: "parent-thread",
      providerTurnId: "turn-2",
    });
    const interrupt = vi.fn().mockResolvedValue("acknowledged" as const);
    const handle = {
      runtimeType: "codex_local",
      providerThreadId: "parent-thread",
      providerTurnId: "turn-2",
      capabilities: { steer: "native" as const, interrupt: "native" as const },
      steer,
      interrupt,
      dispose: vi.fn().mockResolvedValue(undefined),
    } satisfies AgentRuntimeControlHandle;

    await expect(capabilities.control!.steer!.execute!({
      runtimeType: "codex_local",
      handle,
      binding,
      session,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-1" } },
    })).resolves.toMatchObject({ disposition: "accepted_current" });
    await expect(capabilities.control!.interrupt!.execute!({
      runtimeType: "codex_local",
      handle,
      binding,
      session,
      operation: { kind: "interrupt", reason: "operator_stop" },
    })).resolves.toBe("acknowledged");
    expect(steer).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledOnce();

    await expect(capabilities.control!.steer!.execute!({
      runtimeType: "codex_local",
      handle,
      binding: { ...binding, profileId: "different-profile" },
      session,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-mismatch" } },
    })).resolves.toMatchObject({
      disposition: "acceptance_unknown",
      reason: expect.stringContaining("binding does not match"),
    });
    expect(steer).toHaveBeenCalledOnce();

    await expect(capabilities.control!.steer!.execute!({
      runtimeType: "codex_local",
      handle: null,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-2" } },
    })).resolves.toMatchObject({
      disposition: "acceptance_unknown",
      reason: expect.stringContaining("live handle"),
    });
    await expect(capabilities.control!.interrupt!.execute!({
      runtimeType: "codex_local",
      handle: null,
      operation: { kind: "interrupt", reason: "operator_stop" },
    })).resolves.toBe("unverified");
  });
});
