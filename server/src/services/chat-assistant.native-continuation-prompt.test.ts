import { describe, expect, it } from "vitest";
import { buildConversationPrompt } from "./chat-assistant.helpers.js";

type ConversationInputEnvelope = {
  conversation: Record<string, unknown>;
  currentMessage?: { body?: string } | null;
  recentMessages?: Array<{ body?: string }>;
};

function conversationInputFromPrompt(prompt: string): ConversationInputEnvelope {
  const prefix = "Conversation input:\n\n";
  const suffix = "\n\nFinal Rudder result reminder:";
  const start = prompt.indexOf(prefix);
  const jsonStart = start + prefix.length;
  const end = prompt.indexOf(suffix, jsonStart);
  if (start < 0 || end < 0) {
    throw new Error("Could not locate the conversation input envelope in the prompt.");
  }
  return JSON.parse(prompt.slice(jsonStart, end)) as ConversationInputEnvelope;
}

describe("native continuation prompt projection", () => {
  it("omits the conversation title while preserving the current message and routing context", () => {
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const preferredAgentId = "30000000-0000-4000-8000-000000000002";
    const routedAgentId = "30000000-0000-4000-8000-000000000003";
    const primaryIssueId = "30000000-0000-4000-8000-000000000004";
    const previousTurnMarker = "PI-LOCAL-THREAD-7C41";
    const previousMessageBody = "PRIOR-TURN-BODY-ONLY";
    const currentMessageBody = "CURRENT-TURN-BODY-ONLY";
    const title = `Previous turn: ${previousTurnMarker}`;
    const summary = `Previous turns included ${previousTurnMarker}`;
    const issueContextMarker = "EXPLICIT-ISSUE-CONTEXT-MUST-REMAIN";

    const promptInput = {
      conversation: {
        id: conversationId,
        orgId: "30000000-0000-4000-8000-000000000005",
        title,
        status: "active",
        summary,
        planMode: false,
        issueCreationMode: "manual_approval",
        preferredAgentId,
        routedAgentId,
        primaryIssueId,
        primaryIssue: null,
      },
      messages: [
        {
          id: "30000000-0000-4000-8000-000000000006",
          role: "user",
          kind: "message",
          status: "completed",
          body: previousMessageBody,
          structuredPayload: null,
          attachments: [],
        },
        {
          id: "30000000-0000-4000-8000-000000000007",
          role: "user",
          kind: "message",
          status: "completed",
          body: currentMessageBody,
          structuredPayload: null,
          attachments: [],
        },
      ],
      contextLinks: [{
        entityType: "issue",
        entityId: primaryIssueId,
        entity: {
          identifier: "RUD-42",
          label: "Selected issue for native continuation",
          status: "in_progress",
          priority: "high",
          description: issueContextMarker,
        },
      }],
    } as unknown as Parameters<typeof buildConversationPrompt>[0];
    const runtimeSource = {
      descriptor: {
        sourceType: "agent",
        sourceLabel: "Pi Native Main Chat",
        runtimeAgentId: preferredAgentId,
        agentRuntimeType: "pi_local",
        model: "openai/gpt-5.6-luna",
        available: true,
        error: null,
      },
      runtimeAgent: null,
      agentRuntimeType: "pi_local",
      agentRuntimeConfig: null,
      runtimeSkills: [],
    } as unknown as Parameters<typeof buildConversationPrompt>[1];
    const resultSentinel = "__RUDDER_RESULT_native_continuation_test__";

    const nativePrompt = buildConversationPrompt(
      promptInput,
      runtimeSource,
      resultSentinel,
      "",
      new Map(),
      { nativeContinuation: true },
    );
    const nativeEnvelope = conversationInputFromPrompt(nativePrompt);

    expect(nativePrompt).not.toContain(title);
    expect(nativePrompt).not.toContain(summary);
    expect(nativePrompt).not.toContain(previousTurnMarker);
    expect(nativePrompt).not.toContain(previousMessageBody);
    expect(nativePrompt).toContain(issueContextMarker);
    expect(nativeEnvelope.currentMessage?.body).toBe(currentMessageBody);
    expect(nativeEnvelope.recentMessages).toBeUndefined();
    expect(nativeEnvelope.conversation).toEqual({
      id: conversationId,
      status: "active",
      planMode: false,
      issueCreationMode: "manual_approval",
      preferredAgentId,
      routedAgentId,
      primaryIssueId,
    });

    const nonNativePrompt = buildConversationPrompt(
      promptInput,
      runtimeSource,
      resultSentinel,
      "",
    );
    const nonNativeEnvelope = conversationInputFromPrompt(nonNativePrompt);

    expect(nonNativeEnvelope.conversation.title).toBe(title);
    expect(nonNativeEnvelope.conversation.summary).toBe(summary);
    expect(nonNativeEnvelope.recentMessages?.map((message) => message.body)).toEqual([
      previousMessageBody,
      currentMessageBody,
    ]);
  });

  it("marks the exact selected parent reply on the first native Side Chat turn", () => {
    const currentMessageBody = "Which response opened this Side Chat?";
    const selectedReplyBody = "SELECTED_NATIVE_SIDE_CHAT_REPLY_92AF";
    const promptInput = {
      conversation: {
        id: "child-chat",
        orgId: "org-1",
        title: "Parent conversation title is not the branch point",
        status: "active",
        planMode: false,
        issueCreationMode: "manual_approval",
        preferredAgentId: "agent-1",
        routedAgentId: "agent-1",
        primaryIssueId: null,
      },
      messages: [{
        id: "current-message",
        role: "user",
        kind: "message",
        status: "completed",
        body: currentMessageBody,
        attachments: [],
      }],
      contextLinks: [],
      nativeForkBoundary: {
        sourceConversationId: "parent-chat",
        sourceMessageId: "original-parent-message",
        copiedMessageId: "copied-parent-message",
        selectedAssistantReply: selectedReplyBody,
      },
    } as unknown as Parameters<typeof buildConversationPrompt>[0];
    const runtimeSource = {
      descriptor: { sourceType: "agent", sourceLabel: "Hermes Side Chat", runtimeAgentId: "agent-1", agentRuntimeType: "hermes_gateway", model: null, available: true, error: null },
      runtimeAgent: null,
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: null,
      runtimeSkills: [],
    } as unknown as Parameters<typeof buildConversationPrompt>[1];

    const prompt = buildConversationPrompt(promptInput, runtimeSource, "__RESULT__", "", new Map(), { nativeContinuation: true });
    const envelope = conversationInputFromPrompt(prompt);

    expect(prompt).toContain("Selected native Side Chat reply boundary:");
    expect(prompt).toContain(selectedReplyBody);
    expect(prompt).toContain("original-parent-message");
    expect(prompt).not.toContain("Parent conversation title is not the branch point");
    expect(envelope.currentMessage?.body).toBe(currentMessageBody);
    expect(envelope.recentMessages).toBeUndefined();
  });
});
