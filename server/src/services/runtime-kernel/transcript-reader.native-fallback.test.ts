import { describe, expect, it, vi } from "vitest";
import { createTranscriptReader } from "./transcript-reader.js";
import {
  legacyTranscriptEvent,
  mockDatabase,
  nativeBoundTranscriptDatabase,
} from "./transcript-reader.test-support.js";

describe("native-bound legacy transcript display fallback", () => {
  it("shows only an exact retained Run/Span/Attempt copy and marks it non-authoritative", async () => {
    const db = nativeBoundTranscriptDatabase([
      legacyTranscriptEvent({ id: 1, spanId: "span-1", attemptId: "attempt-1", text: "retained exact copy" }),
      legacyTranscriptEvent({ id: 2, spanId: "span-other", attemptId: "attempt-1", text: "foreign span" }),
      legacyTranscriptEvent({ id: 3, spanId: "span-1", attemptId: "attempt-other", text: "foreign attempt" }),
      legacyTranscriptEvent({ id: 4, orgId: "org-other", spanId: "span-1", attemptId: "attempt-1", text: "foreign org" }),
      legacyTranscriptEvent({ id: 5, runId: "run-other", spanId: "span-1", attemptId: "attempt-1", text: "foreign Run" }),
      legacyTranscriptEvent({ id: 6, spanId: "span-1", attemptId: "attempt-1", text: "retained second copy" }),
    ]);
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      revision: "native-offline-r1",
      availability: "offline" as const,
      completeness: "unknown" as const,
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });
    const input = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 1,
    };

    const page = await reader.readRun(input);

    expect(page).toMatchObject({
      source: "legacy",
      availability: "available",
      completeness: "partial",
      nextCursor: expect.any(String),
      items: [expect.objectContaining({
        runId: "run-1",
        spanId: "span-1",
        origin: "legacy",
        text: "retained exact copy",
      })],
    });
    expect(page.completeness).not.toBe("complete");
    expect(page.items.map((entry) => entry.text)).toEqual(["retained exact copy"]);
    expect(db.eventWhereParameters.length).toBeGreaterThanOrEqual(3);
    for (const parameters of db.eventWhereParameters) {
      expect(parameters).toEqual(expect.arrayContaining(["org-1", "run-1", "span-1", "attempt-1"]));
    }

    const continued = await reader.readRun({ ...input, cursor: page.nextCursor });
    expect(continued).toMatchObject({
      source: "legacy",
      availability: "available",
      completeness: "unknown",
      items: [expect.objectContaining({ spanId: "span-1", origin: "legacy", text: "retained second copy" })],
    });
    expect(continued.completeness).not.toBe("complete");
    expect(nativeReader).toHaveBeenCalledOnce();
  });

  it("does not fall back when retained events exist only for foreign identities", async () => {
    const db = nativeBoundTranscriptDatabase([
      legacyTranscriptEvent({ id: 1, spanId: "span-other", attemptId: "attempt-1", text: "foreign span" }),
      legacyTranscriptEvent({ id: 2, spanId: "span-1", attemptId: "attempt-other", text: "foreign attempt" }),
      legacyTranscriptEvent({ id: 3, orgId: "org-other", spanId: "span-1", attemptId: "attempt-1", text: "foreign org" }),
      legacyTranscriptEvent({ id: 4, runId: "run-other", spanId: "span-1", attemptId: "attempt-1", text: "foreign Run" }),
    ]);
    const nativeReader = vi.fn().mockResolvedValue({
      items: [], revision: "native-offline-r1", availability: "offline", completeness: "unknown",
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      source: "native",
      availability: "offline",
      completeness: "unknown",
      items: [],
    });
    expect(db.eventWhereParameters).toHaveLength(1);
    for (const parameters of db.eventWhereParameters) {
      expect(parameters).toEqual(expect.arrayContaining(["org-1", "run-1", "span-1", "attempt-1"]));
    }
  });

  it("does not fall back when the native reader reports incompatibility", async () => {
    const db = nativeBoundTranscriptDatabase([
      legacyTranscriptEvent({ id: 1, spanId: "span-1", attemptId: "attempt-1", text: "must stay hidden" }),
    ]);
    const nativeReader = vi.fn().mockResolvedValue({
      items: [], revision: "native-incompatible-r1", availability: "incompatible", completeness: "unknown",
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    await expect(reader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      source: "native",
      availability: "incompatible",
      completeness: "unknown",
      items: [],
    });
  });

  it("does not hide native reader failures behind a retained legacy copy", async () => {
    const db = nativeBoundTranscriptDatabase([
      legacyTranscriptEvent({ id: 1, spanId: "span-1", attemptId: "attempt-1", text: "must stay hidden" }),
    ]);
    const providerError = new Error("native provider authorization failed");
    const nativeReader = vi.fn().mockRejectedValue(providerError);
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    await expect(reader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    })).rejects.toBe(providerError);
  });

  it("does not start native or legacy reads for unauthorized or foreign Run/span scopes", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [], revision: "native-offline-r1", availability: "offline", completeness: "unknown",
    });
    const unauthorizedDb = nativeBoundTranscriptDatabase([
      legacyTranscriptEvent({ id: 1, spanId: "span-1", attemptId: "attempt-1", text: "must stay hidden" }),
    ]);
    const unauthorizedReader = createTranscriptReader(unauthorizedDb as never, { nativeReader: { read: nativeReader } });
    await expect(unauthorizedReader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: false },
    })).rejects.toMatchObject({ status: 403 });

    const foreignRunReader = createTranscriptReader(mockDatabase({ runs: [] }) as never, {
      nativeReader: { read: nativeReader },
    });
    await expect(foreignRunReader.readRun({
      orgId: "org-other", runId: "run-other", principal: { type: "board", orgId: "org-other", authorized: true },
    })).rejects.toThrow("Agent run not found");

    const foreignSpanReader = createTranscriptReader(nativeBoundTranscriptDatabase([]) as never, {
      nativeReader: { read: nativeReader },
    });
    await expect(foreignSpanReader.readRun({
      orgId: "org-1", runId: "run-1", spanId: "span-other",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).rejects.toThrow("Transcript span not found");
    expect(nativeReader).not.toHaveBeenCalled();
  });
});
