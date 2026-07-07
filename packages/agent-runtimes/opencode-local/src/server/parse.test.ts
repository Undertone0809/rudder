import { describe, expect, it } from "vitest";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl, parseOpenCodeJsonlLine } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
  });

  it("filters synthetic compaction text and detects terminal stop", () => {
    const synthetic = JSON.stringify({
      type: "text",
      sessionID: "session_123",
      part: {
        type: "text",
        metadata: { compaction_continue: true },
        synthetic: true,
        text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      },
    });
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { type: "text", text: "final answer" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "stop",
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
      synthetic,
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("final answer");
    expect(parsed.terminalStop).toBe(true);
    expect(parseOpenCodeJsonlLine(synthetic)?.type).toBe("syntheticText");
  });

  it("filters OpenCode compaction summary text without explicit synthetic metadata", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: {
          type: "text",
          text: [
            "## Goal",
            "- Keep going.",
            "",
            "## Progress",
            "### Done",
            "- Read prompt.",
            "",
            "## Critical Context",
            "- Internal state.",
            "",
            "## Relevant Files",
            "- /tmp/prompt.md",
          ].join("\n"),
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { type: "text", text: "{\"path\":\"mcp\",\"tools\":[\"rudder_agent_me\"],\"note\":\"ok\"}" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("{\"path\":\"mcp\",\"tools\":[\"rudder_agent_me\"],\"note\":\"ok\"}");
  });

  it("ignores provider-emitted XML tool call text as assistant final text", () => {
    const toolCallText = [
      "<tool_call>",
      "<function=read>",
      "<parameter=filePath>/tmp/rudder-prompt.md</parameter>",
      "</function>",
      "</tool_call>",
    ].join("\n");
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { type: "text", text: toolCallText },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { type: "text", text: "final answer" },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonlLine(JSON.stringify({
      type: "text",
      part: { type: "text", text: toolCallText },
    }))?.type).toBe("other");
    expect(parseOpenCodeJsonl(stdout).summary).toBe("final answer");
  });

  it("filters OpenCode continuation summaries that include constraints and next steps", () => {
    const summary = [
      "## Goal",
      "- Validate Rudder runtime tools by calling `rudder_agent_me`.",
      "",
      "## Constraints & Preferences",
      "- Do not use shell, Bash, curl, or rudder CLI.",
      "",
      "## Progress",
      "### Done",
      "- Read the full Rudder runtime prompt file.",
      "",
      "### In Progress",
      "- Preparing to call `rudder_agent_me`.",
      "",
      "### Blocked",
      "- (none)",
      "",
      "## Key Decisions",
      "- (none)",
      "",
      "## Next Steps",
      "1. Call `rudder_agent_me`.",
      "",
      "## Critical Context",
      "- Prompt file loaded at instruction load time.",
      "",
      "## Relevant Files",
      "- /tmp/rudder-prompt.md",
    ].join("\n");
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { type: "text", text: summary },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { type: "text", text: "```json\n{\"path\":\"mcp\",\"tools\":[\"rudder_agent_me\"],\"note\":\"ok\"}\n```" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parseOpenCodeJsonlLine(JSON.stringify({
      type: "text",
      part: { type: "text", text: summary },
    }))?.type).toBe("syntheticText");
    expect(parsed.summary).toBe("```json\n{\"path\":\"mcp\",\"tools\":[\"rudder_agent_me\"],\"note\":\"ok\"}\n```");
  });

  it("keeps completed OpenCode continuation summaries as fallback completion evidence", () => {
    const summary = [
      "## Goal",
      "- Validate Rudder runtime tools by calling `rudder_agent_me`.",
      "",
      "## Constraints & Preferences",
      "- Do not use shell, Bash, curl, or rudder CLI.",
      "",
      "## Progress",
      "### Done",
      "- Called `rudder_agent_me` tool successfully.",
      "",
      "### In Progress",
      "- (none)",
      "",
      "### Blocked",
      "- (none)",
      "",
      "## Key Decisions",
      "- (none)",
      "",
      "## Next Steps",
      "- Task complete - runtime validation successful.",
      "",
      "## Critical Context",
      "- 69 Rudder tools available via `rudder-control-plane`.",
      "",
      "## Relevant Files",
      "- /tmp/rudder-prompt.md",
    ].join("\n");

    const parsedLine = parseOpenCodeJsonlLine(JSON.stringify({
      type: "text",
      part: { type: "text", text: summary },
    }));
    const parsed = parseOpenCodeJsonl(JSON.stringify({
      type: "text",
      sessionID: "session_123",
      part: { type: "text", text: summary },
    }));

    expect(parsedLine).toMatchObject({ type: "syntheticText", completion: true });
    expect(parsed.summary).toBe("");
    expect(parsed.completionSummary).toContain("Task complete");
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});
