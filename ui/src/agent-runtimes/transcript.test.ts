import { describe, expect, it } from "vitest";
import { parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
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
});
