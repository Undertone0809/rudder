// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";

const ts = "2026-09-29T01:33:22Z";
const input: TranscriptEntry = {
  kind: "user", ts,
  text: 'Conversation input:\n{"currentMessage":{"body":"what skills do you have?"}}\nFinal Rudder result reminder: internal instructions',
};

describe("native transcript presentation", () => {
  it("does not display Rudder structured input envelopes in Run Detail Raw mode", () => {
    const inlineEnvelope: TranscriptEntry = {
      ...input,
      text: 'Conversation input: {"currentMessage":{"role":"user","body":"another echoed prompt"}}',
    };
    const conversationMessage: TranscriptEntry = {
      kind: "user",
      ts,
      text: "Please inspect the settings file.",
    };
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" mode="raw" entries={[input, inlineEnvelope, conversationMessage]}
    /></ThemeProvider>);
    const hiddenNiceViewIndex = html.indexOf(' hidden="" aria-hidden="true"');
    expect(hiddenNiceViewIndex).toBeGreaterThan(0);
    const activeRawView = html.slice(0, hiddenNiceViewIndex);
    expect(activeRawView).not.toContain("Conversation input:");
    expect(activeRawView).not.toContain("currentMessage");
    expect(activeRawView).not.toContain("what skills do you have?");
    expect(activeRawView).not.toContain("another echoed prompt");
    expect(activeRawView).toContain("Please inspect the settings file.");
  });

  it("preserves actual user messages in nice Run Detail", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={[
        { kind: "user", ts, text: "Please inspect the settings file." },
        { kind: "assistant", ts, text: "I will inspect it now." },
      ]}
    /></ThemeProvider>);

    expect(html).toContain("Please inspect the settings file.");
    expect(html).toContain("I will inspect it now.");
  });

  it("hides Rudder structured inputs in nice Run Detail without hiding real user messages", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={[
        input,
        { kind: "user", ts, text: "Please inspect the settings file." },
        { kind: "assistant", ts, text: "I will inspect it now." },
      ]}
    /></ThemeProvider>);

    expect(html).not.toContain("Conversation input:");
    expect(html).not.toContain("currentMessage");
    expect(html).not.toContain("Final Rudder result reminder");
    expect(html).toContain("Please inspect the settings file.");
    expect(html).toContain("I will inspect it now.");
  });

  it("shows only agent activity in a mixed Chat process transcript", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="chat"
      entries={[
        input,
        { kind: "user", ts, text: "what skills do you have?" },
        { kind: "assistant", ts, text: "Checking available skills.", phase: "commentary" },
        { kind: "tool_call", ts, name: "command_execution", toolUseId: "cmd-1", input: { command: "echo process evidence", cwd: "/tmp" } },
        { kind: "tool_result", ts, toolUseId: "cmd-1", toolName: "command_execution", content: "TRANSCRIPT_TOOL_OUTPUT_E2E", isError: false },
        { kind: "assistant", ts, text: "Available skills: browser.", phase: "final_answer" },
      ]}
      hiddenAssistantMessageText="Available skills: browser."
    /></ThemeProvider>);

    expect(html).not.toContain("Conversation input:");
    expect(html).not.toContain("what skills do you have?");
    expect(html).not.toContain("currentMessage");
    expect(html).not.toContain("Available skills: browser.");
    expect(html).toContain("Checking available skills.");
    expect(html).toContain("Ran echo process evidence");
    expect(html).toContain("Expand command details");
  });

  it("leaves an empty Chat process empty when the runtime only echoes user inputs", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="chat" entries={[
        input,
        { kind: "user", ts, text: "what skills do you have?" },
        { kind: "user", source: "steer", ts, text: "Keep going with the same task." },
        { kind: "system", ts, text: "reasoning completed" },
        { kind: "assistant", ts, text: "Available skills: browser.", phase: "final_answer" },
      ]} hideAssistantMessages
    /></ThemeProvider>);
    expect(html).toBe("");
  });

  it("does not render a Claude skill-context-only user entry in the Chat process", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="chat" entries={[{
        kind: "user",
        ts,
        text: [
          "Base directory for this skill: /tmp/claude/skills/rudder-create-agent",
          "",
          "# Rudder Create Agent Skill",
          "User-derived skill instructions must stay hidden.",
        ].join("\n"),
      }]}
    /></ThemeProvider>);

    expect(html).toBe("");
  });

  it("keeps commentary and the final answer distinct and labels the final in Run Detail", () => {
    const entries: TranscriptEntry[] = [input,
      { kind: "assistant", ts, text: "Checking installed skills.", phase: "commentary" },
      { kind: "assistant", ts, text: "Available skills: browser.", phase: "final_answer" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: "message", phase: "final_answer" });
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={entries}
    /></ThemeProvider>);
    expect(html).not.toContain("currentMessage");
    expect(html).not.toContain("Final Rudder result reminder");
    expect(html).toContain("Final response");
    expect(html).toContain("Checking installed skills.");
    expect(html).toContain("Available skills: browser.");
  });

  it("retains tool and visible reasoning activity while omitting ordinary user input", () => {
    const blocks = normalizeTranscript([
      { kind: "user", ts, text: "Find the config" },
      { kind: "thinking", ts, text: "Inspect the project configuration." },
      { kind: "tool_call", ts, name: "read_file", toolUseId: "read-1", input: { path: "/tmp/config.json" } },
      { kind: "tool_result", ts, toolUseId: "read-1", content: "{}", isError: false },
    ], false, { hideUserMessages: true });
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "tool"]);
  });

  it("omits Steer user input when normalizing Agent Process activity", () => {
    const blocks = normalizeTranscript([
      { kind: "user", source: "steer", ts, text: "Change direction." },
      { kind: "assistant", ts, text: "I will continue with the new direction." },
    ], false, { hideUserMessages: true });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "I will continue with the new direction.",
      }),
    ]);
  });
});
