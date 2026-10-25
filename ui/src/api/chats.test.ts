import type {
  ChatConversation,
  ChatInlineAnnotationInput,
  ChatMessage,
  ChatRuntimeDescriptor,
  ChatStreamEvent,
} from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_REQUEST_TIMEOUT_MS,
  CHAT_STREAM_IDLE_TIMEOUT_MS,
  chatsApi,
} from "./chats";
import { ApiTimeoutError } from "./client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat stream timeouts", () => {
  it("clears a send when the stream connection never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })
    )));

    const pending = chatsApi.sendMessageStream("chat-1", "hello", { clientMutationId: "mutation-timeout", onEvent: vi.fn() }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(CHAT_REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toBeInstanceOf(ApiTimeoutError);
  });

  it("does not abort an established stream after the connection timeout", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const onEvent = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(stream);
    }));

    const pending = chatsApi.sendMessageStream("chat-1", "hello", { clientMutationId: "mutation-stream", onEvent });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(CHAT_REQUEST_TIMEOUT_MS);

    expect(requestSignal?.aborted).toBe(false);
    streamController?.enqueue(new TextEncoder().encode('{"type":"final","messages":[]}\n'));
    streamController?.close();
    await expect(pending).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith({ type: "final", messages: [] });
  });

  it("fails an established stream that goes silent", async () => {
    vi.useFakeTimers();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const pending = chatsApi.sendMessageStream("chat-1", "hello", { clientMutationId: "mutation-timeout", onEvent: vi.fn() }).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_IDLE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      name: "ApiTimeoutError",
      timeoutMs: CHAT_STREAM_IDLE_TIMEOUT_MS,
    });
    expect(streamController).toBeDefined();
  });

  it("keeps the caller abort signal connected after response headers", async () => {
    vi.useFakeTimers();
    const callerController = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestSignal: AbortSignal | null | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(stream);
    }));

    const pending = chatsApi.sendMessageStream("chat-1", "hello", {
      clientMutationId: "mutation-abort",
      signal: callerController.signal,
      onEvent: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    callerController.abort();

    expect(requestSignal?.aborted).toBe(true);
    streamController?.error(new DOMException("The operation was aborted.", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("chat stream mutation identity", () => {
  it("rejects an empty identity before opening a connection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatsApi.sendMessageStream("chat-1", "hello", {
      clientMutationId: " ",
      onEvent: vi.fn(),
    })).rejects.toThrow("stable chat submission identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes the mutation identity in JSON requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      '{"type":"final","messages":[]}\n',
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendMessageStream("chat-1", "Retry safely", {
      clientMutationId: "mutation-json-1",
      onEvent: vi.fn(),
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      body: "Retry safely",
      clientMutationId: "mutation-json-1",
    });
  });

  it("includes the mutation identity beside multipart attachments", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      '{"type":"final","messages":[]}\n',
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendMessageStream("chat-1", "Retry with proof", {
      clientMutationId: "mutation-multipart-1",
      files: [new File(["proof"], "proof.txt", { type: "text/plain" })],
      onEvent: vi.fn(),
    });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("clientMutationId")).toBe("mutation-multipart-1");
    expect(form.get("body")).toBe("Retry with proof");
  });
});

describe("chat message history API", () => {
  it("scopes message history requests to the selected organization", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatsApi.listMessages("org-1", "chat-1", {
      includeTranscript: false,
    })).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-1/messages?orgId=org-1&includeTranscript=false",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("atomic chat draft API", () => {
  const inlineAnnotation: ChatInlineAnnotationInput = {
    id: "00000000-0000-4000-8000-000000000001",
    selectedText: "quoted answer",
    comment: "Explain this",
    sourceConversationId: "00000000-0000-4000-8000-000000000002",
    sourceMessageId: "00000000-0000-4000-8000-000000000003",
    surface: "assistant_body",
    sourceHash: "a".repeat(64),
    start: 4,
    end: 17,
    prefix: "the ",
    suffix: " next",
  };

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
      effortOverride: "xhigh",
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
      effortOverride: "xhigh",
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
      groupId: "00000000-0000-4000-8000-000000000001",
      modelOverride: "gpt-5.6-luna",
      effortOverride: "high",
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
      effortOverride: "high",
      issueCreationMode: "manual_approval",
      planMode: false,
      contextLinks: [],
      groupId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("omits group context from an ordinary JSON first turn", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendFirstMessageStream("org-1", "Start normally", {
      preferredAgentId: "agent-1",
      modelOverride: null,
      effortOverride: null,
      issueCreationMode: "manual_approval",
      planMode: false,
      contextLinks: [],
      onEvent: vi.fn(),
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("groupId");
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
      effortOverride: "medium",
      issueCreationMode: "manual_approval",
      planMode: true,
      contextLinks: [{ entityType: "issue", entityId: "issue-1" }],
      groupId: "00000000-0000-4000-8000-000000000001",
      files: [attachment],
      onEvent: vi.fn(),
    });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(new Headers(request?.headers).has("Content-Type")).toBe(false);
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("body")).toBe("Inspect the evidence");
    expect(form.get("preferredAgentId")).toBe("agent-1");
    expect(form.get("modelOverride")).toBe("gpt-5.6-terra");
    expect(form.get("effortOverride")).toBe("medium");
    expect(form.get("issueCreationMode")).toBe("manual_approval");
    expect(form.get("planMode")).toBe("true");
    expect(form.get("contextLinks")).toBe(JSON.stringify([
      { entityType: "issue", entityId: "issue-1" },
    ]));
    expect(form.get("groupId")).toBe("00000000-0000-4000-8000-000000000001");
    expect(form.getAll("files")).toEqual([attachment]);
  });

  it("omits group context from an ordinary multipart first turn", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendFirstMessageStream("org-1", "Attach normally", {
      preferredAgentId: "agent-1",
      modelOverride: "gpt-5.6-terra",
      effortOverride: "medium",
      issueCreationMode: "manual_approval",
      planMode: true,
      contextLinks: [],
      files: [new File(["evidence"], "evidence.txt", { type: "text/plain" })],
      onEvent: vi.fn(),
    });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.has("groupId")).toBe(false);
  });

  it("encodes Agent-default runtime intent for attached first turns", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendFirstMessageStream("org-1", "Start with defaults", {
      preferredAgentId: "agent-1",
      modelOverride: null,
      effortOverride: null,
      issueCreationMode: "manual_approval",
      planMode: false,
      contextLinks: [],
      files: [new File(["evidence"], "evidence.txt", { type: "text/plain" })],
      onEvent: vi.fn(),
    });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("modelOverride")).toBe("__rudder_agent_default__");
    expect(form.get("effortOverride")).toBe("__rudder_agent_default__");
    expect(form.has("groupId")).toBe(false);
  });

  it("sends an annotation-only turn as JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendMessageStream("chat-1", "", {
      clientMutationId: "mutation-annotation",
      inlineAnnotations: [inlineAnnotation],
      onEvent: vi.fn(),
    });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(request?.body))).toEqual({
      body: "",
      clientMutationId: "mutation-annotation",
      inlineAnnotations: [inlineAnnotation],
      modelOverride: null,
      effortOverride: null,
    });
  });

  it("keeps regular and annotation-owned file indexes aligned in multipart turns", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const regularFile = new File(["prompt"], "prompt.txt", { type: "text/plain" });
    const annotationFile = new File(["proof"], "proof.png", { type: "image/png" });
    const annotationWithFile: ChatInlineAnnotationInput = {
      ...inlineAnnotation,
      attachmentFileIndexes: [1],
    };

    await chatsApi.sendMessageStream("chat-1", "Review this", {
      clientMutationId: "mutation-files",
      files: [regularFile, annotationFile],
      inlineAnnotations: [annotationWithFile],
      modelOverride: "gpt-5.6-luna",
      effortOverride: "high",
      onEvent: vi.fn(),
    });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(request?.headers).toBeUndefined();
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("body")).toBe("Review this");
    expect(form.get("inlineAnnotations")).toBe(JSON.stringify([annotationWithFile]));
    expect(form.get("modelOverride")).toBe("gpt-5.6-luna");
    expect(form.get("effortOverride")).toBe("high");
    expect(form.getAll("files")).toEqual([regularFile, annotationFile]);
  });

  it("encodes Agent-default runtime intent in multipart turns", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.sendMessageStream("chat-1", "Use Agent defaults", {
      clientMutationId: "mutation-defaults",
      files: [new File(["prompt"], "prompt.txt", { type: "text/plain" })],
      modelOverride: null,
      effortOverride: null,
      onEvent: vi.fn(),
    });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("modelOverride")).toBe("__rudder_agent_default__");
    expect(form.get("effortOverride")).toBe("__rudder_agent_default__");
  });

  it("creates an annotation-only queued message with annotation-owned files", async () => {
    const queuedMessage = {
      id: "queue-1",
      conversationId: "chat-1",
      payload: {
        body: "",
        inlineAnnotations: [{ ...inlineAnnotation, attachmentIds: [] }],
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(queuedMessage),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const annotationFile = new File(["proof"], "proof.png", { type: "image/png" });
    const annotationWithFile: ChatInlineAnnotationInput = {
      ...inlineAnnotation,
      attachmentFileIndexes: [0],
    };

    await chatsApi.createQueuedMessage("chat-1", {
      clientMutationId: "ui:queue-1",
      expectedGenerationId: "00000000-0000-4000-8000-000000000004",
      payload: {
        body: "",
        inlineAnnotations: [annotationWithFile],
        attachmentIds: [],
        skillRefs: [],
      },
    }, {
      files: [annotationFile],
    });

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/chats/chat-1/queue");
    expect(new Headers(request?.headers).has("Content-Type")).toBe(false);
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("clientMutationId")).toBe("ui:queue-1");
    expect(form.get("expectedGenerationId")).toBe(
      "00000000-0000-4000-8000-000000000004",
    );
    expect(JSON.parse(String(form.get("payload")))).toEqual({
      body: "",
      inlineAnnotations: [annotationWithFile],
      attachmentIds: [],
      skillRefs: [],
    });
    expect(form.getAll("files")).toEqual([annotationFile]);
  });
});

describe("Native Chat first-send negotiation", () => {
  const firstSendConversation = (
    overrides: Partial<ChatConversation> = {},
  ): ChatConversation => ({
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    status: "active",
    conversationKind: "chat",
    messengerVisible: true,
    sideChatState: null,
    sideChatExpiresAt: null,
    sideChatCompletedAt: null,
    sideChatKeptAt: null,
    sideChatClientMutationId: null,
    initialClientMutationId: "stable-native-first-send",
    mutability: "native_chat",
    title: "A first chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: "Hello from a stable identity",
    userMessageCount: 1,
    preferredAgentId: "00000000-0000-4000-8000-000000000003",
    modelOverride: null,
    effortOverride: null,
    routedAgentId: null,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "00000000-0000-4000-8000-000000000006",
    lastMessageAt: new Date("2026-10-17T00:00:00.000Z"),
    lastReadAt: null,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    contextLinks: [],
    sourceMetadata: null,
    chatRuntime: {
      sourceType: "agent",
      sourceLabel: "Codex agent",
      runtimeAgentId: "00000000-0000-4000-8000-000000000003",
      agentRuntimeType: "codex_local",
      model: "gpt-6.1-sol",
      effort: "medium",
      available: true,
      error: null,
    },
    createdAt: new Date("2026-10-17T00:00:00.000Z"),
    updatedAt: new Date("2026-10-17T00:00:00.000Z"),
    ...overrides,
  });

  it("uses the closed capability contract and treats only route_not_found as a legacy server", async () => {
    const capabilities = {
      executionAuthority: "native_rust",
      firstSend: true,
      readTurn: false,
      nativeControls: false,
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(capabilities), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatsApi.getNativeChatCapabilities()).resolves.toEqual({
      ...capabilities,
      recoveryRead: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/native-chat/capabilities",
      expect.objectContaining({ credentials: "include" }),
    );

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: "route_not_found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )));
    await expect(chatsApi.getNativeChatCapabilities()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: "not_found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )));
    await expect(chatsApi.getNativeChatCapabilities()).rejects.toMatchObject({ status: 404 });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...capabilities,
      recoveryRead: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(chatsApi.getNativeChatCapabilities()).resolves.toEqual({
      ...capabilities,
      recoveryRead: true,
    });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...capabilities,
      recoveryRead: "yes",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(chatsApi.getNativeChatCapabilities()).rejects.toThrow("capability response was invalid");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...capabilities,
      futureFallback: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(chatsApi.getNativeChatCapabilities()).rejects.toThrow("capability response was invalid");
  });

  it("sends the stored first-message identity and accepts only a safe runtime conversation acknowledgement", async () => {
    const conversation = firstSendConversation();
    const ack = {
      type: "ack",
      conversation,
      userMessage: {
        id: "00000000-0000-4000-8000-000000000004",
        orgId: conversation.orgId,
        conversationId: conversation.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Hello from a stable identity",
        structuredPayload: null,
        approvalId: null,
        approval: null,
        attachments: [],
        replyingAgentId: null,
        chatTurnId: null,
        turnVariant: 0,
        supersededAt: null,
        createdAt: new Date("2026-10-17T00:00:00.000Z"),
        updatedAt: new Date("2026-10-17T00:00:00.000Z"),
      },
      generationId: "00000000-0000-4000-8000-000000000005",
    } satisfies ChatStreamEvent;
    const wireAck = JSON.parse(JSON.stringify(ack)) as ChatStreamEvent;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(`${JSON.stringify(wireAck)}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();

    await chatsApi.sendNativeFirstMessageStream(conversation.orgId, {
      clientMutationId: "stable-native-first-send",
      body: "Hello from a stable identity",
      preferredAgentId: conversation.preferredAgentId,
      title: null,
      issueCreationMode: "manual_approval",
      modelOverride: null,
      effortOverride: null,
    }, { onEvent });

    expect(onEvent).toHaveBeenCalledWith(wireAck);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      body: "Hello from a stable identity",
      clientMutationId: "stable-native-first-send",
      preferredAgentId: conversation.preferredAgentId,
      title: null,
      issueCreationMode: "manual_approval",
      modelOverride: null,
      effortOverride: null,
      planMode: false,
      contextLinks: [],
    });
  });

  it.each(["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000009", null])("accepts exact recovery after mutable preferences change to %s", async (preferredAgentId) => {
    const original = firstSendConversation();
    const changed = preferredAgentId !== original.preferredAgentId;
    const conversation = firstSendConversation({
      preferredAgentId,
      ...(changed ? { chatRuntime: {
        sourceType: "agent", sourceLabel: "Agent", runtimeAgentId: preferredAgentId,
        agentRuntimeType: null, model: null, effort: null, available: false,
        error: "Refresh this chat to load its current Agent.",
      } satisfies ChatRuntimeDescriptor } : {}),
      status: "resolved",
      summary: "Summary added after the first turn",
      latestReplyPreview: "A later assistant response",
      planMode: true,
    });
    const input = {
      clientMutationId: "stable-native-first-send",
      body: "Hello from a stable identity",
      preferredAgentId: original.preferredAgentId,
      title: null,
      issueCreationMode: "manual_approval" as const,
      modelOverride: null,
      effortOverride: null,
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      outcome: "accepted",
      clientMutationId: input.clientMutationId,
      conversation,
      message: {
        id: "00000000-0000-4000-8000-000000000004",
        orgId: conversation.orgId,
        conversationId: conversation.id,
        role: "user",
        body: input.body,
      },
      generationId: "00000000-0000-4000-8000-000000000005",
      runId: "00000000-0000-4000-8000-000000000007",
      attemptEpoch: 1,
      generationSeq: 0,
      bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      generationStatus: "completed",
      runStatus: "succeeded",
      runtimeTerminal: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(chatsApi.reconcileNativeFirstSend(conversation.orgId, input)).resolves.toMatchObject({
      outcome: "accepted",
      conversation: { status: "resolved", planMode: true, summary: "Summary added after the first turn", preferredAgentId },
    });
  });

  it("rejects an acknowledgement that leaks extra runtime projection fields", async () => {
    const validConversation = firstSendConversation();
    const conversation = {
      ...validConversation,
      chatRuntime: { ...validConversation.chatRuntime, executablePath: "/private/path" },
    } as unknown as ChatConversation;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(`${JSON.stringify({
      type: "ack",
      conversation,
      userMessage: { id: "message-1", body: "hello" },
    })}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatsApi.sendNativeFirstMessageStream("org-1", {
      clientMutationId: "stable-native-first-send",
      body: "hello",
      preferredAgentId: "agent-1",
      title: null,
      issueCreationMode: "manual_approval",
      modelOverride: null,
      effortOverride: null,
    }, { onEvent: vi.fn() })).rejects.toThrow("safe conversation projection");
  });
});
