// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript, resolveTranscriptLocalFileTarget } from "./RunTranscriptView";

function countOccurrences(value: string, needle: string) {
  return value.split(needle).length - 1;
}

function classValueForText(html: string, text: string) {
  const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*>[\\s\\S]*?${escapedText}`));
  return match?.[1] ?? "";
}

function renderCommandSummary(command: string) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <RunTranscriptView
        density="compact"
        presentation="chat"
        entries={[
          {
            kind: "tool_call",
            ts: "2026-03-12T00:00:01.000Z",
            name: "command_execution",
            toolUseId: "cmd-summary-1",
            input: { command },
          },
          {
            kind: "tool_result",
            ts: "2026-03-12T00:00:02.000Z",
            toolUseId: "cmd-summary-1",
            content: "command completed",
            isError: false,
          },
        ]}
      />
    </ThemeProvider>,
  );
}

describe("RunTranscriptView", () => {
  it("recognizes only local file targets for transcript links", () => {
    expect(resolveTranscriptLocalFileTarget("/Users/zeeland/work/result.md")).toBe("/Users/zeeland/work/result.md");
    expect(resolveTranscriptLocalFileTarget("file:///Users/zeeland/work/result%20copy.md")).toBe("/Users/zeeland/work/result copy.md");
    expect(resolveTranscriptLocalFileTarget("C:\\Users\\zeeland\\work\\result.md")).toBe("C:\\Users\\zeeland\\work\\result.md");
    expect(resolveTranscriptLocalFileTarget("https://example.com/result.md")).toBeNull();
    expect(resolveTranscriptLocalFileTarget("result.md")).toBeNull();
    expect(resolveTranscriptLocalFileTarget("/issues/RUD-43")).toBeNull();
  });

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

    const blocks = normalizeTranscript(entries, true);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "command_group",
      items: [{ result: "file-a\nfile-b", status: "running" }],
    });
  });

  it("closes unmatched tool calls once the run is no longer streaming", () => {
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
      items: [{ result: "file-a\nfile-b", status: "completed" }],
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
    expect(html).toContain(">first</li>");
    expect(html).toContain(">second</li>");
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

  it("renders Codex todo list updates as a checklist", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "todo_list",
        ts: "2026-05-07T05:00:00.000Z",
        todoListId: "item_3",
        items: [
          { text: "Checkout assigned issue", status: "completed" },
          { text: "Inspect agent patterns", status: "pending" },
          { text: "Patch transcript UI", status: "in_progress" },
        ],
      },
      {
        kind: "todo_list",
        ts: "2026-05-07T05:00:10.000Z",
        todoListId: "item_3",
        items: [
          { text: "Checkout assigned issue", status: "completed" },
          { text: "Inspect agent patterns", status: "completed" },
          { text: "Patch transcript UI", status: "in_progress" },
        ],
      },
    ];

    const blocks = normalizeTranscript(entries, true);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "todo_list",
      items: [
        { text: "Checkout assigned issue", status: "completed" },
        { text: "Inspect agent patterns", status: "completed" },
        { text: "Patch transcript UI", status: "in_progress" },
      ],
    });

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView density="compact" entries={entries} />
      </ThemeProvider>,
    );

    expect(html).toContain("Todo List");
    expect(html).toContain("2/3");
    expect(html).toContain("Checkout assigned issue");
    expect(html).toContain("Patch transcript UI");
    expect(html).not.toContain("todo_list");
  });

  it("does not render stderr warning lines or their analytics HTML body", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          entries={[
            {
              kind: "stderr",
              ts: "2026-05-02T08:58:43.000Z",
              text: "2026-05-02T08:58:43.814979Z  WARN codex_protocol::openai_models: Model personality requested but model_messages is missing, falling back to base instructions. model=gpt-5.5 personality=pragmatic",
            },
            {
              kind: "stderr",
              ts: "2026-05-02T08:58:57.000Z",
              text: "2026-05-02T08:58:57.468646Z  WARN codex_analytics::analytics_client: events failed with status 403 Forbidden: <html>",
            },
            {
              kind: "stderr",
              ts: "2026-05-02T08:58:58.000Z",
              text: "<body>Enable JavaScript and cookies to continue</body>",
            },
            {
              kind: "stderr",
              ts: "2026-05-02T08:58:59.000Z",
              text: "</html>",
            },
            {
              kind: "assistant",
              ts: "2026-05-02T08:59:00.000Z",
              text: "Continuing after runtime noise.",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).not.toContain("model_messages is missing");
    expect(html).not.toContain("Enable JavaScript and cookies");
    expect(html).toContain("Continuing after runtime noise.");
  });

  it("does not render benign Codex runtime stderr in nice or raw mode", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-05-15T06:57:31.977Z",
        text: [
          "2026-05-15T06:57:31.977213Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
          "2026-05-15T06:57:34.139709Z ERROR codex_memories_write::phase2: Phase 2 no changes",
          "2026-05-15T06:57:44.058316Z ERROR codex_core::models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
        ].join("\n"),
      },
    ];

    const niceHtml = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView entries={entries} />
      </ThemeProvider>,
    );
    const rawHtml = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView entries={entries} mode="raw" />
      </ThemeProvider>,
    );

    expect(niceHtml).not.toContain("failed to refresh available models");
    expect(rawHtml).not.toContain("failed to refresh available models");
    expect(niceHtml).not.toContain("Phase 2 no changes");
    expect(rawHtml).not.toContain("Phase 2 no changes");
  });

  it("collapses long stderr by default while keeping a short summary visible", () => {
    const longError = [
      "Error: provider returned a long diagnostic",
      ...Array.from({ length: 16 }, (_, index) => `stack frame ${index}: very detailed line that should stay folded`),
    ].join("\n");

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          presentation="detail"
          entries={[
            {
              kind: "stderr",
              ts: "2026-05-02T08:58:43.000Z",
              text: longError,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Expand stderr details");
    expect(html).toContain("Error: provider returned a long diagnostic");
    expect(html).not.toContain("stack frame 15");
  });

  it("groups chat transcripts into readable progress chunks and keeps tool activity collapsed by default", () => {
    const messageTime = new Date("2026-03-12T00:00:02.000Z").toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
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

    expect(html).not.toContain("Model turn");
    expect(html).not.toContain("Completed");
    expect(html).toContain(`title="${messageTime}"`);
    expect(html).toContain("Read README.md");
    expect(html).toContain("I will inspect the transcript before replying.");
    expect(countOccurrences(html, "I will inspect the transcript before replying.")).toBe(1);
    expect(html).not.toContain("README contents hidden by default");
    expect(html).not.toContain("Activity details");
  });

  it("can hide assistant transcript text when chat renders the final answer separately", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          hideAssistantMessages
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:01.000Z",
              text: "turn started",
            },
            {
              kind: "thinking",
              ts: "2026-03-12T00:00:02.000Z",
              text: "Preparing the answer.",
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:03.000Z",
              text: "Final answer shown in the assistant message.",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Preparing the answer.");
    expect(html).not.toContain("Final answer shown in the assistant message.");
  });

  it("keeps chat assistant progress while redacting only the final answer suffix", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          hiddenAssistantMessageText="Final answer shown in the assistant message."
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:01.000Z",
              text: "turn started",
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:02.000Z",
              text: "I am checking the chat surface first.",
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:03.000Z",
              text: "Final answer shown ",
              delta: true,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:04.000Z",
              text: "in the assistant message.",
              delta: true,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:05.000Z",
              name: "read_file",
              toolUseId: "tool-1",
              input: { path: "ui/src/pages/Chat.tsx" },
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("I am checking the chat surface first.");
    expect(html).toContain("Read ui/src/pages/Chat.tsx");
    expect(html).not.toContain("Final answer shown");
    expect(html).not.toContain("in the assistant message.");
  });

  it("renders chat thinking inline instead of behind a collapsed summary", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          hideAssistantMessages
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:01.000Z",
              text: "turn started",
            },
            {
              kind: "thinking",
              ts: "2026-03-12T00:00:02.000Z",
              text: [
                "**Planning the response** with enough context to keep the operator oriented.",
                "The full reasoning note stays readable in the chat transcript instead of being clipped.",
                "Final planning checkpoint remains visible inline.",
              ].join("\n\n"),
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).not.toContain("Expand thinking");
    expect(html).not.toContain("Collapse thinking");
    expect(html).toContain("<strong>Planning the response</strong>");
    expect(html).toContain("Final planning checkpoint remains visible inline.");
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

  it("renders a single chat tool call as a collapsible row", () => {
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
              text: "I will read the README before replying.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "command_execution",
              toolUseId: "cmd-read-1",
              input: { command: "sed -n '1,220p' README.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "cmd-read-1",
              content: "README contents hidden until expanded",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Read README.md");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("Expand command details");
    expect(html).not.toContain("data-testid=\"command-terminal-detail\"");
    expect(html).not.toContain("README contents hidden until expanded");
    expect(html).not.toContain("Expand tool activity");
  });

  it("keeps compact chat tool rows tight and center-aligned", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:01.000Z",
              text: "turn started",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:02.000Z",
              name: "tool",
              toolUseId: "tool-compact-1",
              input: {},
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:03.000Z",
              toolUseId: "tool-compact-1",
              content: "ok",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:04.000Z",
              text: "The next progress note should sit close to the tool row.",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("space-y-1");
    expect(html).not.toContain("space-y-1.5");
    expect(html).toContain("Tool");
    const rowClass = classValueForText(html, "Tool");
    const wrapperClass = html.match(/<div class="([^"]*)" title="[^"]*"><button[^>]*>[\s\S]*?Tool/)?.[1] ?? "";
    expect(wrapperClass.split(" ")).toContain("py-0.5");
    expect(wrapperClass.split(" ")).not.toContain("py-1");
    expect(wrapperClass.split(" ")).not.toContain("py-1.5");
    expect(rowClass.split(" ")).toContain("gap-1.5");
    expect(rowClass.split(" ")).not.toContain("gap-2");
    expect(rowClass.split(" ")).toContain("items-center");
    expect(rowClass.split(" ")).not.toContain("items-start");
    expect(html).toContain("The next progress note should sit close to the tool row.");
  });

  it("renders Rudder issue close-out commands as one human-readable event", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:00.000Z",
              text: "turn started",
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:01.000Z",
              text: "I have enough evidence to close the issue.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:02.000Z",
              name: "command_execution",
              toolUseId: "cmd-close-1",
              input: {
                command: "rudder issue done \"RUD-38\" --comment-file /tmp/review-summary.md",
              },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.354Z",
              toolUseId: "cmd-close-1",
              content: "command: rudder issue done \"RUD-38\" --comment-file /tmp/review-summary.md\nstatus: completed\nexit_code: 0\n\nIssue RUD-38 marked done.",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Marked RUD-38 done");
    expect(html).toContain("added file-backed comment");
    expect(countOccurrences(html, "Marked RUD-38 done")).toBe(1);
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("Ran rudder issue done");
    expect(html).not.toContain("Command activity");
    expect(html).not.toContain("Review Summary\\n\\n");
    expect(html).not.toContain("data-testid=\"command-terminal-detail\"");
  });

  it("summarizes Rudder help pipelines neutrally instead of as issue mutations", () => {
    const html = renderCommandSummary("rudder issue --help | sed -n '1,120p'");

    expect(html).toContain("Checked rudder issue help");
    expect(html).not.toContain("Updated sed");
    expect(html).not.toContain("Updated --help");
  });

  it("customizes read-only Rudder issue commands separately from issue updates", () => {
    const html = renderCommandSummary("rudder issue context RUD-38 --json | sed -n '1,80p'");
    const commentsHtml = renderCommandSummary("rudder issue comments list RUD-38 --json");
    const updateHtml = renderCommandSummary("rudder issue update ZST-69 --status todo --comment-file /tmp/update.md");

    expect(html).toContain("Inspected RUD-38");
    expect(html).not.toContain("Updated RUD-38");
    expect(commentsHtml).toContain("Inspected comments for RUD-38");
    expect(commentsHtml).not.toContain("Updated list");
    expect(updateHtml).toContain("Updated ZST-69");
    expect(updateHtml).not.toContain("Ran rudder command");
  });

  it("keeps sed pipelines neutral or read-only unless a strong write signal exists", () => {
    const readPipeline = renderCommandSummary("cat README.md | sed -n '1,40p'");
    const writeCommand = renderCommandSummary("sed -i '' 's/old/new/' README.md");

    expect(readPipeline).toContain("Read README.md");
    expect(readPipeline).not.toContain("Edited");
    expect(writeCommand).toContain("Edited README.md");
  });

  it("degrades unknown complex shell pipelines to a neutral fallback", () => {
    const html = renderCommandSummary("foo --bar | sed -n '1,20p'");

    expect(html).toContain("Ran shell command");
    expect(html).not.toContain("Updated sed");
    expect(html).not.toContain("Edited");
  });

  it("scans complex shell segments for strong write signals", () => {
    const removeHtml = renderCommandSummary("echo hi && rm file.txt");
    const redirectHtml = renderCommandSummary("foo --bar | sed -n '1,20p' > out.txt");
    const installHtml = renderCommandSummary("echo ready && pnpm add zod");

    expect(removeHtml).toContain("Edited file.txt");
    expect(removeHtml).not.toContain("Ran shell command");
    expect(redirectHtml).toContain("Edited out.txt");
    expect(installHtml).toContain("Installed packages");
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
                + "[rudder] Prepared isolated Git config at /Users/zeeland/.rudder/instances/dev/workspaces/agents/rudder-copilot-system/.gitconfig with user.useConfigOnly=true (using global Git identity Zeeland <zeeland@example.com>).\n"
                + "[rudder] Prepared repository Git config in /Users/zeeland/.rudder/instances/dev/workspaces/agents/rudder-copilot-system with user.useConfigOnly=true (using global Git identity Zeeland <zeeland@example.com>).\n"
                + "[rudder] Realized 4 Rudder-managed Codex skill entries in /Users/zeeland/.rudder/instances/dev/codex/skills\n"
                + "[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md\n"
                + "[rudder] Loaded agent soul instructions file: $AGENT_HOME/instructions/SOUL.md\n"
                + "[rudder] Loaded agent tool notes file: $AGENT_HOME/instructions/TOOLS.md\n"
                + "[rudder] Loaded agent memory instructions file: $AGENT_HOME/instructions/MEMORY.md",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).not.toContain("model codex");
    expect(html).not.toContain("Using Rudder-managed Codex home");
    expect(html).not.toContain("Prepared isolated Git config");
    expect(html).not.toContain("Prepared repository Git config");
    expect(html).not.toContain("Rudder-managed Codex skill entries");
    expect(html).not.toContain("Loaded agent instructions file");
    expect(html).not.toContain("Loaded agent soul instructions file");
    expect(html).not.toContain("Loaded agent tool notes file");
    expect(html).not.toContain("Loaded agent memory instructions file");
    expect(html).not.toContain("1 log");
  });

  it("hides developer diagnostics by default and restores them when enabled", () => {
    const entries = [
      {
        kind: "init" as const,
        ts: "2026-03-12T00:00:00.000Z",
        model: "codex",
        sessionId: "session-1",
      },
      {
        kind: "system" as const,
        ts: "2026-03-12T00:00:01.000Z",
        text: "turn started",
      },
      {
        kind: "stdout" as const,
        ts: "2026-03-12T00:00:02.000Z",
        text:
          "[rudder] Shared 6 local CLI credential entries into managed HOME /Users/zeeland/.rudder/instances/dev/organizations/org/claude-home:\n"
          + ".config/gh, .config/configstore, .docker, .kube, .npmrc, .ssh\n"
          + "[rudder] Prepared local CLI credential shim for: gh\n"
          + "[rudder] Agent workspace \"/Users/zeeland/.rudder/instances/default/organizations/org/workspaces/agents/vera\" is now the canonical run workspace. Attempting to resume session \"019dfc\" that was previously saved in \"/Users/zeeland/.rudder/instances/default/organizations/org/workspaces\".\n"
          + "[rudder] Codex session \"019dfc\" was saved for cwd \"/Users/zeeland/.rudder/instances/default/organizations/org/workspaces/agents/vera\" and will not be resumed in \"/Users/zeeland/.rudder/instances/default/organizations/org/workspaces\".\n"
          + "[rudder] Using Rudder-managed Claude home \"/tmp/claude-home\" (seeded from \"/Users/zeeland/.claude\").\n"
          + "[rudder] Using Rudder-managed Cursor home \"/tmp/cursor-home\" (seeded from \"/Users/zeeland/.cursor\").\n"
          + "[rudder] Using Rudder-managed Gemini home \"/tmp/gemini-home\" (seeded from \"/Users/zeeland/.gemini\").\n"
          + "[rudder] Using Rudder-managed OpenCode home \"/tmp/opencode-home\" (seeded from \"/Users/zeeland/.opencode\").\n"
          + "[rudder] Using Rudder-managed Pi home \"/tmp/pi-home\" (seeded from \"/Users/zeeland/.pi\").\n"
          + "Checked the repository status",
      },
      {
        kind: "stderr" as const,
        ts: "2026-03-12T00:00:03.000Z",
        text: "[rudder] Failed to post workspace-ready comment: unavailable\nRecoverable adapter warning",
      },
    ];
    const hiddenHtml = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView density="compact" presentation="detail" entries={entries} />
      </ThemeProvider>,
    );
    const visibleHtml = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          entries={entries}
          showDeveloperDiagnostics
        />
      </ThemeProvider>,
    );

    expect(hiddenHtml).not.toContain("model codex");
    expect(hiddenHtml).not.toContain("Shared 6 local CLI credential entries");
    expect(hiddenHtml).not.toContain(".config/gh");
    expect(hiddenHtml).not.toContain("Prepared local CLI credential shim");
    expect(hiddenHtml).not.toContain("canonical run workspace");
    expect(hiddenHtml).not.toContain("will not be resumed");
    expect(hiddenHtml).not.toContain("Rudder-managed Claude home");
    expect(hiddenHtml).not.toContain("Rudder-managed Cursor home");
    expect(hiddenHtml).not.toContain("Rudder-managed Gemini home");
    expect(hiddenHtml).not.toContain("Rudder-managed OpenCode home");
    expect(hiddenHtml).not.toContain("Rudder-managed Pi home");
    expect(hiddenHtml).not.toContain("Failed to post workspace-ready comment");
    expect(hiddenHtml).toContain("Checked the repository status");
    expect(hiddenHtml).toContain("Recoverable adapter warning");

    expect(visibleHtml).toContain("model codex");
    expect(visibleHtml).toContain("Shared 6 local CLI credential entries");
    expect(visibleHtml).toContain(".config/gh");
    expect(visibleHtml).toContain("Prepared local CLI credential shim");
    expect(visibleHtml).toContain("canonical run workspace");
    expect(visibleHtml).toContain("will not be resumed");
    expect(visibleHtml).toContain("Rudder-managed Claude home");
    expect(visibleHtml).toContain("Rudder-managed Cursor home");
    expect(visibleHtml).toContain("Rudder-managed Gemini home");
    expect(visibleHtml).toContain("Rudder-managed OpenCode home");
    expect(visibleHtml).toContain("Rudder-managed Pi home");
    expect(visibleHtml).toContain("Failed to post workspace-ready comment");
    expect(visibleHtml).toContain("Checked the repository status");
    expect(visibleHtml).toContain("Recoverable adapter warning");
  });

  it("normalizes agent memory file changes into dedicated memory update blocks", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "system",
        ts: "2026-03-12T00:00:00.000Z",
        text:
          "file changes: update /Users/zeeland/.rudder/instances/default/organizations/org/workspaces/agents/gabriel--abc/instructions/MEMORY.md",
      },
      {
        kind: "system",
        ts: "2026-03-12T00:00:01.000Z",
        text: "file changes: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx",
      },
      {
        kind: "system",
        ts: "2026-03-12T00:00:02.000Z",
        text: "file_change: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx",
      },
      {
        kind: "system",
        ts: "2026-03-12T00:00:03.000Z",
        text: "file changes failed: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx permission denied",
      },
      {
        kind: "system",
        ts: "2026-03-12T00:00:04.000Z",
        text: "file changes: update /tmp/AgentDetail.tsx",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks[0]).toMatchObject({
      type: "memory_update",
      status: "completed",
      agentName: "Gabriel",
      scope: "stable_instructions",
      summary: "Gabriel updated stable memory instructions.",
      effect: "Effective next run",
    });
    expect(blocks[1]).toMatchObject({
      type: "event",
      label: "file change",
      tone: "neutral",
      text: "Updated src/pages/AgentDetail.tsx",
      detail: "file changes: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx",
      collapseByDefault: true,
    });
    expect(blocks[2]).toMatchObject({
      type: "event",
      label: "file change",
      tone: "neutral",
      text: "Updated src/pages/AgentDetail.tsx",
      detail: "file_change: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx",
      collapseByDefault: true,
    });
    expect(blocks[3]).toMatchObject({
      type: "event",
      label: "file change",
      tone: "warn",
      text: "Failed src/pages/AgentDetail.tsx permission denied",
      detail: "file changes failed: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx permission denied",
      collapseByDefault: true,
    });
    expect(blocks[4]).toMatchObject({
      type: "event",
      label: "file change",
      tone: "neutral",
      text: "Updated AgentDetail.tsx",
      detail: "file changes: update /tmp/AgentDetail.tsx",
      collapseByDefault: true,
    });
  });

  it("renders non-memory file changes as compact toast-like events", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:00.000Z",
              text: "file changes: add /Users/zeeland/projects/rudder-oss/doc/plans/2026-06-10-unified-agent-run-architecture.md",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain('data-transcript-file-change="true"');
    expect(html).toContain("File Change");
    expect(html).toContain("Created doc/plans/2026-06-10-unified-agent-run-architecture.md");
    expect(html).not.toContain("aria-label=");
    expect(html).not.toContain("file changes: add /Users/zeeland/projects/rudder-oss/doc/plans/2026-06-10-unified-agent-run-architecture.md");
    expect(html).not.toContain("/Users/zeeland/projects/rudder-oss");
    expect(html).not.toContain("text-amber-700");
    expect(html).not.toContain("dark:text-amber-300");
  });

  it("renders memory updates without exposing raw paths until details are expanded", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:00.000Z",
              text: "file changes: update $AGENT_HOME/instructions/MEMORY.md",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Agent memory updated");
    expect(html).not.toContain(">Updated<");
    expect(html).toContain("Agent updated stable memory instructions.");
    expect(html).toContain("Stable instructions");
    expect(html).toContain("Effective next run");
    expect(html).toContain('data-transcript-action-icon="memory"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("$AGENT_HOME/instructions/MEMORY.md");
    expect(html).not.toContain("file changes: update");
  });

  it("renders failed memory updates as failure rows with expanded technical details", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:00.000Z",
              text: "memory update failed: update $AGENT_HOME/memory/2026-03-12.md permission denied",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Memory update failed");
    expect(html).toContain("Daily note");
    expect(html).not.toContain(">Failed<");
    expect(html).toContain("permission denied");
    expect(html).toContain("$AGENT_HOME/memory/2026-03-12.md");
    expect(html).toContain("Raw event");
    expect(html).toContain('aria-expanded="true"');
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
    expect(html).toContain('data-transcript-action-group-icon-slot="true"');
    expect(html).not.toContain("Executed 4 commands");
  });

  it("keeps mixed-success chat tool groups neutral and collapsed", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Checking a few commands.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-ok-1",
              input: { command: "pwd" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-ok-1",
              content: "command: pwd\nstatus: completed\nexit_code: 0\n\n/workspace/rudder",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "command_execution",
              toolUseId: "cmd-fail-1",
              input: { command: "pnpm missing-script" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "cmd-fail-1",
              content: "command: pnpm missing-script\nstatus: failed\nexit_code: 1\n\nCommand failed",
              isError: true,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Expand tool activity");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("hover:bg-red-500/[0.05]");
    expect(html).not.toContain("bg-red-500/[0.08]");
    expect(html).not.toContain("Command failed");
  });

  it("highlights chat tool groups only when every tool call fails", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Trying two commands.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-fail-1",
              input: { command: "pnpm missing-script" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-fail-1",
              content: "command: pnpm missing-script\nstatus: failed\nexit_code: 1\n\nFirst command failed",
              isError: true,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "command_execution",
              toolUseId: "cmd-fail-2",
              input: { command: "pnpm another-missing-script" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "cmd-fail-2",
              content: "command: pnpm another-missing-script\nstatus: failed\nexit_code: 1\n\nSecond command failed",
              isError: true,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Collapse tool activity");
    expect(html).toContain("aria-expanded=\"true\"");
    expect(html).toContain("hover:bg-red-500/[0.05]");
    expect(html).toContain("bg-red-500/[0.08]");
    expect(html).toContain("-mx-2 rounded-lg bg-red-500/[0.04] px-2");
    expect(html).toContain("First command failed");
    expect(html).toContain("Second command failed");
  });

  it("keeps errored tool details collapsed by default in detail presentation", () => {
    const hiddenHeaderTime = new Date("2026-03-12T00:00:00.000Z").toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
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
    expect(html).not.toContain(`>${hiddenHeaderTime}<`);
    expect(html).not.toContain("Tool issue");
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
    expect(html).toContain("data-testid=\"command-terminal-copy-button\"");
    expect(html).toContain("aria-label=\"Copy command output\"");
    expect(html).toContain("group-hover/command-terminal:opacity-100");
    expect(html).toContain("ls -la /Users/zeeland/.vercel 2&gt;/dev/null || true");
    expect(html).toContain("ls: /Users/zeeland/.vercel: Permission denied");
    expect(html).not.toContain("Command activity");
    expect(html).not.toContain("command failed");
    expect(html).not.toContain("command completed");
    expect(html).not.toContain("command running");
    expect(html).not.toContain("response");
    expect(html).not.toContain(">Command<");
    expect(html).not.toContain(">Response<");
    expect(html).not.toContain("/bin/zsh -lc");
    expect(html).not.toContain("&quot;cwd&quot;");
    expect(html).not.toContain("exit_code");
    expect(html).not.toContain("status: failed");
  });

  it("keeps transcript progress chunks in chronological order", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          entries={[
            {
              kind: "system",
              ts: "2026-03-12T00:00:00.000Z",
              text: "turn started",
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:01.000Z",
              text: "I will inspect the directory first.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:02.000Z",
              name: "command_execution",
              toolUseId: "cmd-order-1",
              input: { command: "ls -la /tmp" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:03.000Z",
              toolUseId: "cmd-order-1",
              content: "command: ls -la /tmp\nstatus: completed\nexit_code: 0\n\ntotal 8",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:04.000Z",
              text: "The directory inspection is complete.",
            },
          ]}
        />
      </ThemeProvider>,
    );

    const introIndex = html.indexOf("I will inspect the directory first.");
    const commandIndex = html.indexOf("Explored /tmp");
    const finalIndex = html.indexOf("The directory inspection is complete.");

    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(introIndex);
    expect(finalIndex).toBeGreaterThan(commandIndex);
  });

  it("falls back to an implicit progress chunk for chat transcripts without turn markers", () => {
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

    expect(html).not.toContain("Model turn");
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

  it("summarizes SKILL.md file reads as skill use", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "read_file",
              toolUseId: "tool-1",
              input: { path: "/Users/zeeland/.codex/skills/flomo-local-api/SKILL.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "tool-1",
              content: "skill instructions",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Use flomo-local-api skill");
    expect(html).toContain('data-transcript-action-icon="skill"');
    expect(html).not.toContain("Read /Users/zeeland/.codex/skills/flomo-local-api/SKILL.md");
  });

  it("summarizes shell reads of SKILL.md as skill use", () => {
    const html = renderCommandSummary("sed -n '1,220p' /Users/zeeland/.codex/skills/flomo-local-api/SKILL.md");

    expect(html).toContain("Use flomo-local-api skill");
    expect(html).not.toContain("Read /Users/zeeland/.codex/skills/flomo-local-api/SKILL.md");
  });

  it("folds Claude Code skill context user injections into the skill tool card", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-05-25T09:56:02.245Z",
        name: "Skill",
        toolUseId: "tool-skill-1",
        input: {
          skill: "rudder-create-agent",
          args: "create COO agent",
        },
      },
      {
        kind: "tool_result",
        ts: "2026-05-25T09:56:02.254Z",
        toolUseId: "tool-skill-1",
        content: "Launching skill: rudder-create-agent",
        isError: false,
      },
      {
        kind: "user",
        ts: "2026-05-25T09:56:02.255Z",
        text: [
          "Base directory for this skill: /var/folders/example/T/rudder-skills/.claude/skills/rudder-create-agent",
          "",
          "# Rudder Create Agent Skill",
          "",
          "Use this skill when you are asked to hire or create an agent in Rudder.",
          "",
          "ARGUMENTS: create COO agent",
        ].join("\n"),
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool",
      name: "Skill",
      status: "completed",
      result: expect.stringContaining("Loaded skill context: rudder-create-agent"),
    });

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView density="compact" entries={entries} />
      </ThemeProvider>,
    );

    expect(html).toContain("Use rudder-create-agent skill");
    expect(html).not.toContain("User</span>");
    expect(html).not.toContain("Base directory for this skill");
  });

  it("labels Claude Code skill context clearly in raw transcript mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          mode="raw"
          density="compact"
          entries={[
            {
              kind: "user",
              ts: "2026-05-25T09:56:02.255Z",
              text: "Base directory for this skill: /tmp/rudder-skills/.claude/skills/rudder-create-agent\n\n# Rudder Create Agent Skill",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Skill Context");
    expect(html).not.toContain(">User<");
  });

  it("decodes shell-escaped search queries in chat activity summaries", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Searching skill analytics labels.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-1",
              input: {
                command:
                  'zsh -lc "rg \\"Skill Use Distribution|Skill Use Timeline|Skill Invocation Funnel\\" ui/src/fixtures/runTranscriptFixtures.ts ui/src/components/transcript/RunTranscriptView.tsx tests/e2e/run-transcript-detail.spec.ts"',
              },
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

    expect(html).toContain(
      "Searched &quot;Skill Use Distribution|Skill Use Timeline|Skill…&quot; in 3 locations",
    );
    expect(html).not.toContain("\\&quot;Skill");
  });

  it("renders web search keywords in transcript tool summaries", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "web_search",
              toolUseId: "web-1",
              input: {
                action: { type: "search", query: "codex transcript web search keywords" },
              },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "web-1",
              content: "2 results",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Web searched &quot;codex transcript web search keywords&quot;");
  });

  it("renders MCP server, tool, and argument details in transcript summaries", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "mcp__github__fetch_pr",
              toolUseId: "mcp-1",
              input: {
                repo_full_name: "openai/codex",
                pr_number: 123,
              },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "mcp-1",
              content: "PR title: transcript UI",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Called fetch_pr via github");
    expect(html).toContain("repo_full_name openai/codex");
    expect(html).toContain("pr_number 123");
  });

  it("renders Codex spawn agent tool payloads as readable transcript summaries", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "spawn_agent",
              toolUseId: "agent-1",
              input: {
                agent_type: "explorer",
                message: "Inspect the transcript renderer for Codex tool rows.",
                model: "gpt-5.3-codex",
                reasoning_effort: "high",
                fork_context: true,
              },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "agent-1",
              content: JSON.stringify({ id: "agent_123", nickname: "Explorer" }),
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Spawned explorer agent: Inspect the transcript renderer for Codex tool rows.");
    expect(html).toContain("gpt-5.3-codex");
    expect(html).toContain("high reasoning");
    expect(html).toContain("forked context");
    expect(html).not.toContain("spawn_agent");
  });

  it("uses semantic action icons for representative transcript categories", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Reading the design doc.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "read_file",
              toolUseId: "read-1",
              input: { path: "doc/DESIGN.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "read-1",
              content: "design",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:03.000Z",
              text: "Searching transcript code.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:04.000Z",
              name: "command_execution",
              toolUseId: "search-1",
              input: { command: "rg transcript ui/src/components/transcript" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:05.000Z",
              toolUseId: "search-1",
              content: "match",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:06.000Z",
              text: "Editing the renderer.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:07.000Z",
              name: "command_execution",
              toolUseId: "edit-1",
              input: { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: ui/src/components/transcript/RunTranscriptView.tsx\n*** End Patch\nPATCH" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:08.000Z",
              toolUseId: "edit-1",
              content: "patch applied",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:09.000Z",
              text: "Inspecting repository state.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:10.000Z",
              name: "command_execution",
              toolUseId: "inspect-1",
              input: { command: "git status --short" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:11.000Z",
              toolUseId: "inspect-1",
              content: "M ui/src/components/transcript/RunTranscriptView.tsx",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:12.000Z",
              text: "Checking current docs online.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:13.000Z",
              name: "web_search",
              toolUseId: "web-1",
              input: { query: "transcript icon semantics" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:14.000Z",
              toolUseId: "web-1",
              content: "results",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:15.000Z",
              text: "Fetching GitHub context.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:16.000Z",
              name: "mcp__github__fetch_issue",
              toolUseId: "mcp-1",
              input: { repo_full_name: "rudder/rudder", issue_number: 126 },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:17.000Z",
              toolUseId: "mcp-1",
              content: "issue",
              isError: false,
            },
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:18.000Z",
              text: "Reviewing output.",
            },
            {
              kind: "stdout",
              ts: "2026-03-12T00:00:19.000Z",
              text: "standalone output",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain('data-transcript-action-icon="read"');
    expect(html).toContain('data-transcript-action-icon="search"');
    expect(html).toContain('data-transcript-action-icon="edit"');
    expect(html).toContain('data-transcript-action-icon="inspect"');
    expect(html).toContain('data-transcript-action-icon="web_search"');
    expect(html).toContain('data-transcript-action-icon="mcp"');
    expect(html).toContain('data-transcript-action-icon="stdout"');
    expect(countOccurrences(html, 'data-transcript-action-icon="command"')).toBe(0);
  });

  it("shows mixed grouped activity with category-specific icons", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:01.000Z",
              name: "command_execution",
              toolUseId: "cmd-read-1",
              input: { command: "sed -n '1,120p' README.md" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:02.000Z",
              toolUseId: "cmd-read-1",
              content: "read",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "command_execution",
              toolUseId: "cmd-search-1",
              input: { command: "rg transcript ui/src" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:04.000Z",
              toolUseId: "cmd-search-1",
              content: "match",
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:05.000Z",
              name: "command_execution",
              toolUseId: "cmd-edit-1",
              input: { command: "tee notes.txt > /dev/null" },
            },
            {
              kind: "tool_result",
              ts: "2026-03-12T00:00:06.000Z",
              toolUseId: "cmd-edit-1",
              content: "wrote notes",
              isError: false,
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Explored 1 file, 1 search, edited 1 file");
    expect(html).toContain('data-transcript-action-icon="read"');
    expect(html).toContain('data-transcript-action-icon="search"');
    expect(html).toContain('data-transcript-action-icon="edit"');
  });

  it("groups detail transcripts so repeated reads stay collapsed behind one summary", () => {
    const hiddenHeaderTime = new Date("2026-03-12T00:00:02.000Z").toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
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

    expect(html).not.toContain("Model turn");
    expect(html).not.toContain(`>${hiddenHeaderTime}<`);
    expect(html).toContain("Reviewing the bundled skills before deciding what to change.");
    expect(html).toContain("Used 2 skills");
    expect(html).not.toContain("para-memory-files/SKILL.md");
    expect(html).not.toContain("rudder-create-agent/SKILL.md");
  });

  it("does not keep a detail progress chunk running after a terminal run with missing tool results", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          presentation="detail"
          streaming={false}
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
              text: "I checked the repository and completed the work.",
            },
            {
              kind: "tool_call",
              ts: "2026-03-12T00:00:03.000Z",
              name: "command_execution",
              toolUseId: "cmd-open-1",
              input: { command: "rg AGENTS.md" },
            },
            {
              kind: "stdout",
              ts: "2026-03-12T00:00:04.000Z",
              text: "AGENTS.md",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).not.toContain("Model turn");
    expect(html).toContain("I checked the repository and completed the work.");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("animate-spin");
  });
});
