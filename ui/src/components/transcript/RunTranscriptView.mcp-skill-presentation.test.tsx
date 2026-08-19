// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";
import { TranscriptChatToolActionRow } from "./RunTranscriptView.chat";
import {
  formatNiceToolRequest,
  formatNiceToolRequestParameters,
  formatNiceToolResponse,
  getNiceToolRequestLabel,
} from "./RunTranscriptView.presentation";

const mcpInput = {
  id: "exec-1",
  args: {
    url: "https://api.github.com/repos/astral-sh/ruff",
    tabId: "tab-1",
  },
  tool: "rudder_browser_navigate",
  server: "rudder-tools",
  invocation: {
    id: "exec-1",
    status: "inProgress",
  },
};

const mcpResponse = JSON.stringify({
  content: [{
    type: "text",
    text: JSON.stringify({
      tabId: "tab-1",
      url: "https://api.github.com/repos/astral-sh/ruff",
    }),
  }],
  structuredContent: {
    tabId: "tab-1",
    url: "https://api.github.com/repos/astral-sh/ruff",
    title: "api.github.com/repos/astral-sh/ruff",
  },
  _meta: null,
});

describe("Nice transcript MCP payloads", () => {
  it("puts MCP search queries in the summary and renders a readable Query detail", () => {
    const name = "mcp__github__github_search_code";
    const input = {
      query: "transcript renderer",
      path: "ui/src/components/transcript",
    };
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <TranscriptChatToolActionRow
          inline
          density="compact"
          block={{
            ts: "2026-07-24T00:00:00.000Z",
            endTs: "2026-07-24T00:00:01.000Z",
            name,
            input,
            result: "2 matches",
            status: "completed",
          }}
        />
      </ThemeProvider>,
    );

    expect(formatNiceToolRequest(name, input)).toBe('"transcript renderer"');
    expect(formatNiceToolRequestParameters(name, input)).toBe(JSON.stringify({
      path: "ui/src/components/transcript",
    }, null, 2));
    expect(getNiceToolRequestLabel(name, input)).toBe("Query");
    expect(html).toContain('Search code for &quot;transcript renderer&quot;');
    expect(html).toContain("Query");
    expect(html).toContain("Parameters");
    expect(html).not.toContain("Input");
    expect(html).not.toContain("&quot;query&quot;:");
    expect(html).toContain("&quot;path&quot;:");
  });

  it("projects only args for MCP input and structuredContent for MCP response", () => {
    expect(formatNiceToolRequest("mcp__rudder-tools__rudder_browser_navigate", mcpInput))
      .toBe(JSON.stringify(mcpInput.args, null, 2));
    expect(formatNiceToolResponse(
      "mcp__rudder-tools__rudder_browser_navigate",
      mcpInput,
      mcpResponse,
    )).toBe(JSON.stringify({
      tabId: "tab-1",
      url: "https://api.github.com/repos/astral-sh/ruff",
      title: "api.github.com/repos/astral-sh/ruff",
    }, null, 2));
  });

  it("renders the reduced MCP projection in expanded chat details", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <TranscriptChatToolActionRow
          inline
          density="compact"
          block={{
            ts: "2026-07-24T00:00:00.000Z",
            endTs: "2026-07-24T00:00:01.000Z",
            name: "mcp__rudder-tools__rudder_browser_navigate",
            input: mcpInput,
            result: mcpResponse,
            status: "completed",
          }}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Input");
    expect(html).toContain("Response");
    expect(html).toContain("&quot;url&quot;:");
    expect(html).toContain("&quot;title&quot;:");
    expect(html).not.toContain("&quot;args&quot;:");
    expect(html).not.toContain("&quot;invocation&quot;:");
    expect(html).not.toContain("&quot;structuredContent&quot;:");
    expect(html).not.toContain("&quot;content&quot;:");
    expect(html).not.toContain("&quot;_meta&quot;:");
  });

  it("keeps the complete MCP envelope in Raw mode", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-07-24T00:00:00.000Z",
        name: "mcp__rudder-tools__rudder_browser_navigate",
        toolUseId: "mcp-1",
        input: mcpInput,
      },
      {
        kind: "tool_result",
        ts: "2026-07-24T00:00:01.000Z",
        toolUseId: "mcp-1",
        content: mcpResponse,
        isError: false,
      },
    ];
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView mode="raw" entries={entries} />
      </ThemeProvider>,
    );

    expect(html).toContain("&quot;args&quot;:");
    expect(html).toContain("&quot;invocation&quot;:");
    expect(html).toContain("&quot;structuredContent&quot;:");
    expect(html).toContain("&quot;content&quot;:");
  });
});

describe("Nice transcript skill activity", () => {
  const skillEntries: TranscriptEntry[] = [
    {
      kind: "tool_call",
      ts: "2026-07-24T00:00:00.000Z",
      name: "command_execution",
      toolUseId: "skill-1",
      input: {
        command: "sed -n '1,240p' /workspace/.agents/skills/systematic-debugging/SKILL.md",
        cwd: "/workspace",
      },
    },
    {
      kind: "tool_result",
      ts: "2026-07-24T00:00:01.000Z",
      toolUseId: "skill-1",
      content: "# Systematic Debugging",
      isError: false,
    },
  ];

  it.each(["chat", "detail"] as const)(
    "does not offer raw-command disclosure for skill use in %s presentation",
    (presentation) => {
      const html = renderToStaticMarkup(
        <ThemeProvider>
          <RunTranscriptView
            density="compact"
            presentation={presentation}
            entries={skillEntries}
          />
        </ThemeProvider>,
      );

      expect(html).toContain("Use ");
      expect(html).toContain("systematic-debugging");
      expect(html).not.toContain("Expand command details");
      expect(html).not.toContain("data-transcript-action-row-disclosure");
      expect(html).not.toContain("sed -n");
    },
  );

  it("keeps the original skill command available in Raw mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView mode="raw" entries={skillEntries} />
      </ThemeProvider>,
    );

    expect(html).toContain("sed -n");
    expect(html).toContain("SKILL.md");
  });
});
