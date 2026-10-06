// @vitest-environment jsdom

import { chatsApi, type SideChatHistoryPage } from "@/api/chats";
import { SidePanelProvider } from "@/context/SidePanelContext";
import { queryKeys } from "@/lib/queryKeys";
import { sideChatTargetFromConversation } from "@/lib/side-panel-targets";
import type { ChatConversation } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSideChatHistoryMenu } from "./Chat.side-chat-history";

vi.mock("@/api/chats", () => ({
  chatsApi: { listSideChats: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const organizationId = "org-history";
const parentConversationId = "parent-history";

function sideChat(id: string, title: string) {
  return {
    id,
    title,
    conversationKind: "side_chat",
    sideChatState: "active",
    sideChatExpiresAt: null,
  } as ChatConversation;
}

function historyPage(conversation: ChatConversation): SideChatHistoryPage {
  return { items: [conversation], nextCursor: null };
}

let queryClient: QueryClient;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "session-1", userId: "user-1" },
    user: { id: "user-1", email: "same@example.com", name: "Same User" },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(chatsApi.listSideChats).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  host.remove();
  document.body.querySelectorAll("[data-radix-popper-content-wrapper]").forEach((node) => node.remove());
});

function renderHistoryMenu(onOpen = vi.fn()) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidePanelProvider>
          <ChatSideChatHistoryMenu
            organizationId={organizationId}
            sourceConversationId={parentConversationId}
            onOpen={onOpen}
          />
        </SidePanelProvider>
      </QueryClientProvider>,
    );
  });
  return onOpen;
}

function openHistoryMenu() {
  const trigger = host.querySelector<HTMLButtonElement>("[data-testid='side-chat-history-trigger']");
  act(() => {
    trigger?.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
  });
}

describe("ChatSideChatHistoryMenu principal cache scope", () => {
  it("reopens a Side Chat from its parent conversation history", async () => {
    const conversation = sideChat("side-history-1", "Investigate the failed run");
    vi.mocked(chatsApi.listSideChats).mockResolvedValue(historyPage(conversation));
    const onOpen = renderHistoryMenu();

    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector("[data-testid='side-chat-history-trigger']")).not.toBeNull());
      host.querySelector<HTMLButtonElement>("[data-testid='side-chat-history-trigger']")?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
      await vi.waitFor(() => expect(document.body.querySelector("[data-testid='side-chat-history-item']")).not.toBeNull());
    });

    act(() => document.body.querySelector<HTMLElement>("[data-testid='side-chat-history-item']")?.click());

    expect(onOpen).toHaveBeenCalledExactlyOnceWith(
      sideChatTargetFromConversation(parentConversationId, conversation),
    );
  });

  it("switches the visible history and cache when the authenticated principal changes", async () => {
    const firstConversation = sideChat("side-user-1", "Account one Side Chat");
    const secondConversation = sideChat("side-user-2", "Account two Side Chat");
    let resolveSecondPage!: (page: SideChatHistoryPage) => void;
    vi.mocked(chatsApi.listSideChats)
      .mockResolvedValueOnce(historyPage(firstConversation))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecondPage = resolve;
      }));

    renderHistoryMenu();
    await vi.waitFor(() => expect(host.querySelector("[data-testid='side-chat-history-trigger']")).not.toBeNull());

    const firstKey = queryKeys.chats.sideChats(organizationId, parentConversationId, "user-1");
    const secondKey = queryKeys.chats.sideChats(organizationId, parentConversationId, "user-2");
    expect(firstKey).not.toEqual(secondKey);
    expect(queryClient.getQueryData<{ pages: SideChatHistoryPage[] }>(firstKey)?.pages[0]?.items[0]?.title)
      .toBe("Account one Side Chat");

    openHistoryMenu();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Account one Side Chat"));

    act(() => {
      queryClient.setQueryData(queryKeys.auth.session, {
        session: { id: "session-2", userId: "user-2" },
        user: { id: "user-2", email: "same@example.com", name: "Same User" },
      });
    });
    await vi.waitFor(() => expect(chatsApi.listSideChats).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.querySelector("[data-testid='side-chat-history-trigger']")).toBeNull());
    expect(document.body.textContent).not.toContain("Account one Side Chat");
    expect(queryClient.getQueryData(secondKey)).toBeUndefined();

    await act(async () => {
      resolveSecondPage(historyPage(secondConversation));
    });
    await vi.waitFor(() => expect(host.querySelector("[data-testid='side-chat-history-trigger']")).not.toBeNull());

    openHistoryMenu();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Account two Side Chat"));
    expect(document.body.textContent).not.toContain("Account one Side Chat");
    expect(queryClient.getQueryData<{ pages: SideChatHistoryPage[] }>(firstKey)?.pages[0]?.items[0]?.title)
      .toBe("Account one Side Chat");
    expect(queryClient.getQueryData<{ pages: SideChatHistoryPage[] }>(secondKey)?.pages[0]?.items[0]?.title)
      .toBe("Account two Side Chat");
  });
});
