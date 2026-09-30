// @vitest-environment node
import type { ChatMessage } from "@rudderhq/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { chatProcessTranscriptEntries } from "../../pages/Chat.timeline";
import {
  isNativeSteerTranscriptEntry,
  mergeNativeSteerTranscriptEntries,
  type NativeSteerTranscriptEntry,
} from "../../lib/chat-stream-state";
import { StreamTranscriptItem } from "../../pages/Chat.StreamTranscriptItem";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";

const ts = "2026-09-30T00:00:00.000Z";
const steerBody = [
  "# Browser Skill",
  "Base directory for this skill: /tmp/skills/browser",
  "ARGUMENTS: Keep this direction visible as Steer input.",
].join("\n");

function steerMessage(deliveryDisposition = "accepted_current", afterTranscriptEntryCount = 2): ChatMessage {
  return {
    id: "steer-visible-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "user",
    kind: "message",
    status: "completed",
    body: steerBody,
    structuredPayload: {
      source: "steer",
      targetGenerationId: "generation-1",
      afterTranscriptEntryCount,
      generationSeq: 4,
      controlActionId: "steer-control-1",
      deliveryDisposition,
    },
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: null,
    chatTurnId: "turn-1",
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date(ts),
    updatedAt: new Date(ts),
  };
}

describe("native Steer Process visibility", () => {
  it("shows one anchored Steer event in transcript order without exposing user echoes", () => {
    const runtimeEntries: TranscriptEntry[] = [
      { kind: "thinking", ts, text: "Reasoning before the control point." },
      { kind: "tool_call", ts, name: "read_file", toolUseId: "read-1", input: { path: "/tmp/config.json" } },
      { kind: "user", ts, text: 'Conversation input: {"currentMessage":{"body":"PRIVATE_STRUCTURED_ECHO"}}' },
      { kind: "user", ts, text: "PRIVATE_USER_ECHO" },
      { kind: "thinking", ts, text: "Reasoning after the control point." },
      { kind: "assistant", ts, text: "Final response stays in its own message.", phase: "final_answer" },
    ];
    const merged = mergeNativeSteerTranscriptEntries(runtimeEntries, [steerMessage()]);
    const validSteer = merged.find(isNativeSteerTranscriptEntry);
    if (!validSteer) throw new Error("Expected an anchored Steer transcript entry");

    const malformedSteer: TranscriptEntry = {
      ...validSteer,
      steerMessage: steerMessage("continuation_pending"),
    } as NativeSteerTranscriptEntry;
    const unanchoredSteer: TranscriptEntry = {
      kind: "user",
      source: "steer",
      messageId: "steer-unanchored",
      controlActionId: "steer-control-unanchored",
      ts,
      text: "UNANCHORED_STEER_ECHO",
    };
    const candidates = [...merged, unanchoredSteer, malformedSteer];
    const processEntries = chatProcessTranscriptEntries(candidates);

    expect(processEntries.map((entry) => entry.kind)).toEqual([
      "thinking",
      "tool_call",
      "user",
      "thinking",
    ]);
    expect(processEntries.filter(isNativeSteerTranscriptEntry)).toHaveLength(1);

    const blocks = normalizeTranscript(processEntries, false, { hideUserMessages: true });
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "tool", "message", "thinking"]);
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "message",
      role: "user",
      source: "steer",
      messageId: "steer-visible-1",
      text: steerBody,
    }));
    expect(blocks.some((block) => block.type === "event" && block.label === "skill context")).toBe(false);

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView density="compact" presentation="chat" entries={processEntries} />
      </ThemeProvider>,
    );
    expect(html.match(/data-testid="chat-transcript-steer-message"/g)).toHaveLength(1);
    expect(html.indexOf("Reasoning before the control point.")).toBeLessThan(html.indexOf("Keep this direction visible as Steer input."));
    expect(html.indexOf("Keep this direction visible as Steer input.")).toBeLessThan(html.indexOf("Reasoning after the control point."));
    expect(html).not.toContain("PRIVATE_STRUCTURED_ECHO");
    expect(html).not.toContain("PRIVATE_USER_ECHO");
    expect(html).not.toContain("UNANCHORED_STEER_ECHO");
    expect(html).not.toContain("Final response stays in its own message.");
  });

  it("keeps the normalizer closed to unanchored and invalid-disposition Steer entries", () => {
    const validEntries = mergeNativeSteerTranscriptEntries([], [steerMessage()]);
    const validSteer = validEntries[0];
    if (!validSteer || !isNativeSteerTranscriptEntry(validSteer)) {
      throw new Error("Expected an anchored Steer transcript entry");
    }
    const blocks = normalizeTranscript([
      validSteer,
      {
        kind: "user",
        source: "steer",
        messageId: "steer-unanchored",
        ts,
        text: "UNANCHORED_STEER_ECHO",
      },
      {
        ...validSteer,
        steerMessage: steerMessage("continuation_pending"),
      } as TranscriptEntry,
    ], false, { hideUserMessages: true });

    expect(blocks.filter((block) => block.type === "message" && block.source === "steer")).toHaveLength(1);
    expect(blocks.some((block) => block.type === "message" && block.text.includes("UNANCHORED_STEER_ECHO"))).toBe(false);
  });

  it("retains reasoning on both sides of the anchored Steer entry in the streaming row", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <StreamTranscriptItem
          entries={[
            { kind: "thinking", ts, text: "Reasoning before Steer" },
            { kind: "thinking", ts, text: "Reasoning after Steer" },
          ]}
          steerMessages={[steerMessage("accepted_current", 1)]}
          state="streaming"
          streamStartedAt={new Date(ts)}
          assistantMessageBody="In-progress answer before Steer"
        />
      </ThemeProvider>,
    );

    expect(html.indexOf("Reasoning before Steer")).toBeLessThan(html.indexOf("Keep this direction visible as Steer input."));
    expect(html.indexOf("Keep this direction visible as Steer input.")).toBeLessThan(html.indexOf("Reasoning after Steer"));
  });
});
