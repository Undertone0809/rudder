import type { ChatConversation, ChatMessage, ChatRuntimeDescriptor, ChatStreamEvent } from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsApi } from "./chats";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atomic chat draft API", () => {
  it("preflights a draft without creating a conversation", async () => {
    const descriptor: ChatRuntimeDescriptor = {
      sourceType: "unconfigured",
      sourceLabel: "Unconfigured chat runtime",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "process",
      model: null,
      available: false,
      error: "The current user has not configured a chat model yet.",
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(descriptor), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatsApi.preflightDraft("org-1", {
      preferredAgentId: "agent-1",
      modelOverride: "gpt-5.6-terra",
      issueCreationMode: "manual_approval",
      planMode: true,
      contextLinks: [{ entityType: "project", entityId: "project-1" }],
    })).resolves.toEqual(descriptor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/orgs/org-1/chats/preflight");
    expect(request).toMatchObject({
      method: "POST",
      credentials: "include",
    });
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(request?.body))).toEqual({
      preferredAgentId: "agent-1",
      modelOverride: "gpt-5.6-terra",
      issueCreationMode: "manual_approval",
      planMode: true,
      contextLinks: [{ entityType: "project", entityId: "project-1" }],
    });
  });

  it("streams the atomic first-turn acknowledgement", async () => {
    const conversation = { id: "chat-1", orgId: "org-1" } as ChatConversation;
    const userMessage = {
      id: "message-1",
      orgId: "org-1",
      conversationId: "chat-1",
      role: "user",
      kind: "message",
      status: "completed",
      body: "Begin atomically",
    } as ChatMessage;
    const ack: ChatStreamEvent = {
      type: "ack",
      conversation,
      userMessage,
      generationId: "generation-1",
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(`${JSON.stringify(ack)}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();

    await chatsApi.sendFirstMessageStream("org-1", "Begin atomically", {
      preferredAgentId: "agent-1",
      modelOverride: "gpt-5.6-luna",
      issueCreationMode: "manual_approval",
      planMode: false,
      contextLinks: [],
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledWith(ack);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/orgs/org-1/chats/messages/stream");
    expect(request).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      body: "Begin atomically",
      preferredAgentId: "agent-1",
      modelOverride: "gpt-5.6-luna",
      issueCreationMode: "manual_approval",
      planMode: false,
      contextLinks: [],
    });
  });

  it("keeps first-turn metadata beside staged attachments", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const attachment = new File(["evidence"], "evidence.txt", { type: "text/plain" });

    await chatsApi.sendFirstMessageStream("org-1", "Inspect the evidence", {
      preferredAgentId: "agent-1",
      modelOverride: "gpt-5.6-terra",
      issueCreationMode: "manual_approval",
      planMode: true,
      contextLinks: [{ entityType: "issue", entityId: "issue-1" }],
      files: [attachment],
      onEvent: vi.fn(),
    });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(request?.headers).toBeUndefined();
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("body")).toBe("Inspect the evidence");
    expect(form.get("preferredAgentId")).toBe("agent-1");
    expect(form.get("modelOverride")).toBe("gpt-5.6-terra");
    expect(form.get("issueCreationMode")).toBe("manual_approval");
    expect(form.get("planMode")).toBe("true");
    expect(form.get("contextLinks")).toBe(JSON.stringify([
      { entityType: "issue", entityId: "issue-1" },
    ]));
    expect(form.getAll("files")).toEqual([attachment]);
  });
});
