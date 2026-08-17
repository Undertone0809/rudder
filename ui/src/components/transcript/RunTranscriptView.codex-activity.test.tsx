import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";
import { TranscriptChatToolActionRow } from "./RunTranscriptView.chat";

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
      <ThemeProvider initialShowToolCallFailureIndicators>
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

  it("keeps detail durations in one trailing column across row variants", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <div>
          <TranscriptChatToolActionRow
            density="compact"
            quiet={false}
            block={{
              ts: "2026-07-23T00:00:01.000Z",
              endTs: "2026-07-23T00:00:24.000Z",
              name: "Skill",
              input: { skill: "ego-browser" },
              result: "Loaded skill",
              isError: false,
              status: "completed",
            }}
          />
          <TranscriptChatToolActionRow
            density="compact"
            quiet={false}
            block={{
              ts: "2026-07-23T00:00:25.000Z",
              endTs: "2026-07-23T00:00:25.047Z",
              name: "command_execution",
              input: { command: "rg transcript" },
              result: "match",
              isError: false,
              status: "completed",
            }}
          />
          <TranscriptChatToolActionRow
            density="compact"
            quiet={false}
            block={{
              ts: "2026-07-23T00:00:26.000Z",
              endTs: "2026-07-23T00:00:28.400Z",
              name: "command_execution",
              input: { command: "pnpm test" },
              result: "Tests failed",
              isError: true,
              status: "error",
            }}
          />
        </div>
      </ThemeProvider>,
    );

    expect((html.match(/data-transcript-action-trailing="true"/g) ?? [])).toHaveLength(3);
    expect((html.match(/data-transcript-action-duration="true"/g) ?? [])).toHaveLength(3);
    expect((html.match(/data-transcript-action-disclosure-slot="true"/g) ?? [])).toHaveLength(3);
    expect(html).not.toContain("Failed");
    expect(html).toContain("23s");
    expect(html).toContain("47ms");
    expect(html).toContain("2.4s");
  });

  it("keeps process content in the reading column while Steer stays full width", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-07-23T00:00:01.000Z",
              text: "Inspecting the current layout.",
            },
            {
              kind: "user",
              source: "steer",
              messageId: "steer-message-1",
              controlActionId: "steer-action-1",
              ts: "2026-07-23T00:00:02.000Z",
              text: "Keep the revised direction.",
            },
            {
              kind: "assistant",
              ts: "2026-07-23T00:00:03.000Z",
              text: "Continuing after Steer.",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain('data-transcript-chat-column="reading"');
    expect(html).toMatch(/data-transcript-chat-column="reading" class="max-w-3xl px-1"/);
    expect(html).toMatch(/data-transcript-chat-column="full" class="w-full"/);
    expect(html).toMatch(
      /data-transcript-chat-column="full"[\s\S]*data-testid="chat-transcript-steer-message"/,
    );
  });

  it("keeps detail-view tool disclosures hidden outside hover or focus even when details are open", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider initialShowToolCallFailureIndicators>
        <TranscriptChatToolActionRow
          block={{
            ts: "2026-07-23T00:00:01.000Z",
            endTs: "2026-07-23T00:00:02.000Z",
            name: "mcp__rudder-tools__rudder_chat_transcript",
            toolUseId: "mcp-rudder-1",
            input: { chatId: "chat-1" },
            result: "transcript",
            isError: true,
            status: "error",
          }}
          density="compact"
          defaultOpenOnError
          quiet={false}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("opacity-0 transition-opacity");
    expect(html).toContain("group-hover/activity-row:opacity-100");
    expect(html).toContain("group-focus-visible/activity-row:opacity-100");
    expect(html).toContain("[@media(hover:none)]:opacity-100");
    expect(html).toContain("[@media(pointer:coarse)]:opacity-100");
  });

  it("keeps an expanded activity-group disclosure hidden outside hover or focus", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider initialShowToolCallFailureIndicators>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-07-23T00:00:01.000Z",
              name: "tool_one",
              toolUseId: "tool-1",
              input: { value: 1 },
            },
            {
              kind: "tool_result",
              ts: "2026-07-23T00:00:01.100Z",
              toolUseId: "tool-1",
              content: "failed one",
              isError: true,
            },
            {
              kind: "tool_call",
              ts: "2026-07-23T00:00:02.000Z",
              name: "tool_two",
              toolUseId: "tool-2",
              input: { value: 2 },
            },
            {
              kind: "tool_result",
              ts: "2026-07-23T00:00:02.100Z",
              toolUseId: "tool-2",
              content: "failed two",
              isError: true,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toMatch(/class="[^"]*opacity-0[^"]*group-hover\/activity:opacity-100[^"]*" data-testid="transcript-action-group-disclosure"/);
  });
});
