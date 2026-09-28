import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { withChatTranscriptGenerationProvenance } from "@rudderhq/shared/chat-transcript-provenance";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS } from "../services/chat-generation-provenance.js";
import { admitChatStreamSideChatFirstInput } from "./chats.stream-first-input.js";
import {
  appendChatStreamTranscriptMemory,
  boundedChatStreamTranscriptWindow,
} from "./chats.stream-transcript-memory.js";

describe("chat stream route helpers", () => {
  it("keeps the newest bounded transcript entries and coalesces adjacent text deltas", () => {
    const transcript: TranscriptEntry[] = [];
    for (let index = 0; index <= CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.entries; index += 1) {
      appendChatStreamTranscriptMemory(transcript, {
        kind: "user",
        ts: "2026-09-28T00:00:00.000Z",
        text: String(index),
      });
    }

    expect(transcript).toHaveLength(CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.entries);
    expect(transcript[0]).toMatchObject({ text: "1" });
    expect(boundedChatStreamTranscriptWindow(transcript)).toEqual(transcript);

    const deltas: TranscriptEntry[] = [];
    appendChatStreamTranscriptMemory(deltas, withChatTranscriptGenerationProvenance(
      { kind: "assistant", ts: "2026-09-28T00:00:00.000Z", text: "first ", delta: true },
      { generationId: "generation-1", generationSeq: 1 },
    ));
    appendChatStreamTranscriptMemory(deltas, withChatTranscriptGenerationProvenance(
      { kind: "assistant", ts: "2026-09-28T00:00:01.000Z", text: "second", delta: true },
      { generationId: "generation-1", generationSeq: 2 },
    ));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ text: "first second", generationSeqStart: 1, generationSeqEnd: 2 });
  });

  it("drops transcript entries that exceed the retained byte window", () => {
    const oversized = {
      kind: "user",
      ts: "2026-09-28T00:00:00.000Z",
      text: "x".repeat(CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes + 1),
    } satisfies TranscriptEntry;
    const transcript = [oversized];

    expect(boundedChatStreamTranscriptWindow(transcript)).toEqual([]);
    appendChatStreamTranscriptMemory(transcript, oversized);
    expect(transcript).toEqual([]);
  });

  it("returns the accepted Side Chat input after activity recovery for Generation resumption", async () => {
    const conversation = {
      id: "side-chat-1",
      orgId: "org-1",
      conversationKind: "side_chat",
    } as ChatConversation;
    const userMessage = { id: "message-1", role: "user" } as ChatMessage;
    const claimFirstInput = vi.fn().mockResolvedValue({
      kind: "replay",
      userMessageId: userMessage.id,
      activityLogged: false,
    });
    const getMessage = vi.fn().mockResolvedValue(userMessage);
    const recoverSideChatFirstInputActivity = vi.fn().mockResolvedValue(undefined);

    const result = await admitChatStreamSideChatFirstInput({
      atomicFirstTurn: false,
      conversation,
      request: {} as Request,
      clientMutationId: "first-send-key",
      clientMutationFingerprint: "request-fingerprint",
      body: "Question",
      inlineAnnotationsProvided: false,
      files: [],
      sideChats: { claimFirstInput } as never,
      boardUserId: () => "user-1",
      getMessage,
      recoverSideChatFirstInputActivity,
      actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null },
    });

    expect(claimFirstInput).toHaveBeenCalledWith({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      userId: "user-1",
      clientMutationId: "first-send-key",
      requestFingerprint: "request-fingerprint",
    });
    expect(result).toEqual({
      claimToken: null,
      requestFingerprint: "request-fingerprint",
      replayed: true,
      userMessage,
    });
    expect(recoverSideChatFirstInputActivity).toHaveBeenCalledWith(conversation, userMessage, expect.any(Object));
  });
});
