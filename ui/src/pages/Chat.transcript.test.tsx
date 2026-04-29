// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/agent-runtimes";
import { ThemeProvider } from "@/context/ThemeContext";
import { StreamTranscriptItem } from "./Chat";

const transcriptEntries: TranscriptEntry[] = [
  {
    kind: "init",
    ts: "2026-04-30T00:00:00.000Z",
    model: "codex",
    sessionId: "session-1",
  },
  {
    kind: "system",
    ts: "2026-04-30T00:00:01.000Z",
    text: "turn started",
  },
  {
    kind: "assistant",
    ts: "2026-04-30T00:00:02.000Z",
    text: "Reviewing the request and preparing a concise reply.",
  },
];

describe("StreamTranscriptItem", () => {
  it("keeps a completed persisted transcript open when requested", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <StreamTranscriptItem
          entries={transcriptEntries}
          state="completed"
          streamStartedAt={new Date("2026-04-30T00:00:00.000Z")}
          streamEndedAt={new Date("2026-04-30T00:00:15.000Z")}
          defaultOpen
        />
      </ThemeProvider>,
    );

    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("Worked for 15s");
    expect(html).toContain("Model turn 1");
    expect(html).toContain("Reviewing the request and preparing a concise reply.");
  });
});
