import { describe, expect, it, vi } from "vitest";
import { createTranscriptReader, decodeTranscriptCursor, type NativeTranscriptReadInput } from "./transcript-reader.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

function fixture(options: { count?: number; userBytes?: number; maxNativeReadBytes?: number; openCodeShape?: boolean; drift?: "once" | "always"; savedMain2?: boolean } = {}) {
  const db = mockDatabase({
    conversations: [{ id: "conversation-1", orgId: "org-1", updatedAt: new Date("2026-09-30T14:22:00.000Z") }],
    run: databaseRun({ chatConversationId: "conversation-1", resultJson: { retention: { transcriptSource: "legacy" } } }),
    messages: options.savedMain2 ? [{ id: "saved-main2", orgId: "org-1", conversationId: "conversation-1",
      role: "user", body: "MAIN2 accepted once; no Run", runId: null, structuredPayload: null,
      createdAt: new Date("2026-09-30T14:23:00.000Z"), updatedAt: new Date("2026-09-30T14:23:00.000Z") }] : [],
    spans: [databaseSpan("span-1", { selectorJson: {
      kind: "opencode_input", sessionId: "session-span-1", userMessageId: "native-user",
      boundaryStatus: "exact", terminalMessageIds: [options.openCodeShape ? "native-final" : "native-assistant"],
    } })],
    bindings: [databaseBinding("span-1", { conversationId: "conversation-1", runtimeType: "opencode_local", continuity: "native" })],
    segments: [databaseSegment("span-1", { runtimeType: "opencode_local" })],
  });
  let revision = "opencode:sealed-run-r1";
  // Production export semantics: bounded snapshot, no provider continuation,
  // and a legacy retention marker on an otherwise exact native Run.
  const entries = (options.openCodeShape ? [
    { id: "native-user", kind: "user", text: "MAIN1", sourceEntryId: "native-user" },
    { id: "native-tool", kind: "tool_call", text: "rudder_agent_me", sourceEntryId: "native-tool" },
    { id: "native-tool:tool_result:1", kind: "tool_result", text: "identity", sourceEntryId: "native-tool" },
    { id: "native-tool:result:2", kind: "result", text: "tool phase", sourceEntryId: "native-tool" },
    { id: "native-final", kind: "assistant", text: "FINAL", sourceEntryId: "native-final" },
    { id: "native-final:result:1", kind: "result", text: "FINAL", sourceEntryId: "native-final" },
  ] : [
    { kind: "user", text: "x".repeat(options.userBytes ?? 16), sourceEntryId: "native-user" },
    { kind: "assistant", text: "READY", sourceEntryId: "native-assistant" },
    { kind: "result", text: "READY", sourceEntryId: "native-result" },
    ...Array.from({ length: Math.max(0, (options.count ?? 3) - 3) }, (_, index) => ({
      kind: "assistant", text: `extra-${index}`, sourceEntryId: `native-extra-${index}`,
    })),
  ]).map((entry, index) => ({ ...entry, ts: new Date(Date.parse("2026-09-30T14:22:00.000Z") + index).toISOString() }));
  let reads = 0;
  const nativeRead = vi.fn(async (input: NativeTranscriptReadInput) => {
    reads += 1;
    if (options.drift === "always" || (options.drift === "once" && reads === 2)) revision = `opencode:revision-${reads}`;
    return {
      items: options.maxNativeReadBytes ? [] : entries.slice(0, input.limit).map(entry => options.drift
        ? { ...entry, text: `${entry.text}@${revision}` } : entry), revision, nextCursor: null,
      availability: "available" as const,
      completeness: options.maxNativeReadBytes || input.limit! < entries.length ? "partial" as const : "complete" as const,
      ...(options.maxNativeReadBytes ? { limitReached: { reason: "page_bytes" as const, maximum: input.maxBytes! } }
        : input.limit! < entries.length ? { limitReached: { reason: "total_items" as const, maximum: input.limit! } } : {}),
    };
  });
  const legacyRead = vi.fn();
  return {
    reader: createTranscriptReader(db as never, { nativeReader: { read: nativeRead }, legacyReader: { readRun: legacyRead },
      ...(options.maxNativeReadBytes ? { maxNativeReadBytes: options.maxNativeReadBytes } : {}) }),
    nativeRead, legacyRead,
    changeRevision() { revision = "opencode:changed-run-r2"; },
  };
}

const scope = { orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true }, limit: 1 };

describe("native snapshot with retained legacy marker", () => {
  it("refreshes fresh Main1 hydration atomically after internal revision drift, preserving saved Main2 without a Run", async () => {
    const { reader, nativeRead, legacyRead } = fixture({ openCodeShape: true, savedMain2: true, drift: "once" });
    // This mock models one source window, not subsequent SQL keyset queries.
    // Six authoritative projections plus the accepted-once Main2 fill it.
    const page = await reader.readConversation({ orgId: scope.orgId, principal: scope.principal,
      conversationId: "conversation-1", limit: 7 });
    const nativeItems = page.items.filter(item => item.runId === "run-1");
    expect(nativeItems.map(item => item.id)).toEqual(["native-user", "native-tool", "native-tool:tool_result:1",
      "native-tool:result:2", "native-final", "native-final:result:1"]);
    expect(new Set(nativeItems.map(item => item.sourceEntryId))).toHaveProperty("size", 3);
    expect(nativeItems.every(item => item.text?.endsWith("@opencode:revision-2"))).toBe(true);
    expect(page.items.filter(item => item.id === "message:saved-main2:0")).toHaveLength(1);
    expect(page.items.find(item => item.id === "message:saved-main2:0")?.runId).toBeNull();
    expect(legacyRead).not.toHaveBeenCalled();
    expect(nativeRead).toHaveBeenCalledTimes(8);
  });

  it("bounds fresh hydration refresh and still rejects continuously changing native history", async () => {
    const { reader, nativeRead } = fixture({ openCodeShape: true, savedMain2: true, drift: "always" });
    await expect(reader.readConversation({ orgId: scope.orgId, principal: scope.principal,
      conversationId: "conversation-1", limit: 100 })).rejects.toMatchObject({ code: "cursor_revision_mismatch" });
    expect(nativeRead).toHaveBeenCalledTimes(4);
  });

  it("does not refresh an externally supplied conversation cursor across a changed provider revision", async () => {
    const { reader, nativeRead, changeRevision } = fixture({ openCodeShape: true });
    const input = { orgId: scope.orgId, principal: scope.principal, conversationId: "conversation-1", limit: 1 };
    const first = await reader.readConversation(input);
    changeRevision();
    await expect(reader.readConversation({ ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "cursor_revision_mismatch" });
    expect(nativeRead).toHaveBeenCalledTimes(2);
  });

  it("hydrates a conversation through internal one-item Run cursors", async () => {
    const { reader, nativeRead, legacyRead } = fixture({ userBytes: 550_000 });
    const page = await reader.readConversation({ orgId: scope.orgId, principal: scope.principal,
      conversationId: "conversation-1", limit: 100, range: { end: 2 } });
    expect(page.items.map(item => item.kind)).toEqual(["user", "assistant", "result"]);
    expect(page).toMatchObject({ source: "native", completeness: "complete", nextCursor: null });
    expect(nativeRead).toHaveBeenCalledTimes(3);
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it("drains user, assistant and final through native scope-bound cursors", async () => {
    const { reader, legacyRead, nativeRead } = fixture({ userBytes: 550_000 });
    const first = await reader.readRun(scope);
    expect(decodeTranscriptCursor(first.nextCursor!)).toMatchObject({
      source: "native", providerRevision: "opencode:sealed-run-r1", runId: "run-1", activeSpanId: "span-1",
    });
    const second = await reader.readRun({ ...scope, cursor: first.nextCursor });
    const third = await reader.readRun({ ...scope, cursor: second.nextCursor });
    expect([first, second, third].flatMap(page => page.items.map(item => item.kind))).toEqual(["user", "assistant", "result"]);
    expect([first, second, third].every(page => page.source === "native" && page.completeness === "complete")).toBe(true);
    expect(third.nextCursor).toBeNull();
    expect(legacyRead).not.toHaveBeenCalled();
    expect(nativeRead.mock.calls.at(-1)![0].limit).toBeGreaterThan(1);
    expect(nativeRead).toHaveBeenCalledTimes(3);
    expect(nativeRead.mock.calls.every(([input]) => input.maxBytes === 1024 * 1024)).toBe(true);
  });

  it("still rejects changed provider revision and foreign Run/org cursors", async () => {
    const { reader, changeRevision } = fixture();
    const first = await reader.readRun(scope);
    await expect(reader.readRun({ ...scope, orgId: "other-org", cursor: first.nextCursor })).rejects.toThrow();
    await expect(reader.readRun({ ...scope, runId: "other-run", cursor: first.nextCursor })).rejects.toThrow();
    changeRevision();
    await expect(reader.readRun({ ...scope, cursor: first.nextCursor })).rejects.toThrow("provider revision");
  });

  it("reports an over-cap snapshot honestly without switching to legacy", async () => {
    const { reader, legacyRead, nativeRead } = fixture({ count: 201 });
    const page = await reader.readRun({ ...scope, limit: 200 });
    expect(page).toMatchObject({ source: "native", completeness: "partial", nextCursor: null,
      limitReached: { reason: "total_items", maximum: 200 } });
    expect(page.items).toHaveLength(200);
    expect(nativeRead).toHaveBeenCalledOnce();
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it("keeps a byte-budget failure partial and never substitutes raw legacy input", async () => {
    const { reader, legacyRead, nativeRead } = fixture({ maxNativeReadBytes: 4096 });
    const page = await reader.readRun(scope);
    expect(page).toMatchObject({ source: "native", completeness: "partial", items: [], nextCursor: null,
      limitReached: { reason: "page_bytes", maximum: 4096 } });
    expect(nativeRead.mock.calls[0]![0].maxBytes).toBe(4096);
    expect(nativeRead).toHaveBeenCalledOnce();
    expect(legacyRead).not.toHaveBeenCalled();
  });
});
