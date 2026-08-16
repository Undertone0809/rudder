import type {
  ChatConversation,
  ChatInlineAnnotationInput,
  ChatMessage,
  ChatRuntimeDescriptor,
  ChatStreamEvent,
} from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsApi } from "./chats";

afterEach(() => {
  vi.unstubAllGlobals();
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
      inlineAnnotations: [inlineAnnotation],
      onEvent: vi.fn(),
    });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(request?.body))).toEqual({
      body: "",
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
