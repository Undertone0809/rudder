import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callNativeChatTranscript,
  requestNativeChatTranscript,
  type NativeChatTranscriptInput,
} from "./native-chat-transcript-bridge.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

const actor = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  sessionId: "local-implicit",
  authEpoch: 1,
} as RustFoundationActor;
const orgId = "10000000-0000-4000-8000-000000000001";
const input: NativeChatTranscriptInput = {
  operation: "read_message_transcript",
  messageId: "20000000-0000-4000-8000-000000000001",
  afterSeq: 4,
  limit: 25,
};

afterEach(() => vi.restoreAllMocks());

describe("native Chat transcript Rust transport", () => {
  it("binds the message reader action and preserves the native response", async () => {
    const expectedBody = Buffer.from(JSON.stringify({ messageId: input.messageId, transcript: [] }));
    let observed: { path?: string; body?: Buffer; envelope?: Record<string, unknown> } | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = {
        path: request.url,
        body: Buffer.concat(chunks),
        envelope: JSON.parse(String(request.headers["x-rudder-actor-envelope"])),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(expectedBody);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      const result = await requestNativeChatTranscript(
        `http://127.0.0.1:${address.port}`,
        "synthetic-transcript-key",
        1000,
        actor,
        orgId,
        input,
      );
      expect(result.body).toEqual(expectedBody);
      expect(observed?.path).toBe(`/internal/orgs/${orgId}/runtime-spans`);
      expect(observed?.body?.toString()).toBe(JSON.stringify(input));
      expect(observed?.envelope).toMatchObject({
        organizationId: orgId,
        path: observed?.path,
        action: "runtime.span.read_message_transcript",
        bodySha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails closed when Rust transcript authority is unavailable", async () => {
    await expect(callNativeChatTranscript(undefined, actor, orgId, input)).rejects.toMatchObject({ status: 503 });
    const nativeChatTranscript = vi.fn().mockRejectedValue(new Error("native unavailable"));
    await expect(callNativeChatTranscript({ nativeChatTranscript } as unknown as RustFoundationBridge, actor, orgId, input))
      .rejects.toMatchObject({ status: 503 });
    expect(nativeChatTranscript).toHaveBeenCalledTimes(1);
  });
});
