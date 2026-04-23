// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";

describe("RunTranscriptView", () => {
  it("keeps running command stdout inside the command fold instead of a standalone stdout block", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-03-12T00:00:00.000Z",
        name: "command_execution",
        toolUseId: "cmd_1",
        input: { command: "ls -la" },
      },
      {
        kind: "stdout",
        ts: "2026-03-12T00:00:01.000Z",
        text: "file-a\nfile-b",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "command_group",
      items: [{ result: "file-a\nfile-b", status: "running" }],
    });
  });

  it("renders assistant and thinking content as markdown in compact mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Hello **world**",
            },
            {
              kind: "thinking",
              ts: "2026-03-12T00:00:01.000Z",
              text: "- first\n- second",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  it("hides saved-session resume skip stderr from nice mode normalization", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[rudder] Skipping saved session resume for task \"PAP-485\" because wake reason is issue_assigned.",
      },
      {
        kind: "assistant",
        ts: "2026-03-12T00:00:01.000Z",
        text: "Working on the task.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "message",
      role: "assistant",
      text: "Working on the task.",
    });
  });

  it("groups chat transcripts into model turns and keeps tool activity collapsed by default", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "init",
              ts: "2026-03-12T00:00:00.000Z",
              model: "codex",
              sessionId: "session-1",
            },
            {
              kind: "system",
              ts: "2026-03-12T00:00:01.000Z",
              text: "turn started",
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:02.000Z",
              text: "I will inspect the transcript before replying.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "read_file",
              toolUseId: "tool-1",
              input: { path: "README.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "tool-1",
              content: "README contents hidden by default",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Model turn 1");
    expect(html).toContain("Read README.md");
    expect(html).toContain("I will inspect the transcript before replying.");
    expect(html).not.toContain("README contents hidden by default");
    expect(html).not.toContain("Activity details");
  });

  it("summarizes multi-step tool activity in user-facing language", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Inspecting the repo before making changes.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-1",
              input: { command: "sed -n '1,120p' doc/GOAL.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-1",
              content: "goal",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "command_execution",
              toolUseId: "cmd-2",
              input: { command: "cat doc/PRODUCT.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "cmd-2",
              content: "product",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:05.000Z",
              name: "command_execution",
              toolUseId: "cmd-3",
              input: { command: "rg transcript ui/src/components/transcript" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:06.000Z",
              toolUseId: "cmd-3",
              content: "match",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:07.000Z",
              name: "command_execution",
              toolUseId: "cmd-4",
              input: { command: "pnpm test:run" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:08.000Z",
              toolUseId: "cmd-4",
              content: "tests passed",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Explored 2 files, 1 search, ran 1 command");
    expect(html).not.toContain("Executed 4 commands");
  });

  it("keeps errored tool details collapsed by default in detail presentation", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:00.000Z",
              name: "command_execution",
              toolUseId: "cmd-err-1",
              input: { command: "pnpm test:run ui/src/pages/IssueDetail.test.tsx" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:01.000Z",
              toolUseId: "cmd-err-1",
              content: "command: pnpm test:run ui/src/pages/IssueDetail.test.tsx\nstatus: failed\nexit_code: 1\n\nsh: vitest: command not found",
              isError: true,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Ran pnpm test:run");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("Request");
    expect(html).not.toContain("Response");
    expect(html).not.toContain("sh: vitest: command not found");
  });

  it("falls back to an implicit model turn for chat transcripts without turn markers", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Working through the request.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-1",
              input: { command: "pwd" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-1",
              content: "command: pwd\nstatus: completed\nexit_code: 0\n\n/workspace/rudder",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Model turn 1");
    expect(html).toContain("Ran pwd");
    expect(html).not.toContain("Activity details");
  });

  it("shows search queries in chat activity summaries", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Searching the transcript code.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-1",
              input: { command: "rg transcript ui/src/components/transcript" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-1",
              content: "match",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Searched &quot;transcript&quot; in ui/src/components/transcript");
    expect(html).not.toContain("Searched 1 location");
  });
});
