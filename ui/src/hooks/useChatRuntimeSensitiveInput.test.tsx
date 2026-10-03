// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import { ChatRuntimeSensitiveInput } from "@/components/ChatRuntimeSensitiveInput";
import { ChatGenerationProvider } from "@/context/ChatGenerationContext";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatRuntimeSensitiveInput } from "./useChatRuntimeSensitiveInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const input = useChatRuntimeSensitiveInput("chat-1");
  return input.request
    ? <ChatRuntimeSensitiveInput request={input.request} onRespond={input.respond} onCancel={input.cancel} />
    : <div data-testid="no-request" />;
}

describe("useChatRuntimeSensitiveInput", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers a pending request after reconnect and sends its one-shot value without rendering it", async () => {
    vi.useFakeTimers();
    const request = { requestId: "request-1", kind: "secret" as const };
    let pending: typeof request[] = [];
    const list = vi.spyOn(chatsApi, "listRuntimeSensitiveInputs")
      .mockImplementation(async () => ({ requests: pending }));
    const respond = vi.spyOn(chatsApi, "respondToRuntimeSensitiveInput")
      .mockResolvedValue({ status: "accepted" });

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<ChatGenerationProvider><Harness /></ChatGenerationProvider>);
      await Promise.resolve();
    });
    expect(host.textContent).toBe("");

    pending = [request];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(host.textContent).toContain("Secret requested");
    expect(list).toHaveBeenCalledTimes(2);

    const form = host.querySelector("form");
    const password = host.querySelector<HTMLInputElement>("input[type='password']");
    if (!form || !password) throw new Error("Recovered sensitive input was not rendered");
    await act(async () => {
      password.value = "one-shot-secret";
      form.requestSubmit();
    });

    expect(respond).toHaveBeenCalledWith("chat-1", "request-1", "one-shot-secret");
    expect(password.value).toBe("");
    expect(host.textContent).not.toContain("one-shot-secret");
    expect(host.querySelector("[data-testid='no-request']")).not.toBeNull();
  });
});
