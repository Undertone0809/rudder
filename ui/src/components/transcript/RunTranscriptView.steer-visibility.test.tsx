// @vitest-environment node
import type { ChatMessage } from "@rudderhq/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import {
  isNativeSteerTranscriptEntry,
  mergeNativeSteerTranscriptEntries,
  type NativeSteerTranscriptEntry,
} from "../../lib/chat-stream-state";
import { StreamTranscriptItem } from "../../pages/Chat.StreamTranscriptItem";
import { chatProcessTranscriptEntries } from "../../pages/Chat.timeline";
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
  it("excludes user-authored Steer content while retaining agent process events", () => {
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
      "thinking",
    ]);
    expect(processEntries.filter(isNativeSteerTranscriptEntry)).toHaveLength(0);

    const blocks = normalizeTranscript(processEntries, false, { hideUserMessages: true });
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "tool", "thinking"]);
    expect(blocks.some((block) => block.type === "message" && block.text.includes(steerBody))).toBe(false);
    expect(blocks.some((block) => block.type === "event" && block.label === "skill context")).toBe(false);

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView density="compact" presentation="chat" entries={processEntries} />
      </ThemeProvider>,
    );
    expect(html).not.toContain('data-testid="chat-transcript-steer-message"');
    expect(html).not.toContain("Keep this direction visible as Steer input.");
    expect(html).toContain("Reasoning before the control point.");
    expect(html).toContain("Reasoning after the control point.");
    expect(html).toContain('data-transcript-action-icon="read"');
    expect(html).not.toContain("PRIVATE_STRUCTURED_ECHO");
    expect(html).not.toContain("PRIVATE_USER_ECHO");
    expect(html).not.toContain("UNANCHORED_STEER_ECHO");
    expect(html).not.toContain("Final response stays in its own message.");
  });

  it("excludes anchored Steer content even when its body resembles a structured input envelope", () => {
    const body = `Conversation input: ${JSON.stringify({ currentMessage: {
      role: "user", kind: "message", status: "completed", body: "STEER_BODY_MUST_REMAIN_VISIBLE",
      attachments: [], structuredPayload: null,
    } })}`;
    const runtimeEntries: TranscriptEntry[] = [
      { kind: "thinking", ts, text: "Agent reasoning remains visible." },
      { kind: "tool_call", ts, name: "inspect_state", toolUseId: "inspect-1", input: { target: "current run" } },
    ];
    const original = steerMessage("accepted_current", runtimeEntries.length);
    const structuredSteer = {
      ...original,
      id: "steer-structured-input",
      body,
      structuredPayload: { ...original.structuredPayload, controlActionId: "steer-structured-control" },
    };
    const entries = mergeNativeSteerTranscriptEntries(runtimeEntries, [structuredSteer]);
    const processEntries = chatProcessTranscriptEntries(entries);
    expect(processEntries).toEqual(runtimeEntries);

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView presentation="chat" entries={processEntries} />
      </ThemeProvider>,
    );
    expect(html).not.toContain("STEER_BODY_MUST_REMAIN_VISIBLE");
    expect(html).not.toContain("Conversation input:");
    expect(html).toContain("Agent reasoning remains visible.");
    expect(html).toContain("Inspected details");
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

  it("retains agent reasoning on both sides while omitting Steer content from the streaming row", () => {
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

    expect(html).toContain("Reasoning before Steer");
    expect(html).toContain("Reasoning after Steer");
    expect(html).not.toContain("Keep this direction visible as Steer input.");
    expect(html).not.toContain('data-testid="chat-transcript-steer-message"');
  });
});
