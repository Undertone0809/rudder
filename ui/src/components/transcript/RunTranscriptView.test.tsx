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

  it("renders a single chat log inline instead of behind a log-count disclosure", () => {
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
              kind: "stdout",
              ts: "2026-03-12T00:00:02.000Z",
              text: "Only actionable log",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Only actionable log");
    expect(html).not.toContain("1 log");
    expect(html).not.toContain("Expand output details");
  });

  it("filters routine Rudder-managed runtime home logs from nice transcript views", () => {
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
              kind: "stdout",
              ts: "2026-03-12T00:00:02.000Z",
              text:
                "[rudder] Using Rudder-managed Codex home \"/Users/zeeland/.rudder/instances/dev/codex\" (seeded from \"/Users/zeeland/.codex\").\n"
                + "[rudder] Realized 4 Rudder-managed Codex skill entries in /Users/zeeland/.rudder/instances/dev/codex/skills\n"
                + "[rudder] Loaded agent instructions file: /Users/zeeland/.rudder/instances/dev/workspaces/agents/rudder-copilot-system/instructions/AGENTS.md",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("model codex");
    expect(html).not.toContain("Using Rudder-managed Codex home");
    expect(html).not.toContain("Rudder-managed Codex skill entries");
    expect(html).not.toContain("Loaded agent instructions file");
    expect(html).not.toContain("1 log");
  });

  it("renders a single detail-turn log inline instead of behind a log-count disclosure", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
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
              kind: "stdout",
              ts: "2026-03-12T00:00:02.000Z",
              text: "Only actionable detail log",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Only actionable detail log");
    expect(html).not.toContain("1 log");
    expect(html).not.toContain("Expand output details");
    expect(html).not.toContain("Expand tool activity");
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
    const expectedTime = new Date("2026-03-12T00:00:00.000Z").toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
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
    expect(html).toContain(expectedTime);
    expect(html).toContain("Tool issue");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("Needs review");
    expect(html).not.toContain("bg-red-500/[0.04]");
    expect(html).not.toContain("Request");
    expect(html).not.toContain("Response");
    expect(html).not.toContain("sh: vitest: command not found");
  });

  it("renders command details without shell wrappers or result envelope metadata", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Checking the Vercel directory.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-wrapper-1",
              input: {
                command: "/bin/zsh -lc 'ls -la /Users/zeeland/.vercel 2>/dev/null || true'",
                cwd: "/Users/zeeland/projects/rudder-oss",
              },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-wrapper-1",
              content:
                "command: /bin/zsh -lc 'ls -la /Users/zeeland/.vercel 2>/dev/null || true'\nstatus: failed\nexit_code: 1\n\nls: /Users/zeeland/.vercel: Permission denied",
              isError: true,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("data-testid=\"command-terminal-detail\"");
    expect(html).toContain("command failed");
    expect(html).toContain("response");
    expect(html).toContain("ls -la /Users/zeeland/.vercel 2&gt;/dev/null || true");
    expect(html).toContain("ls: /Users/zeeland/.vercel: Permission denied");
    expect(html).not.toContain("/bin/zsh -lc");
    expect(html).not.toContain("&quot;cwd&quot;");
    expect(html).not.toContain("exit_code");
    expect(html).not.toContain("status: failed");
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

  it("groups detail transcripts by model turn so repeated reads stay collapsed behind one turn summary", () => {
    const expectedTime = new Date("2026-03-12T00:00:02.000Z").toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
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
              text: "Reviewing the bundled skills before deciding what to change.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "read_file",
              toolUseId: "tool-1",
              input: { path: "server/resources/bundled-skills/para-memory-files/SKILL.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "tool-1",
              content: "hidden",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:05.000Z",
              name: "read_file",
              toolUseId: "tool-2",
              input: { path: "server/resources/bundled-skills/rudder-create-agent/SKILL.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:06.000Z",
              toolUseId: "tool-2",
              content: "hidden",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Model turn 1");
    expect(html).toContain(expectedTime);
    expect(html).toContain("Reviewing the bundled skills before deciding what to change.");
    expect(html).toContain("Explored 2 files");
    expect(html).not.toContain("para-memory-files/SKILL.md");
    expect(html).not.toContain("rudder-create-agent/SKILL.md");
  });
});
