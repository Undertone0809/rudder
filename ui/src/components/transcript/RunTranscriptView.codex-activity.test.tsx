import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";

describe("RunTranscriptView Codex-style chat activity", () => {
  it("keeps expanded activity aligned and removes persistent per-row chrome", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-07-23T00:00:01.000Z",
        name: "Skill",
        toolUseId: "skill-1",
        input: { skill: "systematic-debugging" },
      },
      {
        kind: "tool_result",
        ts: "2026-07-23T00:00:01.010Z",
        toolUseId: "skill-1",
        content: "Skill failed",
        isError: true,
      },
      {
        kind: "tool_call",
        ts: "2026-07-23T00:00:02.000Z",
        name: "command_execution",
        toolUseId: "command-1",
        input: { command: "pnpm test:run" },
      },
      {
        kind: "tool_result",
        ts: "2026-07-23T00:00:03.000Z",
        toolUseId: "command-1",
        content: "Tests failed",
        isError: true,
      },
    ];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={entries}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Used 1 skill, ran 1 command");
    expect(html).toContain("inline-flex max-w-full");
    expect(html).toContain("data-transcript-action-row-disclosure=\"true\"");
    expect(html).toContain("opacity-0");
    expect(html).not.toContain("motion-disclosure-enter mt-2 pl-3");
    expect(html).not.toContain("tabular-nums");
    expect(html).not.toContain("text-[#2f80ed]");
  });

  it("uses a neutral completed skill icon inside chat activity", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-07-23T00:00:01.000Z",
        name: "Skill",
        toolUseId: "skill-1",
        input: { skill: "systematic-debugging" },
      },
      {
        kind: "tool_result",
        ts: "2026-07-23T00:00:01.010Z",
        toolUseId: "skill-1",
        content: "Loaded skill",
        isError: false,
      },
    ];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={entries}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Use systematic-debugging skill");
    expect(html).not.toContain("text-[#2f80ed]");
    expect(html).toContain("text-muted-foreground");
  });
});
