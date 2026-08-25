import { parseClaudeStdoutLine } from "@rudderhq/agent-runtime-claude-local/ui";
import { parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import { parseCursorStdoutLine } from "@rudderhq/agent-runtime-cursor-local/ui";
import { parseGeminiStdoutLine } from "@rudderhq/agent-runtime-gemini-local/ui";
import { parseOpenCodeStdoutLine } from "@rudderhq/agent-runtime-opencode-local/ui";
import { parsePiStdoutLine } from "@rudderhq/agent-runtime-pi-local/ui";
import { describe, expect, it } from "vitest";
import { filterRenderableTranscriptEntries } from "../components/transcript/RunTranscriptView.common";
import { buildTranscript, type RunLogChunk } from "./transcript";

describe("buildTranscript", () => {
  const ts = "2026-03-20T13:00:00.000Z";
  const chunks: RunLogChunk[] = [
    { ts, stream: "stdout", chunk: "opened /Users/dotta/project\n" },
    { ts, stream: "stderr", chunk: "stderr /Users/dotta/project" },
  ];

  it("defaults username censoring to off when options are omitted", () => {
    const entries = buildTranscript(chunks, (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }]);

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "opened /Users/dotta/project" },
      { kind: "stderr", ts, text: "stderr /Users/dotta/project" },
    ]);
  });

  it("still redacts usernames when explicitly enabled", () => {
    const entries = buildTranscript(chunks, (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }], {
      censorUsernameInLogs: true,
    });

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "opened /Users/d****/project" },
      { kind: "stderr", ts, text: "stderr /Users/d****/project" },
    ]);
  });

  it("drops Claude redacted-thinking envelopes instead of exposing raw provider JSON", () => {
    const rawEnvelope = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [
          {
            type: "redacted_thinking",
            data: "ccswitch-openai-reasoning-v1:opaque-private-payload",
          },
        ],
      },
      session_id: "session-private",
      uuid: "event-private",
    });

    expect(parseClaudeStdoutLine(rawEnvelope, ts)).toEqual([]);
  });

  it("hides persisted raw provider envelopes from normal transcript rendering", () => {
    const rawEnvelope = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "redacted_thinking",
            data: "ccswitch-openai-reasoning-v1:opaque-private-payload",
          },
        ],
      },
      session_id: "session-private",
      uuid: "event-private",
    });
    const entries = [{ kind: "stdout" as const, ts, text: rawEnvelope }];

    expect(filterRenderableTranscriptEntries(entries)).toEqual([]);
    expect(filterRenderableTranscriptEntries(entries, { showDeveloperDiagnostics: true })).toEqual(entries);
  });

  it("keeps ordinary JSON stdout that only resembles a provider envelope", () => {
    const entries = [
      {
        kind: "stdout" as const,
        ts,
        text: JSON.stringify({
          type: "user",
          message: { role: "success", content: "job finished" },
        }),
      },
      {
        kind: "stdout" as const,
        ts,
        text: JSON.stringify({
          type: "system",
          subtype: "status",
          timestamp: "2026-07-21",
          payload: { ok: true },
        }),
      },
    ];

    expect(filterRenderableTranscriptEntries(entries)).toEqual(entries);
  });

  it("hides pretty-printed persisted provider envelopes", () => {
    const rawEnvelope = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "PRIVATE" }],
      },
      session_id: "session-private",
      uuid: "event-private",
    }, null, 2);
    const entries = [{ kind: "stdout" as const, ts, text: rawEnvelope }];

    expect(filterRenderableTranscriptEntries(entries)).toEqual([]);
  });

  it("builds structured transcript entries for Codex todo list started and completed events", () => {
    const entries = buildTranscript([
      {
        ts,
        stream: "stdout",
        chunk: `${JSON.stringify({
          type: "item.started",
          item: {
            id: "item_3",
            type: "todo_list",
            items: [
              { text: "Checkout assigned issue", completed: false },
            ],
          },
        })}\n${JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_3",
            type: "todo_list",
            items: [
              { text: "Checkout assigned issue", completed: true },
              { text: "Inspect agent patterns", completed: false },
              { text: "Patch transcript UI", status: "in_progress" },
            ],
          },
        })}\n`,
      },
    ], parseCodexStdoutLine);

    expect(entries).toEqual([
      {
        kind: "todo_list",
        ts,
        todoListId: "item_3",
        items: [
          { text: "Checkout assigned issue", status: "pending" },
        ],
      },
      {
        kind: "todo_list",
        ts,
        todoListId: "item_3",
        items: [
          { text: "Checkout assigned issue", status: "completed" },
          { text: "Inspect agent patterns", status: "pending" },
          { text: "Patch transcript UI", status: "in_progress" },
        ],
      },
    ]);
  });

  it("keeps parsing Codex todo list updated events", () => {
    const entries = buildTranscript([
      {
        ts,
        stream: "stdout",
        chunk: `${JSON.stringify({
          type: "item.updated",
          item: {
            id: "item_3",
            type: "todo_list",
            items: [
              { text: "Checkout assigned issue", completed: true },
              { text: "Patch transcript UI", status: "in_progress" },
            ],
          },
        })}\n`,
      },
    ], parseCodexStdoutLine);

    expect(entries).toEqual([
      {
        kind: "todo_list",
        ts,
        todoListId: "item_3",
        items: [
          { text: "Checkout assigned issue", status: "completed" },
          { text: "Patch transcript UI", status: "in_progress" },
        ],
      },
    ]);
  });

  it("builds structured transcript entries for Codex web search events", () => {
    const entries = buildTranscript([
      {
        ts,
        stream: "stdout",
        chunk: `${JSON.stringify({
          type: "item.started",
          item: {
            id: "ws_1",
            type: "web_search",
            action: { type: "search", query: "codex transcript web search keywords" },
          },
        })}\n${JSON.stringify({
          type: "item.completed",
          item: {
            id: "ws_1",
            type: "web_search",
            action: { type: "search", query: "codex transcript web search keywords" },
            output: "2 results",
          },
        })}\n`,
      },
    ], parseCodexStdoutLine);

    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "web_search",
        toolUseId: "ws_1",
        input: {
          id: "ws_1",
          action: { type: "search", query: "codex transcript web search keywords" },
        },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "ws_1",
        toolName: "web_search",
        content: "2 results",
        isError: false,
      },
    ]);
  });

  it("builds structured transcript entries for Codex MCP tool call events", () => {
    const entries = buildTranscript([
      {
        ts,
        stream: "stdout",
        chunk: `${JSON.stringify({
          type: "item.started",
          item: {
            id: "mcp_1",
            type: "mcp_tool_call",
            invocation: {
              server: "github",
              tool: "fetch_pr",
              arguments: { repo_full_name: "openai/codex", pr_number: 123 },
            },
          },
        })}\n${JSON.stringify({
          type: "item.completed",
          item: {
            id: "mcp_1",
            type: "mcp_tool_call",
            invocation: {
              server: "github",
              tool: "fetch_pr",
              arguments: { repo_full_name: "openai/codex", pr_number: 123 },
            },
            result: "PR title: transcript UI",
          },
        })}\n`,
      },
    ], parseCodexStdoutLine);

    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "mcp__github__fetch_pr",
        toolUseId: "mcp_1",
        input: {
          id: "mcp_1",
          server: "github",
          tool: "fetch_pr",
          invocation: {
            server: "github",
            tool: "fetch_pr",
            arguments: { repo_full_name: "openai/codex", pr_number: 123 },
          },
          args: { repo_full_name: "openai/codex", pr_number: 123 },
        },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "mcp_1",
        toolName: "mcp__github__fetch_pr",
        content: "PR title: transcript UI",
        isError: false,
      },
    ]);
  });

  it("keeps runtime-loaded instruction user messages out of the shared operator transcript contract", () => {
    const instructionText = "<rudder_agent_instruction>\n<rudder_agent_operating_contract>\nYour home directory is $AGENT_HOME.\n\nUse these paths consistently:\n</rudder_agent_operating_contract>\n</rudder_agent_instruction>";
    const cases = [
      {
        name: "claude",
        parser: parseClaudeStdoutLine,
        line: JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: instructionText }] },
        }),
      },
      {
        name: "cursor",
        parser: parseCursorStdoutLine,
        line: JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: instructionText }] },
        }),
      },
      {
        name: "gemini",
        parser: parseGeminiStdoutLine,
        line: JSON.stringify({
          type: "message",
          role: "user",
          content: instructionText,
        }),
      },
    ];

    for (const item of cases) {
      const parsed = item.parser(item.line, ts);
      expect(parsed, item.name).toEqual([
        { kind: "user", ts, text: instructionText },
      ]);
      expect(filterRenderableTranscriptEntries(parsed), item.name).toEqual([]);
    }
  });

  it("keeps provider tool responses renderable even when a provider reports them inside user-role events", () => {
    const claudeEntries = parseClaudeStdoutLine(JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "tool response body",
            is_error: false,
          },
        ],
      },
    }), ts);
    expect(filterRenderableTranscriptEntries(claudeEntries)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool-1",
        content: "tool response body",
        isError: false,
      },
    ]);

    expect(parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "tool_result",
        content: "codex tool response",
      },
    }), ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool-1",
        content: "codex tool response",
        isError: false,
      },
    ]);

    expect(parseOpenCodeStdoutLine(JSON.stringify({
      type: "tool_use",
      part: {
        callID: "tool-1",
        tool: "read",
        state: {
          status: "completed",
          input: { path: "README.md" },
          output: "opencode tool response",
        },
      },
    }), ts)).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "read",
        toolUseId: "tool-1",
        input: { path: "README.md" },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool-1",
        content: "status: completed\n\nopencode tool response",
        isError: false,
      },
    ]);

    expect(parsePiStdoutLine(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: [{ type: "text", text: "pi tool response" }],
      isError: false,
    }), ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool-1",
        toolName: "read",
        content: "pi tool response",
        isError: false,
      },
    ]);
  });
});
