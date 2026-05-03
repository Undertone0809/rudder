import { describe, expect, it } from "vitest";
import { shouldPollLiveRunBackfill } from "./live-run-backfill";

describe("shouldPollLiveRunBackfill", () => {
  it("keeps polling active runs even when the websocket is connected", () => {
    expect(shouldPollLiveRunBackfill({ isLive: true, isStreamingConnected: true })).toBe(true);
    expect(shouldPollLiveRunBackfill({ isLive: true, isStreamingConnected: false })).toBe(true);
  });

  it("does not poll terminal runs", () => {
    expect(shouldPollLiveRunBackfill({ isLive: false, isStreamingConnected: true })).toBe(false);
    expect(shouldPollLiveRunBackfill({ isLive: false, isStreamingConnected: false })).toBe(false);
  });
});
