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
  it("leaves an empty Chat process empty when the runtime only echoes user input", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="chat" entries={[input, { kind: "user", ts, text: "what skills do you have?" }]}
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
});
