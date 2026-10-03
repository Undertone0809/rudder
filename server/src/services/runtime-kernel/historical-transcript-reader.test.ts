import { agentConfigRevisions, agents } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { createHistoricalTranscriptReader } from "./historical-transcript-reader.js";
import type { NativeTranscriptReadInput, TranscriptReaderOptions } from "./transcript-reader.js";

const mocks = vi.hoisted(() => ({ createNativeReader: vi.fn(), read: vi.fn() }));
vi.mock("../run-intelligence.js", () => ({
  createHistoricalRunNativeTranscriptReader: mocks.createNativeReader,
}));
vi.mock("./transcript-reader.js", () => ({
  createTranscriptReader: (_db: unknown, options: TranscriptReaderOptions) => options,
}));

function database(agentRows: unknown[], revisions: unknown[]) {
  return {
    select: vi.fn(() => {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        where() { return query; },
        limit() { return query; },
        orderBy() { return query; },
        then(resolve: (rows: unknown[]) => unknown) {
          return Promise.resolve(table === agents ? agentRows : table === agentConfigRevisions ? revisions : []).then(resolve);
        },
      };
      return query;
    }),
  };
}

describe("historical transcript consumer wiring", () => {
  it("resolves the Run's historical profile and forwards the exact read window to the native reader", async () => {
    mocks.createNativeReader.mockReturnValue({ readRange: mocks.read });
    const agent = { agentRuntimeType: "codex_local", agentRuntimeConfig: { cwd: "/tmp/current" }, runtimeConfig: {} };
    const revisions = [{ id: "revision-before-run", afterConfig: { cwd: "/tmp/historical" } }];
    const input = {
      orgId: "org-1", run: { agentId: "run-agent", createdAt: new Date(), contextSnapshot: {} },
      cursor: "page-two", limit: 10, span: { id: "exact-span" },
    } as NativeTranscriptReadInput;
    const db = database([agent], revisions);
    const reader = createHistoricalTranscriptReader(db as never) as unknown as TranscriptReaderOptions;
    expect(reader.objectReader?.readRange).toEqual(expect.any(Function));
    const result = { items: [{ id: "native-only-entry" }], revision: "native-r1", availability: "available" };
    mocks.read.mockResolvedValueOnce(result);
    await expect(reader.nativeReader!.read!(input)).resolves.toBe(result);
    expect(mocks.createNativeReader).toHaveBeenLastCalledWith({ ...input.run, ...agent }, revisions);
    expect(mocks.read).toHaveBeenLastCalledWith(input);
  });

  it("reports a deleted Agent's native history as missing without using another Agent's profile", async () => {
    mocks.read.mockClear();
    mocks.createNativeReader.mockClear();
    const reader = createHistoricalTranscriptReader(database([], []) as never) as unknown as TranscriptReaderOptions;
    await expect(reader.nativeReader!.read!({
      orgId: "org-1", run: { agentId: "deleted-agent" },
    } as NativeTranscriptReadInput)).resolves.toMatchObject({ availability: "missing", items: [] });
    expect(mocks.createNativeReader).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
