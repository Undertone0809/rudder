import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callRuntimeBinding, requestRuntimeBinding, type RuntimeBindingInput } from "./runtime-binding-bridge.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

const actor = {
  type: "board", userId: "local-board", source: "local_implicit",
  sessionId: "local-implicit", authEpoch: 1,
} as RustFoundationActor;
const orgId = "10000000-0000-4000-8000-000000000001";
const input: RuntimeBindingInput = {
  operation: "current", target: { targetType: "chat_conversation", targetId: "20000000-0000-4000-8000-000000000001" },
};

afterEach(() => vi.restoreAllMocks());

describe("runtime binding Rust transport", () => {
  it("binds the actual HTTP path, operation and body and preserves native error bytes", async () => {
    const expectedBody = Buffer.from('{"error":"Identity conflict","details":{"bindingId":"opaque"}}');
    let observed: { path?: string; body: Buffer; envelope: Record<string, unknown>; requestId: string | string[] | undefined } | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = {
        path: request.url, body: Buffer.concat(chunks),
        envelope: JSON.parse(String(request.headers["x-rudder-actor-envelope"])),
        requestId: request.headers["x-rudder-request-id"],
      };
      response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      response.end(expectedBody);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      const result = await requestRuntimeBinding(`http://127.0.0.1:${address.port}`, "synthetic-runtime-binding-key", 1000, actor, orgId, input);
      expect(result).toEqual({ status: 409, contentType: "application/json; charset=utf-8", body: expectedBody });
      expect(observed?.path).toBe(`/internal/orgs/${orgId}/runtime-bindings`);
      expect(observed?.body.toString()).toBe(JSON.stringify(input));
      expect(observed?.envelope).toMatchObject({
        organizationId: orgId, path: observed?.path, method: "POST",
        action: "runtime.binding.current", sessionId: "local-implicit",
        requestId: observed?.requestId,
        bodySha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not substitute a session or legacy writer when Rust is absent or fails", async () => {
    await expect(callRuntimeBinding(undefined, actor, orgId, input)).rejects.toMatchObject({ status: 503 });
    const runtimeBinding = vi.fn().mockRejectedValue(new Error("native unavailable"));
    await expect(callRuntimeBinding({ runtimeBinding } as unknown as RustFoundationBridge, actor, orgId, input)).rejects.toMatchObject({ status: 503 });
    expect(runtimeBinding).toHaveBeenCalledTimes(1);
  });

  it("relays explicit native denial without converting it to success or retrying", async () => {
    const denial = { status: 403, contentType: "application/json", body: Buffer.from('{"error":"Forbidden"}') };
    const runtimeBinding = vi.fn().mockResolvedValue(denial);
    expect(await callRuntimeBinding({ runtimeBinding } as unknown as RustFoundationBridge, actor, orgId, input)).toBe(denial);
    expect(runtimeBinding).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or oversized native transport responses", async () => {
    for (const [contentType, body] of [
      ["text/html", "<html>error</html>"],
      ["application/json", "{broken"],
      ["application/json", '{"success":true}'],
      ["application/json", JSON.stringify({ binding: "x".repeat(1024 * 1024), segment: null })],
    ]) {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": contentType }); response.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test listener");
        const bridge = { runtimeBinding: () => requestRuntimeBinding(`http://127.0.0.1:${address.port}`, "synthetic-runtime-binding-key", 1000, actor, orgId, input) } as unknown as RustFoundationBridge;
        await expect(callRuntimeBinding(bridge, actor, orgId, input)).rejects.toMatchObject({ status: 503 });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });
});
