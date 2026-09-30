import { describe, expect, it, vi } from "vitest";
import { createTranscriptReader, decodeTranscriptCursor, type NativeTranscriptReadInput } from "./transcript-reader.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

function fixture(options: { count?: number; userBytes?: number; maxNativeReadBytes?: number } = {}) {
  const db = mockDatabase({
    conversations: [{ id: "conversation-1", orgId: "org-1", updatedAt: new Date("2026-09-30T14:22:00.000Z") }],
    run: databaseRun({ chatConversationId: "conversation-1", resultJson: { retention: { transcriptSource: "legacy" } } }),
    spans: [databaseSpan("span-1", { selectorJson: {
      kind: "opencode_input", sessionId: "session-span-1", userMessageId: "native-user",
      boundaryStatus: "exact", terminalMessageIds: ["native-assistant"],
    } })],
    bindings: [databaseBinding("span-1", { conversationId: "conversation-1", runtimeType: "opencode_local", continuity: "native" })],
    segments: [databaseSegment("span-1", { runtimeType: "opencode_local" })],
  });
  let revision = "opencode:sealed-run-r1";
  // Production export semantics: bounded snapshot, no provider continuation,
  // and a legacy retention marker on an otherwise exact native Run.
  const entries = [
    { kind: "user", text: "x".repeat(options.userBytes ?? 16), sourceEntryId: "native-user" },
    { kind: "assistant", text: "READY", sourceEntryId: "native-assistant" },
    { kind: "result", text: "READY", sourceEntryId: "native-result" },
    ...Array.from({ length: Math.max(0, (options.count ?? 3) - 3) }, (_, index) => ({
      kind: "assistant", text: `extra-${index}`, sourceEntryId: `native-extra-${index}`,
    })),
  ].map((entry, index) => ({ ...entry, ts: new Date(Date.parse("2026-09-30T14:22:00.000Z") + index).toISOString() }));
  const nativeRead = vi.fn(async (input: NativeTranscriptReadInput) => ({
    items: options.maxNativeReadBytes ? [] : entries.slice(0, input.limit), revision, nextCursor: null,
    availability: "available" as const,
    completeness: options.maxNativeReadBytes || input.limit! < entries.length ? "partial" as const : "complete" as const,
    ...(options.maxNativeReadBytes ? { limitReached: { reason: "page_bytes" as const, maximum: input.maxBytes! } }
      : input.limit! < entries.length ? { limitReached: { reason: "total_items" as const, maximum: input.limit! } } : {}),
  }));
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
