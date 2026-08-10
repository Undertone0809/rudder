import { describe, expect, it } from "vitest";
import { selectChatTranscript, transcriptSummaryFromSources } from "./chat-transcript-persistence.js";

const legacy = [{ kind: "stdout" as const, ts: "2026-08-07T00:00:00.000Z", text: "legacy" }];
const detached = [{ kind: "stdout" as const, ts: "2026-08-07T00:00:01.000Z", text: "detached" }];
const ledger = [{ kind: "stdout" as const, ts: "2026-08-07T00:00:02.000Z", text: "ledger" }];

describe("chat transcript persistence", () => {
  it("uses generation events before detached entries and legacy payload", () => {
    expect(selectChatTranscript({ ledger, detached, legacyPayload: { __chatTranscript: legacy } })).toEqual(ledger);
    expect(selectChatTranscript({ ledger: [], detached, legacyPayload: { __chatTranscript: legacy } })).toEqual(detached);
    expect(selectChatTranscript({ ledger: [], detached: [], legacyPayload: { __chatTranscript: legacy } })).toEqual(legacy);
  });

  it("keeps summary precedence aligned with transcript precedence", () => {
    expect(transcriptSummaryFromSources({ ledger, detached, legacyPayload: { __chatTranscript: legacy } })).toMatchObject({
      entryCount: 1,
      startedAt: "2026-08-07T00:00:02.000Z",
    });
    expect(transcriptSummaryFromSources({ ledger: [], detached, legacyPayload: { __chatTranscript: legacy } })).toMatchObject({
      entryCount: 1,
      startedAt: "2026-08-07T00:00:01.000Z",
    });
  });
});
