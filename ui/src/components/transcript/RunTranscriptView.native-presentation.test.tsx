// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";
import { filterRenderableTranscriptEntries, isRudderEchoedStructuredConversationInput, isRudderInjectedAgentInstructionText } from "./RunTranscriptView.common";

const ts = "2026-09-29T01:33:22Z";
const rudderPromptMessage = (body: string, role: "user" | "assistant" = "user") => ({
  role,
  kind: "message",
  status: "completed",
  body,
  attachments: [],
  structuredPayload: null,
});
const rudderPromptEcho = (payload: Record<string, unknown>) => `Conversation input:\n${JSON.stringify(payload, null, 2)}`;
const rudderPromptReminder = [
  "Final Rudder result reminder:",
  "For an ordinary message reply, the native runtime final message is authoritative and must contain only the final answer body.",
  "Only use RUDDER_RESULT_BEGIN plus JSON when the result kind is ask_user, issue_proposal, operation_proposal, or automation_create.",
  "Do not write progress text after the final message or after the structured JSON object.",
].join("\n");
const rudderPromptEchoWithReminder = (payload: Record<string, unknown>) => `${rudderPromptEcho(payload)}\n\n${rudderPromptReminder}`;
const input: TranscriptEntry = {
  kind: "user", ts,
  text: rudderPromptEchoWithReminder({ currentMessage: rudderPromptMessage("what skills do you have?") }),
};
const injectedInstruction: TranscriptEntry = {
  kind: "user",
  ts,
  sourceEntryId: "rudder-injected-instruction",
  text: "<rudder_agent_instruction>\n<rudder_agent_operating_contract>\nRUDDER_INJECTED_INSTRUCTION_VISIBLE\n</rudder_agent_operating_contract>\n</rudder_agent_instruction>",
};

describe("native transcript presentation", () => {
  it("recognizes compact, pretty-printed, recent-history, and quoted structured input echoes", () => {
    const echoes = [
      `Conversation input: ${JSON.stringify({ currentMessage: rudderPromptMessage("compact") })}`,
      rudderPromptEcho({ recentMessages: [rudderPromptMessage("pretty")] }),
      `Conversation input: ${JSON.stringify(JSON.stringify({ currentMessage: rudderPromptMessage("quoted") }))}`,
      `Conversation input: ${JSON.stringify({ recentMessages: [rudderPromptMessage("escaped")] })}`,
    ];

    for (const echo of echoes) {
      expect(isRudderEchoedStructuredConversationInput(echo)).toBe(true);
    }
    expect(isRudderEchoedStructuredConversationInput("Conversation input: Please continue from here.")).toBe(false);
    expect(isRudderEchoedStructuredConversationInput(
      'Conversation input: {"currentMessage":{"body":"this is an explanatory JSON example"}}',
    )).toBe(false);
    expect(isRudderEchoedStructuredConversationInput(
      `Conversation input: ${JSON.stringify({ currentMessage: rudderPromptMessage("PRIVATE_COMPLETE_SCHEMA") })}`,
    )).toBe(true);
    expect(isRudderEchoedStructuredConversationInput(
      `Conversation input: ${JSON.stringify({ currentMessage: rudderPromptMessage("EXPLANATION_SCHEMA") })}\nThis example explains how Rudder structures a message.`,
    )).toBe(false);
    expect(isRudderEchoedStructuredConversationInput(
      `${rudderPromptEcho({ currentMessage: rudderPromptMessage("EXPLANATION_SCHEMA") })}\n\n${rudderPromptReminder}\nAn extra explanation is not part of the prompt.`,
    )).toBe(false);
  });

  it("keeps an agent explanation that demonstrates a complete Rudder message schema", () => {
    const explanation = `Conversation input: ${JSON.stringify({ currentMessage: rudderPromptMessage("EXPLANATION_SCHEMA") })}\nThis example explains how Rudder structures a message.`;
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={[{ kind: "assistant", ts, text: explanation, phase: "commentary" }]}
    /></ThemeProvider>);

    expect(html).toContain("This example explains how Rudder structures a message.");
    expect(html).toContain("EXPLANATION_SCHEMA");
  });

  it("hides an exact structured conversation-input echo returned as assistant commentary", () => {
    const example = rudderPromptEcho({ currentMessage: rudderPromptMessage("AMBIGUOUS_SCHEMA_EXAMPLE") });
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail"
      showDeveloperDiagnostics
      entries={[{ kind: "assistant", ts, text: example, phase: "commentary" }]}
    /></ThemeProvider>);

    expect(html).not.toContain("Conversation input:");
    expect(html).not.toContain("AMBIGUOUS_SCHEMA_EXAMPLE");
  });

  it("keeps structured-input privacy filtering active across event kinds and diagnostics", () => {
    const userEcho = rudderPromptEchoWithReminder({ currentMessage: rudderPromptMessage("DIAGNOSTIC_PRIVATE_USER_INPUT") });
    const assistantQuote = rudderPromptEchoWithReminder({ currentMessage: rudderPromptMessage("ASSISTANT_SCHEMA_QUOTE_VISIBLE") });
    const toolQuote = rudderPromptEchoWithReminder({ currentMessage: rudderPromptMessage("TOOL_SCHEMA_QUOTE_VISIBLE") });
    const entries: TranscriptEntry[] = [
      { kind: "user", ts, text: userEcho },
      { kind: "assistant", ts, text: assistantQuote, phase: "commentary" },
      { kind: "tool_result", ts, toolUseId: "echo-1", content: toolQuote, isError: false },
      { kind: "assistant", ts, text: "Diagnostic explanation remains visible.", phase: "commentary" },
    ];
    expect(filterRenderableTranscriptEntries(entries, {
      presentation: "detail",
      showDeveloperDiagnostics: true,
    })).toEqual([entries[3]]);
    expect(filterRenderableTranscriptEntries(entries, {
      presentation: "detail",
      showDeveloperDiagnostics: true,
    })).not.toContain(entries[2]);
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail"
      showDeveloperDiagnostics
      entries={entries}
    /></ThemeProvider>);

    expect(html).not.toContain("DIAGNOSTIC_PRIVATE_USER_INPUT");
    expect(html).not.toContain("ASSISTANT_SCHEMA_QUOTE_VISIBLE");
    expect(html).not.toContain("TOOL_SCHEMA_QUOTE_VISIBLE");
    expect(html).toContain("Diagnostic explanation remains visible.");
  });

  it("hides structured prompt echoes in Run Detail Raw while preserving real process output", () => {
    const inlineEnvelope: TranscriptEntry = {
      ...input,
      text: rudderPromptEchoWithReminder({ currentMessage: rudderPromptMessage("another echoed prompt") }),
    };
    const conversationMessage: TranscriptEntry = {
      kind: "user",
      ts,
      text: "Please inspect the settings file.",
    };
    const agentActivity: TranscriptEntry = {
      kind: "assistant",
      ts,
      phase: "commentary",
      text: "Agent activity remains available in Raw.",
    };
    const recentMessagesEcho: TranscriptEntry = {
      kind: "assistant",
      ts,
      phase: "commentary",
      text: rudderPromptEchoWithReminder({ recentMessages: [rudderPromptMessage("RAW_RECENT_MESSAGES_ECHO")] }),
    };
    const quotedEcho: TranscriptEntry = {
      kind: "tool_result",
      ts,
      toolUseId: "echo-1",
      content: `Conversation input: ${JSON.stringify(JSON.stringify({ currentMessage: rudderPromptMessage("RAW_QUOTED_ECHO") }))}`,
      isError: false,
    };
    const usefulToolResult: TranscriptEntry = {
      kind: "tool_result",
      ts,
      toolUseId: "read-2",
      content: "The README describes the project.",
      isError: false,
    };
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" mode="raw" entries={[input, inlineEnvelope, recentMessagesEcho, quotedEcho, conversationMessage, agentActivity, usefulToolResult]}
    /></ThemeProvider>);
    const hiddenNiceViewIndex = html.indexOf(' hidden="" aria-hidden="true"');
    expect(hiddenNiceViewIndex).toBeGreaterThan(0);
    const activeRawView = html.slice(0, hiddenNiceViewIndex);
    expect(activeRawView).not.toContain("what skills do you have?");
    expect(activeRawView).not.toContain("another echoed prompt");
    expect(activeRawView).not.toContain("Please inspect the settings file.");
    expect(activeRawView).not.toContain("Conversation input:");
    expect(activeRawView).not.toContain("currentMessage");
    expect(activeRawView).not.toContain("RAW_RECENT_MESSAGES_ECHO");
    expect(activeRawView).not.toContain("RAW_QUOTED_ECHO");
    expect(activeRawView).toContain("Agent activity remains available in Raw.");
    expect(activeRawView).toContain("The README describes the project.");
  });

  it("keeps actual user messages out of nice Run Detail activity", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={[
        { kind: "user", ts, text: "Please inspect the settings file." },
        { kind: "assistant", ts, text: "I will inspect it now." },
      ]}
    /></ThemeProvider>);

    expect(html).not.toContain("Please inspect the settings file.");
    expect(html).toContain("I will inspect it now.");
  });

  it("projects Hermes protocol rows only in the Chat process presentation", () => {
    const entries: TranscriptEntry[] = [
      { kind: "system", ts, sourceEntryId: "thinking-status", text: "Hermes thinking.delta: (｡•́︿•̀｡) mulling..." },
      { kind: "system", ts, sourceEntryId: "reasoning-status", text: "Hermes reasoning.available: true" },
      { kind: "system", ts, sourceEntryId: "reasoning-delta", text: "Hermes reasoning.delta: Checking the current transcript." },
      { kind: "system", ts, sourceEntryId: "unrelated", text: "A separate system event." },
      { kind: "user", ts, text: "Hermes thinking.delta: this is user content." },
    ];

    expect(filterRenderableTranscriptEntries(entries, { presentation: "chat" })).toEqual([
      { kind: "thinking", ts, sourceEntryId: "reasoning-delta", text: "Checking the current transcript." },
      entries[3],
      entries[4],
    ]);
    expect(filterRenderableTranscriptEntries(entries, { presentation: "detail" })).toEqual(entries);
    expect(filterRenderableTranscriptEntries(entries)).toEqual(entries);
    expect(entries).toEqual([
      { kind: "system", ts, sourceEntryId: "thinking-status", text: "Hermes thinking.delta: (｡•́︿•̀｡) mulling..." },
      { kind: "system", ts, sourceEntryId: "reasoning-status", text: "Hermes reasoning.available: true" },
      { kind: "system", ts, sourceEntryId: "reasoning-delta", text: "Hermes reasoning.delta: Checking the current transcript." },
      { kind: "system", ts, sourceEntryId: "unrelated", text: "A separate system event." },
      { kind: "user", ts, text: "Hermes thinking.delta: this is user content." },
    ]);

    const rawHtml = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" mode="raw" entries={entries}
    /></ThemeProvider>);
    expect(rawHtml).toContain("Hermes thinking.delta: (｡•́︿•̀｡) mulling...");
    expect(rawHtml).toContain("Hermes reasoning.available: true");
    expect(rawHtml).toContain("Hermes reasoning.delta: Checking the current transcript.");
  });

  it("keeps injected instructions out of Nice and structured input out of both Run Detail modes", () => {
    expect(isRudderInjectedAgentInstructionText(injectedInstruction.text)).toBe(true);
    expect(filterRenderableTranscriptEntries([injectedInstruction], { presentation: "detail" }))
      .toEqual([injectedInstruction]);
    const instructionBlocks = normalizeTranscript([injectedInstruction], false, { showAgentInstructions: true });
    expect(instructionBlocks).toEqual([expect.objectContaining({ type: "event", label: "agent instruction" })]);
    expect(instructionBlocks[0]).toMatchObject({ detail: expect.stringContaining("RUDDER_INJECTED_INSTRUCTION_VISIBLE") });

    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={[
        input,
        { kind: "assistant", ts, phase: "commentary", text: rudderPromptEchoWithReminder({ recentMessages: [rudderPromptMessage("CHAT_PROCESS_RECENT_ECHO")] }) },
        { kind: "assistant", ts, phase: "commentary", text: `Conversation input: ${JSON.stringify(JSON.stringify({ currentMessage: rudderPromptMessage("CHAT_PROCESS_QUOTED_ECHO") }))}\n\n${rudderPromptReminder}` },
        { kind: "tool_result", ts, toolUseId: "chat-echo-1", content: rudderPromptEchoWithReminder({ recentMessages: [rudderPromptMessage("CHAT_PROCESS_TOOL_ECHO")] }), isError: false },
        injectedInstruction,
        { kind: "user", ts, text: "Please inspect the settings file." },
        { kind: "assistant", ts, text: "I will inspect it now." },
      ]}
    /></ThemeProvider>);
    const retainedEntries = filterRenderableTranscriptEntries([
      input,
      { kind: "tool_result", ts, toolUseId: "chat-echo-1", content: rudderPromptEchoWithReminder({ recentMessages: [rudderPromptMessage("CHAT_PROCESS_TOOL_ECHO")] }), isError: false },
    ], { presentation: "detail" });

    expect(html).not.toContain("Conversation input:");
    expect(html).not.toContain("currentMessage");
    expect(html).not.toContain("CHAT_PROCESS_RECENT_ECHO");
    expect(html).not.toContain("CHAT_PROCESS_QUOTED_ECHO");
    expect(html).not.toContain("CHAT_PROCESS_TOOL_ECHO");
    expect(html).not.toContain("Final Rudder result reminder");
    expect(retainedEntries).toEqual([]);
    expect(html).not.toContain("Please inspect the settings file.");
    expect(html).not.toContain("Runtime-loaded agent instruction");
    expect(html).not.toContain('data-transcript-event-label="agent instruction"');
    expect(html).not.toContain("RUDDER_INJECTED_INSTRUCTION_VISIBLE");
    expect(html).toContain("I will inspect it now.");

    const rawHtml = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" mode="raw" entries={[injectedInstruction]}
    /></ThemeProvider>);
    expect(rawHtml).toContain("rudder_agent_instruction");
    expect(rawHtml).toContain("RUDDER_INJECTED_INSTRUCTION_VISIBLE");
  });

  it("keeps injected instructions out of Run Detail while identifying reasoning, tools, and the final response", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail"
      terminalRun
      emptyMessage="No transcript for this run."
      entries={[
        input,
        injectedInstruction,
        { kind: "user", ts, text: "DETAIL_USER_INPUT_MUST_STAY_HIDDEN" },
        { kind: "thinking", ts, text: "Checking the run context." },
        { kind: "tool_call", ts, name: "read_file", toolUseId: "read-1", input: { path: "README.md" } },
        { kind: "tool_result", ts, toolUseId: "read-1", toolName: "read_file", content: "Read complete.", isError: false },
        { kind: "assistant", ts, text: "The task is complete.", phase: "final_answer" },
      ]}
    /></ThemeProvider>);

    expect(html).not.toContain("Runtime-loaded agent instruction");
    expect(html).not.toContain("RUDDER_INJECTED_INSTRUCTION_VISIBLE");
    expect(html).toContain('data-transcript-event-category="reasoning"');
    expect(html).toContain("Reasoning");
    expect(html).toContain('data-transcript-event-category="tool-call"');
    expect(html).toContain("Tool call");
    expect(html).toContain('data-transcript-event-category="final-response"');
    expect(html).toContain("Final response");
    expect(html).not.toContain("Conversation input:");
    expect(html).not.toContain("currentMessage");
    expect(html).not.toContain("what skills do you have?");
    expect(html).not.toContain("Final Rudder result reminder");
    expect(html).not.toContain("DETAIL_USER_INPUT_MUST_STAY_HIDDEN");
    expect(html).not.toContain("No transcript for this run.");
  });

  it("shows only agent activity in a mixed Chat process transcript", () => {
    const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="chat"
      entries={[
        input,
        injectedInstruction,
        { kind: "user", ts, text: "what skills do you have?" },
        { kind: "assistant", ts, text: "Checking available skills.", phase: "commentary" },
        { kind: "tool_call", ts, name: "command_execution", toolUseId: "cmd-1", input: { command: "echo process evidence", cwd: "/tmp" } },
        { kind: "tool_result", ts, toolUseId: "cmd-1", toolName: "command_execution", content: "TRANSCRIPT_TOOL_OUTPUT_E2E", isError: false },
        { kind: "assistant", ts, text: "Available skills: browser.", phase: "final_answer" },
      ]}
      hiddenAssistantMessageText="Available skills: browser."
    /></ThemeProvider>);

    expect(html).not.toContain("Conversation input:");
    expect(html).not.toContain("RUDDER_INJECTED_INSTRUCTION_VISIBLE");
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
        injectedInstruction,
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

  it("hides native user-input echoes from both Run Detail modes while agent activity stays distinct", () => {
    const providerInputEcho = {
      kind: "cursor:acp:user_message_chunk",
      ts,
      sourceEntryId: "cursor-user-1",
      text: "PROVIDER_USER_INPUT_ECHO",
      payload: {
        provider: "cursor_agent",
        transport: "cursor-agent-acp-stdio",
        method: "session/update",
        sessionId: "cursor-session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "PROVIDER_USER_INPUT_ECHO" },
        },
      },
    } as unknown as TranscriptEntry;
    const providerCompletedInputEcho = {
      kind: "cursor:acp:user_message",
      ts,
      sourceEntryId: "cursor-user-2",
      text: "PROVIDER_COMPLETED_USER_INPUT_ECHO",
      payload: {
        provider: "cursor_agent",
        transport: "cursor-agent-acp-stdio",
        method: "session/update",
        sessionId: "cursor-session-1",
        update: {
          sessionUpdate: "user_message",
          content: { type: "text", text: "PROVIDER_COMPLETED_USER_INPUT_ECHO" },
        },
      },
    } as unknown as TranscriptEntry;
    const entries: TranscriptEntry[] = [
      input,
      { kind: "user", ts, text: "ORDINARY_USER_INPUT_ECHO" },
      providerInputEcho,
      providerCompletedInputEcho,
      { kind: "thinking", ts, text: "Inspect the project configuration." },
      { kind: "tool_call", ts, name: "read_file", toolUseId: "read-1", input: { path: "/tmp/config.json" } },
      { kind: "tool_result", ts, toolUseId: "read-1", content: "{}", isError: false },
      { kind: "assistant", ts, text: "The config is present; I am checking its contents.", phase: "commentary" },
      { kind: "assistant", ts, text: "The configuration is valid.", phase: "final_answer" },
    ];
    const niceHtml = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" entries={entries}
    /></ThemeProvider>);
    const rawHtml = renderToStaticMarkup(<ThemeProvider><RunTranscriptView
      presentation="detail" mode="raw" entries={entries}
    /></ThemeProvider>);
    const hiddenNiceViewIndex = rawHtml.indexOf(' hidden="" aria-hidden="true"');
    expect(hiddenNiceViewIndex).toBeGreaterThan(0);
    const activeRawView = rawHtml.slice(0, hiddenNiceViewIndex);

    expect(niceHtml).not.toContain("Conversation input:");
    expect(niceHtml).not.toContain("ORDINARY_USER_INPUT_ECHO");
    expect(niceHtml).not.toContain("PROVIDER_USER_INPUT_ECHO");
    expect(niceHtml).not.toContain("PROVIDER_COMPLETED_USER_INPUT_ECHO");
    expect(niceHtml).toContain("Inspect the project configuration.");
    expect(niceHtml).toContain("The config is present; I am checking its contents.");
    expect(niceHtml).toContain("Final response");
    expect(niceHtml).toContain("The configuration is valid.");

    expect(activeRawView).not.toContain("Conversation input:");
    expect(activeRawView).not.toContain("ORDINARY_USER_INPUT_ECHO");
    expect(activeRawView).not.toContain("PROVIDER_USER_INPUT_ECHO");
    expect(activeRawView).not.toContain("PROVIDER_COMPLETED_USER_INPUT_ECHO");
    expect(activeRawView).not.toContain("cursor-user-1");
    expect(activeRawView).not.toContain("cursor-user-2");

    const blocks = normalizeTranscript(entries, false, { hideUserMessages: true });
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "tool", "message", "message"]);
    expect(blocks[0]).toMatchObject({ type: "thinking", text: "Inspect the project configuration." });
    expect(blocks[1]).toMatchObject({ type: "tool", status: "completed", result: "{}" });
    expect(blocks[2]).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
      text: "The config is present; I am checking its contents.",
    });
    expect(blocks[3]).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "final_answer",
      text: "The configuration is valid.",
    });
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
