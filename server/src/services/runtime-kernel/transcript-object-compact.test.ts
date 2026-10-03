import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODEX_GAP_ENCODING,
  CodexGapDictionary,
  createCodexGapObjectMetadata,
  isCodexGapObjectMetadata,
} from "./transcript-object-compact.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const line = (text: string, ts = "2026-10-03T01:02:03.123456Z") => JSON.stringify({ version: 1,
  entry: { kind: "assistant", ts, segmentId: "segment-1", text } });

describe("self-contained gap byte dictionary (not native coverage)", () => {
  it("creates compact metadata only for an exact, complete new-object binding", () => {
    const binding = { orgId: "org-1", runId: "run-1", spanId: "span-1", ownerToken: "owner-1" };
    const identity = { ...binding, attemptId: "attempt-1", attemptEpoch: 1,
      selector: { kind: "codex_turn" as const, runId: "run-1", threadId: "thread-1", turnId: "turn-1" } };
    const metadata = createCodexGapObjectMetadata(identity, binding);
    expect(metadata).toMatchObject({ encoding: CODEX_GAP_ENCODING, logicalBytes: 0 });
    expect(metadata?.compactIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(isCodexGapObjectMetadata(metadata)).toBe(true);

    for (const unknown of [null, undefined, { ...identity, orgId: "other-org" },
      { ...identity, ownerToken: "other-owner" }, { ...identity, attemptId: "" },
      { ...identity, attemptEpoch: 0 }, { ...identity, selector: { ...identity.selector, turnId: "" } }]) {
      expect(createCodexGapObjectMetadata(unknown, binding)).toBeUndefined();
    }
    expect(isCodexGapObjectMetadata({ ...metadata, logicalBytes: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });

  it("restores exact bytes/formatting/timestamps/chunk order with no provider or original sidecar", () => {
    const original = [line("界🌍\\\n\"".repeat(1000)), line("界🌍\\\n\"".repeat(1000), "2026-10-03T01:02:04.654321Z"),
      ' {"version":1,"entry":{"kind":"system","ts":"2026-10-03","text":"reasoning started"}} '];
    const writer = new CodexGapDictionary();
    const encoded = original.map(value => writer.encode(value));
    const reader = new CodexGapDictionary();
    const restored = encoded.map(value => reader.decode(value, 2 * 1024 * 1024, true));
    expect(restored).toEqual(original);
    expect(hash(restored.join("\n"))).toBe(hash(original.join("\n")));
    expect(Buffer.byteLength(encoded.join("\n"))).toBeLessThan(Buffer.byteLength(original.join("\n")));
  });

  it("uses bounded committed dictionary state across writer reopen", () => {
    const writer = new CodexGapDictionary();
    writer.encode(line("abcdef".repeat(10000)));
    expect(writer.snapshot()).toHaveLength(32768);
    const reopened = new CodexGapDictionary(writer.snapshot());
    expect(reopened.encode(line("abcdef".repeat(1000)))).toBe(writer.encode(line("abcdef".repeat(1000))));
  });

  it("preserves tool args/results/isError, reasoning and unknown diagnostic kinds without filtering", () => {
    const rows = [{ kind: "tool_call", ts: "2026-10-03T01:02:03.123456Z", toolUseId: "tool-1", name: "synthetic", input: { key: "value界" } },
      { kind: "tool_result", ts: "2026-10-03T01:02:04.456789Z", toolUseId: "tool-1", content: "synthetic failure".repeat(500), isError: true },
      { kind: "reasoning", ts: "2026-10-03T01:02:05.456789Z", text: "synthetic reasoning".repeat(500) },
      { kind: "future_diagnostic", ts: "2026-10-03T01:02:06.456789Z", opaque: [1, true, null] }];
    const writer = new CodexGapDictionary(), reader = new CodexGapDictionary();
    for (const row of rows) {
      const original = JSON.stringify({ version: 1, entry: row });
      expect(reader.decode(writer.encode(original), 2 * 1024 * 1024, true)).toBe(original);
    }
  });

  it.each(["hash", "dictionary", "length", "data", "version", "encoding"])("rejects changed %s without claiming complete", change => {
    const writer = new CodexGapDictionary();
    const encoded = JSON.parse(writer.encode(line("repeat".repeat(1000))));
    if (change === "hash") encoded.sha256 = "0".repeat(64);
    if (change === "dictionary") encoded.dictionarySha256 = "0".repeat(64);
    if (change === "length") encoded.bytes = 3 * 1024 * 1024;
    if (change === "data") encoded.data = "%%";
    if (change === "version") encoded.version = 3;
    if (change === "encoding") encoded.encoding = "unknown";
    expect(() => new CodexGapDictionary().decode(JSON.stringify(encoded), 2 * 1024 * 1024, true)).toThrow();
  });

  it("rejects missing/reordered history and v2 in a legacy object", () => {
    const writer = new CodexGapDictionary();
    const first = writer.encode(line("abcdef".repeat(5000)));
    const second = writer.encode(line("abcdef".repeat(4000)));
    expect(() => new CodexGapDictionary().decode(second, 2 * 1024 * 1024, true)).toThrow();
    expect(() => new CodexGapDictionary().decode(first, 2 * 1024 * 1024, false)).toThrow();
  });
});
