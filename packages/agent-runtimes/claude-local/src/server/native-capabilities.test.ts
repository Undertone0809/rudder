import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sessionCodec } from "./index.js";
import {
  createClaudeLocalProviderCapabilities,
  createClaudeLocalProviderCapabilityResolver,
  parseClaudeSessionJsonl,
  resolveClaudeSessionFilePath,
  verifyClaudeSessionAssistantHead,
  type ClaudeLocalProfileTransport,
  type ClaudeNativeTranscriptReadRequest,
  type ClaudeProviderBindingRef,
} from "./native-capabilities.js";

const binding: ClaudeProviderBindingRef = {
  hostId: "host-claude-1",
  profileId: "profile-claude-1",
  capabilityRevision: "claude-jsonl-v1",
};
const cwd = "/tmp/claude-project";
const configDir = "/tmp/claude-config";
const sessionId = "claude-session-1";

const sessionJsonl = [
  {
    type: "user",
    uuid: "user-1",
    message: { role: "user", content: [{ type: "text", text: "Start here." }] },
  },
  {
    type: "assistant",
    uuid: "assistant-1",
    parentUuid: "user-1",
    message: { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
  },
  {
    type: "user",
    uuid: "user-2",
    parentUuid: "assistant-1",
    message: { role: "user", content: [{ type: "tool_result", content: "done" }] },
  },
  {
    type: "assistant",
    uuid: "assistant-2",
    parentUuid: "user-2",
    message: { role: "assistant", content: [{ type: "text", text: "Finished." }] },
  },
  {
    type: "assistant",
    uuid: "unrelated-branch",
    parentUuid: "missing-parent",
    message: { role: "assistant", content: [{ type: "text", text: "Do not include me." }] },
  },
].map((entry) => JSON.stringify(entry)).join("\n");

function profile(source: string | NonNullable<ClaudeLocalProfileTransport["readFile"]> = sessionJsonl): ClaudeLocalProfileTransport {
  let bytes: Buffer | null = typeof source === "string" ? Buffer.from(source, "utf8") : null;
  const readBytes = async () => {
    if (!bytes) {
      const content = typeof source === "string" ? source : await source("fixture");
      bytes = Buffer.from(content, "utf8");
    }
    return bytes;
  };
  return {
    binding,
    cwd,
    configDir,
    providerVersion: "2.1.216",
    readFile: async () => (await readBytes()).toString("utf8"),
    readStream: async function* (_filePath, range) {
      const sourceBytes = await readBytes();
      const start = range?.start ?? 0;
      const end = range?.end === undefined ? sourceBytes.length - 1 : Math.min(range.end, sourceBytes.length - 1);
      for (let offset = start; offset <= end; offset += 64 * 1024) {
        yield sourceBytes.subarray(offset, Math.min(end + 1, offset + 64 * 1024));
      }
    },
  };
}

function request(overrides: Partial<ClaudeNativeTranscriptReadRequest> = {}): ClaudeNativeTranscriptReadRequest {
  return {
    runtimeType: "claude_local",
    binding,
    session: {
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: {
        sessionId,
        cwd,
        claudeConfigDir: configDir,
        sessionFilePath: resolveClaudeSessionFilePath(configDir, cwd, sessionId),
        profileHostId: binding.hostId,
        profileId: binding.profileId,
        capabilityRevision: binding.capabilityRevision,
      },
    },
    ...overrides,
  };
}

async function withSessionFile(
  content: string,
  check: (transport: ClaudeLocalProfileTransport, input: ClaudeNativeTranscriptReadRequest) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-read-boundary-"));
  const transport = { binding, cwd: path.join(root, "project"), configDir: path.join(root, "config"), providerVersion: "2.1.216" };
  const filePath = resolveClaudeSessionFilePath(transport.configDir, transport.cwd, sessionId);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    const input = request();
    await check(transport, {
      ...input,
      session: { ...input.session, sessionParams: {
        ...input.session.sessionParams, cwd: transport.cwd, claudeConfigDir: transport.configDir, sessionFilePath: filePath,
      } },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Claude profile-bound native capabilities", () => {
  it("keeps a fixed Run cursor valid after later turns but invalidates selected tool output changes", async () => {
    await withSessionFile(sessionJsonl, async (transport, input) => {
      const adapter = createClaudeLocalProviderCapabilities(transport);
      const selected = {
        ...input,
        selector: { kind: "claude_chain", startExclusiveUuid: "assistant-1", throughInclusiveUuid: "assistant-2" },
      };
      const first = await adapter.transcript.readRange({ ...selected, readerInput: { limit: 1 } });
      expect(first).toMatchObject({ availability: "available", nextCursor: expect.any(String) });
      const original = await adapter.transcript.readRange(selected);
      const wholeSession = await adapter.transcript.readRange(input);
      const filePath = String(input.session.sessionParams.sessionFilePath);
      const later = [
        { type: "user", uuid: "later-user", parentUuid: "assistant-2", message: { role: "user", content: "another input" } },
        { type: "assistant", uuid: "later-assistant", parentUuid: "later-user", message: { role: "assistant", content: "later answer" } },
      ].map((record) => JSON.stringify(record)).join("\n");
      await fs.appendFile(filePath, `\n${later}\n`);

      const continuation = await adapter.transcript.readRange({ ...selected, cursor: first.nextCursor });
      expect(continuation).toMatchObject({ availability: "available", completeness: "complete", revision: first.revision });
      expect(continuation.items.map((item) => item.sourceEntryId)).toEqual(["assistant-2:block:0"]);
      const afterAppend = await adapter.transcript.readRange(selected);
      expect(afterAppend.items).toEqual(original.items);
      expect(afterAppend.revision).toBe(original.revision);
      expect((await adapter.transcript.readRange(input)).revision).not.toBe(wholeSession.revision);

      // Same-length edits must be detected by selected content, not file size.
      await fs.writeFile(filePath, `${sessionJsonl.replace('"done"', '"gone"')}\n${later}\n`);
      const changed = await adapter.transcript.readRange(selected);
      expect(changed.revision).not.toBe(original.revision);
      expect(JSON.stringify(changed.items)).toContain("gone");
      await expect(adapter.transcript.readRange({ ...selected, cursor: first.nextCursor }))
        .resolves.toMatchObject({ availability: "incompatible", items: [] });
    });
  });

  it.each([2_000, 200_000].flatMap(size => ["\n", ""].map(terminator => ({ size, terminator }))))(
    "rejects an oversized physical record before JSON.parse ($size bytes, terminator $terminator)", async ({ size, terminator }) => {
    const record = JSON.stringify({ type: "assistant", uuid: "oversized-body", message: { content: "x".repeat(size) } });
    await withSessionFile(record + terminator, async (transport, input) => {
      const parse = vi.spyOn(JSON, "parse");
      try {
        const result = await createClaudeLocalProviderCapabilities(transport).transcript.readRange({
          ...input, selector: { kind: "claude_chain", throughInclusiveUuid: "oversized-body" },
          readerInput: { limit: 1, maxBytes: 4096, maxItemBytes: 1024 },
        });
        expect(result).toMatchObject({ items: [], nextCursor: null, completeness: "partial",
          limitReached: { reason: "item_bytes", maximum: 1024 } });
        expect(parse.mock.calls.some(([value]) => String(value).includes("oversized-body"))).toBe(false);
      } finally {
        parse.mockRestore();
      }
    });
  });

  it("retains a resumable position when a projected item exceeds budget after progress", async () => {
    const records = [
      { type: "system", uuid: "small", text: "ok" },
      { type: "assistant", uuid: "large", parentUuid: "small", message: { content: [{ type: "text", text: "x".repeat(500) }] } },
    ];
    await withSessionFile(records.map(record => JSON.stringify(record)).join("\n"), async (transport, input) => {
      const adapter = createClaudeLocalProviderCapabilities(transport);
      const selected = { ...input, selector: { kind: "claude_chain", throughInclusiveUuid: "large" } };
      const first = await adapter.transcript.readRange({ ...selected, readerInput: { maxBytes: 4096, maxItemBytes: 1024 } });
      expect(first.items.map(item => item.sourceEntryId)).toEqual(["small"]);
      expect(first).toMatchObject({ completeness: "partial", nextCursor: expect.any(String),
        limitReached: { reason: "item_bytes", maximum: 1024 } });
      const next = await adapter.transcript.readRange({ ...selected, cursor: first.nextCursor,
        readerInput: { maxBytes: 4096, maxItemBytes: 4096 } });
      expect(next.items.map(item => item.sourceEntryId)).toEqual(["large:block:0"]);
      expect(next).toMatchObject({ completeness: "complete", nextCursor: null, revision: first.revision });
    });
  });

  it("filters non-monotonic ordinals individually across cursor pages and mixed boundaries", async () => {
    const records = [
      { type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "a" }] } },
      { type: "assistant", uuid: "b", parentUuid: "a", message: { content: [{ type: "text", text: "b" }] } },
      { type: "system", uuid: "c", parentUuid: "b", text: "c" },
    ];
    await withSessionFile(records.map(record => JSON.stringify(record)).join("\n"), async (transport, input) => {
      const adapter = createClaudeLocalProviderCapabilities(transport);
      const selected = { ...input, selector: { kind: "claude_chain", throughInclusiveUuid: "c" }, readerInput: { limit: 1 } };
      const first = await adapter.transcript.readRange({ ...selected, range: { end: 10 } });
      expect(first.items.map(item => item.ordinal)).toEqual([0]);
      expect(first.completeness).toBe("partial");
      const next = await adapter.transcript.readRange({ ...selected, range: { end: 10 }, cursor: first.nextCursor });
      expect(next.items.map(item => item.ordinal)).toEqual([2]);
      expect(next).toMatchObject({ nextCursor: null, completeness: "complete" });
      for (const range of [{ start: 500 }, { fromExclusive: 2 }, { start: 500, end: "claude:c" }]) {
        const page = await adapter.transcript.readRange({ ...selected, range });
        expect(page.items.map(item => item.ordinal)).toEqual([1000]);
        expect(page.nextCursor).toBeNull();
      }
    });
  });

  it.each(["records", "metadata", "projections"])("reports an explicit bounded %s index limit without claiming exact ancestry", async (kind) => {
    const count = kind === "records" ? 20_001 : kind === "metadata" ? 9_000 : 11;
    const records = Array.from({ length: count }, (_, index) => ({
      type: "assistant", uuid: `${index}-${kind === "metadata" ? "x".repeat(1024) : "a"}`,
      ...(kind === "projections" ? { message: { content: Array.from({ length: 10_000 }, () => ({ type: "text", text: "" })) } } : {}),
    }));
    const result = await createClaudeLocalProviderCapabilities(profile(records.map(record => JSON.stringify(record)).join("\n")))
      .transcript.readRange(request({ readerInput: { maxBytes: 1024 * 1024, maxItemBytes: 1024 * 1024 } }));
    expect(result).toMatchObject({ items: [], nextCursor: null, completeness: "partial", limitReached: {
      reason: kind === "metadata" ? "total_bytes" : "total_items",
      maximum: kind === "metadata" ? 8 * 1024 * 1024 : kind === "records" ? 20_000 : 100_000,
    } });
  });

  it("caps total ancestry scan bytes even for files with no indexable records", async () => {
    const transport = profile();
    const chunk = Buffer.alloc(64 * 1024, " ");
    for (let index = 1023; index < chunk.length; index += 1024) chunk[index] = 10;
    let chunks = 0;
    let closed = false;
    transport.readStream = async function* () {
      try { for (; chunks < 2048;) { chunks += 1; yield chunk; } }
      finally { closed = true; }
    };
    const result = await createClaudeLocalProviderCapabilities(transport).transcript.readRange(request());
    expect(result).toMatchObject({ items: [], nextCursor: null, completeness: "partial",
      limitReached: { reason: "total_bytes", maximum: 64 * 1024 * 1024 } });
    expect(chunks).toBe(1025);
    expect(closed).toBe(true);
  });

  it.each([
    { kind: "claude_chain", throughInclusiveUuid: null },
    { kind: "claude_chain", throughInclusiveUuid: "assistant-2", boundaryStatus: "missing" },
  ])("does not return the whole session for an unverified Run range", async (selector) => {
    const result = await createClaudeLocalProviderCapabilities(profile()).transcript.readRange(request({ selector }));
    expect(result.items).toEqual([]);
    expect(result.completeness).toBe("unknown");
    expect(result.availability).not.toBe("available");
  });

  it("reads the official JSONL session store through the parentUuid chain and selector boundary", async () => {
    const adapter = createClaudeLocalProviderCapabilities(profile());

    const result = await adapter.transcript.readRange(request({
      selector: {
        startExclusiveUuid: "user-1",
        throughInclusiveUuid: "assistant-2",
      },
    }));

    expect(result).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(result.items.map((item) => item.sourceEntryId)).toEqual([
      "assistant-1:block:0",
      "user-2:block:0",
      "assistant-2:block:0",
    ]);
    expect(result.items.map((item) => item.text)).toEqual([
      "I will inspect it.",
      "done",
      "Finished.",
    ]);
    expect(result.items.some((item) => item.text === "Do not include me.")).toBe(false);
  });

  it("streams a large session into bounded, revision-bound pages without omissions", async () => {
    const entries = Array.from({ length: 130 }, (_unused, index) => ({
      type: "assistant",
      uuid: `large-${index}`,
      ...(index > 0 ? { parentUuid: `large-${index - 1}` } : {}),
      message: { content: [{ type: "text", text: `turn-${index} ${"x".repeat(8_500)}` }] },
    }));
    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    const sourceBytes = Buffer.byteLength(content, "utf8");
    expect(sourceBytes).toBeGreaterThan(1024 * 1024);

    const nativeProfile = profile(content);
    const openStream = nativeProfile.readStream!;
    const rangedReads: number[] = [];
    let maxChunkBytes = 0;
    nativeProfile.readStream = async function* (filePath, range) {
      if (range) rangedReads.push(range.end! - range.start! + 1);
      for await (const chunk of openStream(filePath, range)) {
        maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
        yield chunk;
      }
    };

    const adapter = createClaudeLocalProviderCapabilities(nativeProfile);
    const selector = { kind: "claude_chain", throughInclusiveUuid: "large-129" };
    const pageBudget = 96 * 1024;
    const allIds: string[] = [];
    let cursor: string | null = null;
    let firstCursor: string | null = null;
    let pages = 0;
    do {
      const result = await adapter.transcript.readRange(request({
        selector,
        cursor,
        readerInput: { limit: 100, maxBytes: pageBudget, maxItemBytes: 64 * 1024 },
      }));
      expect(result.availability).toBe("available");
      expect(Buffer.byteLength(JSON.stringify(result.items), "utf8")).toBeLessThanOrEqual(pageBudget);
      allIds.push(...result.items.map((item) => item.sourceEntryId));
      cursor = result.nextCursor;
      firstCursor ??= cursor;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(allIds).toEqual(entries.map((_entry, index) => `large-${index}:block:0`));
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(maxChunkBytes).toBeLessThanOrEqual(64 * 1024);
    expect(rangedReads.length).toBeGreaterThan(0);
    expect(Math.max(...rangedReads)).toBeLessThan(sourceBytes);

    const continued = await createClaudeLocalProviderCapabilities(profile(`${content}\n${JSON.stringify({
      type: "assistant", uuid: "later", parentUuid: "large-129", message: { content: "later" },
    })}`)).transcript.readRange(request({
      selector,
      cursor: firstCursor,
      readerInput: { limit: 100, maxBytes: pageBudget, maxItemBytes: 64 * 1024 },
    }));
    expect(continued).toMatchObject({ nextCursor: expect.any(String), availability: "available" });
    expect(continued.items.length).toBeGreaterThan(0);
    expect(continued.items.every((item) => allIds.includes(item.sourceEntryId))).toBe(true);
  });

  it("continues after a prior result marker by its verified assistant parent", async () => {
    const continuationSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: "First answer.", stop_reason: "end_turn" },
      },
      {
        type: "result",
        uuid: "result-1",
        parentUuid: "assistant-1",
        sessionId,
      },
      {
        type: "user",
        uuid: "user-2",
        parentUuid: "assistant-1",
        sessionId,
        message: { role: "user", content: "Second prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "user-2",
        sessionId,
        message: { role: "assistant", content: "Second answer.", stop_reason: "end_turn" },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const result = await createClaudeLocalProviderCapabilities(profile(async () => continuationSession)).transcript.readRange(request({
      selector: {
        kind: "claude_chain",
        sessionId,
        startExclusiveUuid: "result-1",
        throughInclusiveUuid: "assistant-2",
      },
    }));

    expect(result).toMatchObject({ availability: "available", completeness: "complete" });
    expect(result.items.map((item) => item.sourceEntryId)).toEqual([
      "user-2",
      "assistant-2",
    ]);
  });

  it("fails closed when an old result boundary has no verified assistant parent", async () => {
    const continuationSession = [
      { type: "assistant", uuid: "assistant-1", sessionId, message: { stop_reason: "end_turn" } },
      { type: "result", uuid: "result-1", sessionId },
      { type: "assistant", uuid: "assistant-2", parentUuid: "assistant-1", sessionId },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const result = await createClaudeLocalProviderCapabilities(profile(async () => continuationSession)).transcript.readRange(request({
      selector: {
        kind: "claude_chain",
        sessionId,
        startExclusiveUuid: "result-1",
        throughInclusiveUuid: "assistant-2",
      },
    }));

    expect(result).toMatchObject({ availability: "incompatible", completeness: "unknown", items: [] });
  });

  it("returns runtime-valid TranscriptEntry values for assistant thinking and tool blocks", async () => {
    const nativeSession = [
      {
        type: "assistant",
        uuid: "assistant-rich",
        message: {
          content: [
            { type: "text", text: "Visible answer." },
            { type: "thinking", thinking: "Internal reasoning." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "tool-result",
        parentUuid: "assistant-rich",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: " /tmp", is_error: false }],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const result = await createClaudeLocalProviderCapabilities(profile(async () => nativeSession)).transcript.readRange(request());

    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => (
      item.entry
      && typeof item.entry.kind === "string"
      && typeof item.entry.ts === "string"
      && typeof item.entry.sourceEntryId === "string"
    ))).toBe(true);
    expect(result.items.map((item) => item.entry.kind)).toEqual([
      "assistant",
      "thinking",
      "tool_call",
      "tool_result",
    ]);
    expect(result.items[0]?.entry).toMatchObject({ kind: "assistant", text: "Visible answer." });
    expect(result.items[1]?.entry).toMatchObject({ kind: "thinking", text: "Internal reasoning." });
    expect(result.items[2]?.entry).toMatchObject({ kind: "tool_call", name: "Bash", toolUseId: "tool-1", input: { command: "pwd" } });
    expect(result.items[3]?.entry).toMatchObject({ kind: "tool_result", toolUseId: "tool-1", content: " /tmp", isError: false });
  });

  it("applies from/through aliases and rejects a runtime mismatch", async () => {
    const adapter = createClaudeLocalProviderCapabilities(profile());

    const ranged = await adapter.transcript.readRange(request({
      range: {
        fromExclusive: "assistant-1:block:0",
        throughInclusive: "assistant-2:block:0",
      },
    }));
    const wrongRuntime = await adapter.transcript.readRange(request({ runtimeType: "cursor" }));

    expect(ranged.items.map((item) => item.sourceEntryId)).toEqual([
      "user-2:block:0",
      "assistant-2:block:0",
    ]);
    expect(wrongRuntime).toMatchObject({ availability: "incompatible", revision: "runtime-mismatch" });
  });

  it("classifies malformed or missing session sources and identity mismatches", async () => {
    const malformed = createClaudeLocalProviderCapabilities(profile(async () => `${sessionJsonl}\nnot-json`));
    const malformedResult = await malformed.transcript.readRange(request());
    expect(malformedResult).toMatchObject({ availability: "available", completeness: "partial" });

    const missing = createClaudeLocalProviderCapabilities(profile(async () => { throw new Error("ENOENT"); }));
    const missingResult = await missing.transcript.readRange(request());
    expect(missingResult.availability).toBe("missing");

    const wrongCwd = await malformed.transcript.readRange({
      ...request(),
      session: { ...request().session, sessionParams: { ...request().session.sessionParams, cwd: "/tmp/other-project" } },
    });
    expect(wrongCwd).toMatchObject({ availability: "incompatible", revision: "cwd-mismatch" });
  });

  it("advertises the version-pinned SDK fork and keeps Claude control claims transport-bound", () => {
    const adapter = createClaudeLocalProviderCapabilities({ ...profile(), readFile: undefined });

    expect(adapter.fork.evidence).toMatchObject({
      status: "supported",
      providerVersion: "2.1.216",
      transport: "claude-agent-sdk-0.3.216",
      profileBound: true,
      profileRequired: true,
    });
    expect(adapter.fork.evidence.reason).toContain("Claude Agent SDK 0.3.216");
    expect(adapter.fork.evidence.reason).toContain("completed assistant UUID");
    expect(adapter.fork.fork).toBeTypeOf("function");

    const mismatchedProfile = createClaudeLocalProviderCapabilities({ ...profile(), readFile: undefined, providerVersion: "2.1.217" });
    expect(mismatchedProfile.fork.evidence).toMatchObject({ status: "unsupported", providerVersion: "2.1.217" });
    const redirectedProfile = createClaudeLocalProviderCapabilities(profile());
    expect(redirectedProfile.fork.evidence).toMatchObject({ status: "unsupported" });
    expect(redirectedProfile.fork.evidence.reason).toContain("local host profile transport");
    expect(adapter.control.steer.evidence).toMatchObject({
      status: "unsupported",
      providerVersion: "2.1.216",
      transport: "claude-cli-stream-json",
      profileBound: true,
    });
    expect(adapter.control.steer.evidence.reason).toContain("only confirms replay");
    expect(adapter.control.steer.evidence.reason).toContain("Finish the active Run");
    expect(adapter.control.steer.mode).toBeUndefined();
    expect(adapter.control.steer.requiresHandle).toBeUndefined();

    const unauditedVersion = createClaudeLocalProviderCapabilities({ ...profile(), providerVersion: "2.1.217" });
    expect(unauditedVersion.control.steer.evidence).toMatchObject({ status: "unknown", providerVersion: "2.1.217" });
    expect(unauditedVersion.control.steer.mode).toBeUndefined();

    expect(adapter.control.interrupt.evidence).toMatchObject({
      status: "supported",
      transport: "claude-cli-process",
      profileBound: true,
    });
    expect(adapter.control.interrupt.evidence.reason).toContain("Query.interrupt()");
    expect(adapter.control.interrupt.evidence.reason).toContain("process-level");
    expect(adapter.control.interrupt.mode).toBe("process");
    expect(adapter.control.interrupt.requiresHandle).toBe(true);
  });

  it("does not send an unprioritized stream-json message as native steer", async () => {
    const adapter = createClaudeLocalProviderCapabilities(profile());
    const handle = {
      runtimeType: "claude_local",
      capabilities: { steer: "native" as const, interrupt: "process" as const },
      steer: vi.fn(async () => ({
        disposition: "accepted_current" as const,
        providerThreadId: sessionId,
        providerTurnId: "turn-1",
      })),
      interrupt: vi.fn(async () => "waiting_safe_boundary" as const),
      dispose: vi.fn(async () => undefined),
    };

    await expect(adapter.control.steer.execute({
      runtimeType: "claude_local",
      handle,
      operation: { kind: "steer", input: { text: "Change direction.", clientMessageId: "message-1" } },
    })).resolves.toMatchObject({
      disposition: "unsupported",
      reason: expect.stringContaining("Finish the active Run"),
    });
    expect(handle.steer).not.toHaveBeenCalled();

    await expect(adapter.control.interrupt.execute({
      runtimeType: "claude_local",
      handle,
      operation: { kind: "interrupt", reason: "operator_stop" },
    })).resolves.toBe("waiting_safe_boundary");
    expect(handle.interrupt).toHaveBeenCalledWith("operator_stop");
  });

  it("matches the selected completed assistant head, not the session last UUID", async () => {
    const headSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
      },
      {
        type: "result",
        uuid: "result-1",
        parentUuid: "assistant-1",
        sessionId,
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const sourceSession = {
      ...request().session,
      sessionParams: { ...request().session.sessionParams, lastUuid: "result-1" },
    };

    await expect(verifyClaudeSessionAssistantHead({
      profile: profile(async () => headSession),
      binding,
      session: sourceSession,
      sourceAssistantUuid: "assistant-1",
    })).resolves.toMatchObject({
      status: "matched",
      sourceAssistantUuid: "assistant-1",
      currentAssistantUuid: "assistant-1",
      reason: null,
    });
  });

  it.each([
    {
      label: "an appended user event",
      tail: [
        {
          type: "user",
          uuid: "user-in-flight",
          parentUuid: "assistant-1",
          sessionId,
          message: { role: "user", content: "A newer prompt is in flight." },
        },
      ],
    },
    {
      label: "an appended partial assistant event",
      tail: [
        {
          type: "user",
          uuid: "user-in-flight",
          parentUuid: "assistant-1",
          sessionId,
          message: { role: "user", content: "A newer prompt is in flight." },
        },
        {
          type: "assistant",
          uuid: "assistant-in-flight",
          parentUuid: "user-in-flight",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "A partial answer." }] },
        },
      ],
    },
    {
      label: "an appended user event without a UUID",
      tail: [
        {
          type: "user",
          parentUuid: "assistant-1",
          sessionId,
          message: { role: "user", content: "A newer prompt is in flight." },
        },
      ],
    },
  ])("fails closed when $label follows the selected assistant", async ({ tail }) => {
    const inFlightSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
      },
      ...tail,
    ].map((entry) => JSON.stringify(entry)).join("\n");

    await expect(verifyClaudeSessionAssistantHead({
      profile: profile(async () => inFlightSession),
      binding,
      session: {
        ...request().session,
        sessionParams: { ...request().session.sessionParams, lastUuid: "result-1" },
      },
      sourceAssistantUuid: "assistant-1",
    })).resolves.toMatchObject({
      status: "unavailable",
      currentAssistantUuid: null,
    });
  });

  it("rejects a stale assistant boundary after a newer completed turn", async () => {
    const advancedSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
      },
      {
        type: "user",
        uuid: "user-2",
        parentUuid: "assistant-1",
        sessionId,
        message: { role: "user", content: "Second prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "user-2",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Second answer." }], stop_reason: "end_turn" },
      },
      {
        type: "result",
        uuid: "result-2",
        parentUuid: "assistant-2",
        sessionId,
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");

    await expect(verifyClaudeSessionAssistantHead({
      profile: profile(async () => advancedSession),
      binding,
      session: {
        ...request().session,
        sessionParams: { ...request().session.sessionParams, lastUuid: "result-2" },
      },
      sourceAssistantUuid: "assistant-1",
    })).resolves.toMatchObject({
      status: "mismatch",
      currentAssistantUuid: "assistant-2",
    });
  });

  it("fails closed when the current session chain is malformed or incomplete", async () => {
    const malformed = await verifyClaudeSessionAssistantHead({
      profile: profile(async () => `${sessionJsonl}\nnot-json`),
      binding,
      session: request().session,
      sourceAssistantUuid: "assistant-2",
    });
    const incompleteChain = await verifyClaudeSessionAssistantHead({
      profile: profile(async () => JSON.stringify({
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "missing-parent",
        sessionId,
        message: { role: "assistant", content: "answer", stop_reason: "end_turn" },
      })),
      binding,
      session: request().session,
      sourceAssistantUuid: "assistant-2",
    });

    expect(malformed).toMatchObject({ status: "unavailable", reason: expect.stringContaining("malformed") });
    expect(incompleteChain).toMatchObject({ status: "unavailable", reason: expect.stringContaining("incomplete") });
  });

  it("keeps optional binding identity attached to the profile-owned session store", async () => {
    const strictBinding: ClaudeProviderBindingRef = {
      ...binding,
      id: "binding-1",
      orgId: "org-1",
      workspaceBindingId: "workspace-1",
    };
    const strictProfile = { ...profile(), binding: strictBinding };
    const strictRequest = request({
      binding: strictBinding,
      session: {
        ...request().session,
        sessionParams: {
          ...request().session.sessionParams,
          profileBindingId: strictBinding.id,
          profileOrgId: strictBinding.orgId,
          workspaceBindingId: strictBinding.workspaceBindingId,
        },
      },
    });

    await expect(createClaudeLocalProviderCapabilities(strictProfile).transcript.readRange(strictRequest))
      .resolves.toMatchObject({ availability: "available" });
    await expect(createClaudeLocalProviderCapabilities(strictProfile).transcript.readRange({
      ...strictRequest,
      session: {
        ...strictRequest.session,
        sessionParams: { ...strictRequest.session.sessionParams, profileBindingId: "binding-2" },
      },
    })).resolves.toMatchObject({ availability: "incompatible", revision: "session-profile-mismatch" });
    await expect(createClaudeLocalProviderCapabilities({
      ...strictProfile,
      binding: { ...strictBinding, id: "binding-2" },
    }).transcript.readRange(strictRequest)).resolves.toMatchObject({
      availability: "incompatible",
      revision: "profile-mismatch",
    });
  });

  it("parses malformed JSONL without inventing records", () => {
    const parsed = parseClaudeSessionJsonl(`${JSON.stringify({ uuid: "valid" })}\nnot-json`);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.malformed).toBe(true);
  });

  it("keeps session metadata profile-bound without persisting secrets", () => {
    const serialized = sessionCodec.serialize({
      sessionId,
      cwd,
      claudeConfigDir: configDir,
      sessionFilePath: resolveClaudeSessionFilePath(configDir, cwd, sessionId),
      profileHostId: binding.hostId,
      profileId: binding.profileId,
      capabilityRevision: binding.capabilityRevision,
      ANTHROPIC_API_KEY: "must-not-persist",
    });

    expect(serialized).toMatchObject({
      sessionId,
      claudeConfigDir: configDir,
      profileHostId: binding.hostId,
      profileId: binding.profileId,
    });
    expect(serialized).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(sessionCodec.deserialize(serialized)).toMatchObject({ sessionFilePath: expect.any(String) });
  });

  it("exposes a profile resolver while leaving the unbound declaration unknown", () => {
    const resolver = createClaudeLocalProviderCapabilityResolver(() => profile());

    expect(resolver("claude_local", binding)?.transcript.readRange).toBeTypeOf("function");
    expect(resolver("claude_local", null)?.transcript.evidence.status).toBe("unknown");
    expect(resolver("cursor", binding)).toBeNull();
  });
});
