import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatRuntimeSensitiveInputBrokerError,
  createChatRuntimeSensitiveInputBroker,
  type ChatRuntimeSensitiveInputBinding,
  type ChatRuntimeSensitiveInputMetadata,
} from "./chat-runtime-sensitive-input.js";

const binding: ChatRuntimeSensitiveInputBinding = {
  principalId: "user:user-1",
  orgId: "org-1",
  chatId: "chat-1",
  runId: "run-1",
  attemptId: "attempt-1",
};

function broker(options: { maxPendingRequests?: number; maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const published: ChatRuntimeSensitiveInputMetadata[] = [];
  const instance = createChatRuntimeSensitiveInputBroker({
    ...options,
    publishRequest: (metadata) => published.push(metadata),
  });
  return { instance, published };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Chat runtime sensitive input broker", () => {
  it("publishes opaque metadata and accepts one exact one-shot response", async () => {
    const { instance, published } = broker();
    const request = instance.request({ binding, kind: "secret" });

    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(request.requestId).not.toContain(binding.orgId);
    expect(published).toEqual([{
      requestId: request.requestId,
      binding,
      kind: "secret",
    }]);
    expect(instance.pendingCount).toBe(1);

    instance.respond({ requestId: request.requestId, binding, value: "submitted-secret" });

    await expect(request.result).resolves.toEqual({ status: "provided", value: "submitted-secret" });
    expect(instance.pendingCount).toBe(0);
    expect(published).toHaveLength(1);
  });

  it.each([
    ["principalId", "user:user-2"],
    ["orgId", "org-2"],
    ["chatId", "chat-2"],
    ["runId", "run-2"],
    ["attemptId", "attempt-2"],
  ] as const)("rejects a response with a mismatched %s and keeps the request pending", async (key, value) => {
    const { instance } = broker();
    const request = instance.request({ binding, kind: "sudo" });
    const mismatchedBinding = { ...binding, [key]: value };

    expect(() => instance.respond({
      requestId: request.requestId,
      binding: mismatchedBinding,
      value: "must-not-be-accepted",
    })).toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_binding_mismatch" }));
    expect(instance.pendingCount).toBe(1);

    instance.respond({ requestId: request.requestId, binding, value: "accepted" });
    await expect(request.result).resolves.toEqual({ status: "provided", value: "accepted" });
  });

  it("makes response retries idempotent without retaining the value in reconnect metadata", async () => {
    const { instance, published } = broker();
    const request = instance.request({ binding, kind: "secret" });
    expect(instance.pendingForPrincipal({
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: binding.principalId,
    })).toEqual(published);

    expect(instance.respond({ requestId: request.requestId, binding, value: "first" })).toBe("accepted");
    expect(instance.respond({ requestId: request.requestId, binding, value: "different-retry-value" }))
      .toBe("already_accepted");
    await request.result;

    expect(instance.pendingForPrincipal({
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: binding.principalId,
    })).toEqual([]);
    expect(instance.pendingForPrincipal({
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: "user:user-2",
    })).toEqual([]);
    expect(JSON.stringify(published)).not.toContain("first");
    expect(JSON.stringify(published)).not.toContain("different-retry-value");
    expect(() => instance.respond({ requestId: "stale-request-id", binding, value: "late" }))
      .toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_not_pending" }));
    expect(instance.pendingCount).toBe(0);
  });

  it("authorizes response and reconnect lookup for the exact principal, organization, and chat", async () => {
    const { instance } = broker();
    const request = instance.request({ binding, kind: "sudo" });

    expect(instance.pendingForPrincipal({
      orgId: "org-other",
      chatId: binding.chatId,
      principalId: binding.principalId,
    })).toEqual([]);
    expect(() => instance.respondFromPrincipal({
      requestId: request.requestId,
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: "user:user-2",
      value: "must-not-be-accepted",
    })).toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_binding_mismatch" }));

    expect(instance.respondFromPrincipal({
      requestId: request.requestId,
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: binding.principalId,
      value: "accepted",
    })).toBe("accepted");
    await expect(request.result).resolves.toEqual({ status: "provided", value: "accepted" });
    expect(instance.respondFromPrincipal({
      requestId: request.requestId,
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: binding.principalId,
      value: "retry",
    })).toBe("already_accepted");
  });

  it("resolves cancellation and abort, clears listeners, and frees capacity", async () => {
    const { instance } = broker({ maxPendingRequests: 1 });
    const first = instance.request({ binding, kind: "sudo" });

    expect(instance.cancel({ requestId: first.requestId, binding: { ...binding, chatId: "other-chat" } })).toBe(false);
    expect(instance.cancel({ requestId: first.requestId, binding })).toBe(true);
    expect(instance.cancel({ requestId: first.requestId, binding })).toBe(true);
    await expect(first.result).resolves.toEqual({ status: "cancelled" });
    expect(instance.pendingCount).toBe(0);

    const controller = new AbortController();
    const second = instance.request({ binding, kind: "secret", signal: controller.signal });
    controller.abort();
    await expect(second.result).resolves.toEqual({ status: "aborted" });
    expect(instance.pendingCount).toBe(0);
    expect(() => instance.respond({ requestId: second.requestId, binding, value: "late" }))
      .toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_not_pending" }));

    const third = instance.request({ binding, kind: "secret" });
    expect(instance.pendingCount).toBe(1);
    instance.cancel({ requestId: third.requestId, binding });
    expect(instance.cancel({ requestId: third.requestId, binding })).toBe(true);
    await third.result;
  });

  it("resolves timeout and clears pending state", async () => {
    vi.useFakeTimers();
    const { instance } = broker({ timeoutMs: 50 });
    const request = instance.request({ binding, kind: "secret" });

    await vi.advanceTimersByTimeAsync(50);

    await expect(request.result).resolves.toEqual({ status: "timed_out" });
    expect(instance.pendingCount).toBe(0);
    expect(instance.pendingForPrincipal({
      orgId: binding.orgId,
      chatId: binding.chatId,
      principalId: binding.principalId,
    })).toEqual([]);
    expect(() => instance.respond({ requestId: request.requestId, binding, value: "late" }))
      .toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_not_pending" }));
  });

  it("rejects oversized values without echoing them or consuming the pending request", async () => {
    const submittedValue = "sensitive-value-that-must-never-appear";
    const { instance, published } = broker({ maxResponseBytes: 8 });
    const request = instance.request({ binding, kind: "secret" });
    let rejection: unknown;

    try {
      instance.respond({ requestId: request.requestId, binding, value: submittedValue });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(ChatRuntimeSensitiveInputBrokerError);
    expect(JSON.stringify(rejection)).not.toContain(submittedValue);
    expect(String(rejection)).not.toContain(submittedValue);
    expect(JSON.stringify(published)).not.toContain(submittedValue);
    expect(instance.pendingCount).toBe(1);

    instance.respond({ requestId: request.requestId, binding, value: "short" });
    await expect(request.result).resolves.toEqual({ status: "provided", value: "short" });
  });

  it("bounds total pending requests and removes entries when publishing fails", async () => {
    const publishRequest = vi.fn(() => { throw new Error("callback failure"); });
    const instance = createChatRuntimeSensitiveInputBroker({ publishRequest, maxPendingRequests: 1 });

    expect(() => instance.request({ binding, kind: "secret" }))
      .toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_publish_failed" }));
    expect(instance.pendingCount).toBe(0);

    const working = createChatRuntimeSensitiveInputBroker({
      maxPendingRequests: 1,
      publishRequest: () => undefined,
    });
    const request = working.request({ binding, kind: "secret" });
    expect(() => working.request({ binding, kind: "sudo" }))
      .toThrowError(expect.objectContaining({ code: "chat_runtime_sensitive_input_capacity" }));
    working.cancel({ requestId: request.requestId, binding });
    await request.result;
    expect(working.pendingCount).toBe(0);
  });
});
