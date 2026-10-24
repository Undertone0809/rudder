// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeChatRecovery } from "./use-native-chat-recovery";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  getNativeChatCapabilities: vi.fn(),
  readNativeChatRecovery: vi.fn(),
}));

vi.mock("@/api/chats", () => ({ chatsApi: api }));

let cleanup: (() => void) | null = null;

function renderRecovery() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: ReturnType<typeof useNativeChatRecovery> | null = null;

  function Probe({ children }: { children?: ReactNode }) {
    latest = useNativeChatRecovery("org-1", "chat-1");
    return children ?? null;
  }

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });

  cleanup = () => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    cleanup = null;
  };

  return { latest: () => latest };
}

afterEach(() => {
  cleanup?.();
  vi.clearAllMocks();
});

describe("useNativeChatRecovery", () => {
  it("does not probe the recovery route on older native ingress", async () => {
    api.getNativeChatCapabilities.mockResolvedValue({
      executionAuthority: "native_rust",
      firstSend: true,
      readTurn: true,
      nativeControls: true,
      recoveryRead: false,
    });
    const rendered = renderRecovery();

    await act(async () => {
      await vi.waitFor(() => expect(rendered.latest()?.status.kind).toBe("unsupported"));
    });
    expect(api.readNativeChatRecovery).not.toHaveBeenCalled();
  });

  it("fails closed when a listener advertises recovery reads but the read fails", async () => {
    api.getNativeChatCapabilities.mockResolvedValue({
      executionAuthority: "native_rust",
      firstSend: true,
      readTurn: true,
      nativeControls: true,
      recoveryRead: true,
    });
    api.readNativeChatRecovery.mockRejectedValue(new Error("offline"));
    const rendered = renderRecovery();

    await act(async () => {
      await vi.waitFor(() => expect(rendered.latest()?.status.kind).toBe("unavailable"));
    });
    expect(api.readNativeChatRecovery).toHaveBeenCalledWith("chat-1", "org-1");
    expect(rendered.latest()?.unavailable).toBe(true);
  });

  it("uses the durable pointer when the advertised read succeeds", async () => {
    const recovery = {
      generationId: "generation-1",
      runId: "run-1",
      attemptEpoch: 2,
      generationStatus: "interrupted_unverified",
      controlState: "control_lost",
      cleanupState: "unknown",
    } as const;
    api.getNativeChatCapabilities.mockResolvedValue({
      executionAuthority: "native_rust",
      firstSend: true,
      readTurn: true,
      nativeControls: true,
      recoveryRead: true,
    });
    api.readNativeChatRecovery.mockResolvedValue({
      executionAuthority: "native_rust",
      orgId: "org-1",
      conversationId: "chat-1",
      recovery,
    });
    const rendered = renderRecovery();

    await act(async () => {
      await vi.waitFor(() => expect(rendered.latest()?.status.kind).toBe("native"));
    });
    expect(rendered.latest()?.recovery).toEqual(recovery);
  });
});
