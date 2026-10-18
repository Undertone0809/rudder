import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestNativeChatMessages, type NativeChatMessageReaderInput } from "./native-chat-message-reader-bridge.js";

const actor = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  sessionId: "local-implicit",
  authEpoch: 1,
} as const;
const orgId = "10000000-0000-4000-8000-000000000001";
const input: NativeChatMessageReaderInput = {
  operation: "read_conversation_messages",
  conversationId: "20000000-0000-4000-8000-000000000001",
  limit: 25,
  cursor: "20000000-0000-4000-8000-000000000002",
  includeTranscript: true,
};

afterEach(() => vi.restoreAllMocks());

describe("native Chat message Reader Rust transport", () => {
  it("binds the conversation Reader action and preserves the response", async () => {
    let observed: { path?: string; body?: Buffer; action?: string } | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const envelope = JSON.parse(String(request.headers["x-rudder-actor-envelope"]));
      observed = { path: request.url, body, action: envelope.action };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [], source: "native_chat_reader" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      const result = await requestNativeChatMessages(
        `http://127.0.0.1:${address.port}`,
        "synthetic-reader-key",
        1000,
        actor,
        orgId,
        input,
      );
      expect(result.status).toBe(200);
      expect(observed?.path).toBe(`/internal/orgs/${orgId}/runtime-spans`);
      expect(observed?.body?.toString()).toBe(JSON.stringify(input));
      expect(observed?.action).toBe("runtime.span.read_conversation_messages");
      expect(JSON.parse(observed!.body!.toString())).toEqual(input);
      expect(createHash("sha256").update(observed!.body!).digest("hex")).toHaveLength(64);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
