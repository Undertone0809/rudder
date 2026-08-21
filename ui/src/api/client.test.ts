import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiTimeoutError, api } from "./client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api client errors", () => {
  it("includes validation detail messages in ApiError.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "Validation error",
            details: [
              {
                code: "custom",
                path: ["outputMode"],
                message: "Chat output automations are no longer supported",
              },
            ],
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(api.post("/orgs/org-1/automations", {})).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "Validation error: outputMode: Chat output automations are no longer supported",
    } satisfies Partial<ApiError>);
  });

  it("aborts a request that never receives a response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })
    )));

    const pending = api.post("/chats/chat-1/queue/item-1/steer", {}, { timeoutMs: 25 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toBeInstanceOf(ApiTimeoutError);
  });
});
