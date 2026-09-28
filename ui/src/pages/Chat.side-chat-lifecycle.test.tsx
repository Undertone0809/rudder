// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  readSideChatSendDraft,
  saveSideChatSendDraft,
} from "@/lib/side-chat-draft-storage";
import {
  sideChatGenerationScopeKey,
  sidePanelTargetKey,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { useChatSideChatLifecycle } from "./Chat.side-chat-lifecycle";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  sidePanel: {
    principalId: "user-1",
    closeTarget: vi.fn(),
  },
  destroySideChat: vi.fn(async () => undefined),
  pushToast: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/context/SidePanelContext", () => ({
  useSidePanel: () => mocks.sidePanel,
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mocks.pushToast }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/org/org-1/chat/parent-1" }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    destroySideChat: mocks.destroySideChat,
    keepSideChat: vi.fn(),
  },
}));

const storageKey = "rudder:side-chat-send-drafts:v1";
const target = {
  kind: "side_chat",
  sourceConversationId: "parent-1",
  sourceMessageId: null,
  sourcePreview: null,
  conversationId: null,
  clientMutationId: "mutation-1",
  label: "Side Chat",
} satisfies Extract<SidePanelTarget, { kind: "side_chat" }>;
const createdTarget = { ...target, conversationId: "side-chat-1" };

const draft = (body: string) => ({ body, acceptedUserMessageId: null });

function saveDraftScopeVariants() {
  saveSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1", draft("Discard this Side Chat draft."));
  saveSideChatSendDraft("user-2", "org-1", "parent-1", "mutation-1", draft("Keep the other principal draft."));
  saveSideChatSendDraft("user-1", "org-2", "parent-1", "mutation-1", draft("Keep the other org draft."));
  saveSideChatSendDraft("user-1", "org-1", "parent-2", "mutation-1", draft("Keep the other source draft."));
  saveSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-2", draft("Keep the other mutation draft."));
}

let closeSideChatTab: ((tab: Extract<SidePanelTarget, { kind: "side_chat" }>) => Promise<void>) | null = null;
let registerSideChatCloseHandler: (
  scopeKey: string,
  handler: (() => Promise<string | null>) | null,
) => void;
let root: Root | null = null;
let container: HTMLDivElement;
let queryClient: QueryClient;

function LifecycleHarness() {
  ({ closeSideChatTab, registerSideChatCloseHandler } = useChatSideChatLifecycle("org-1"));
  return null;
}

describe("Chat Side Chat lifecycle", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    mocks.sidePanel.closeTarget.mockClear();
    mocks.destroySideChat.mockClear();
    mocks.pushToast.mockClear();
    closeSideChatTab = null;
    registerSideChatCloseHandler = () => undefined;
    container = document.createElement("div");
    document.body.append(container);
    queryClient = new QueryClient();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <LifecycleHarness />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    queryClient.clear();
    container.remove();
    window.localStorage.removeItem(storageKey);
    root = null;
  });

  it("clears an unsent draft when the provisional tab closes before its view handler registers", async () => {
    saveDraftScopeVariants();

    expect(closeSideChatTab).toBeTypeOf("function");
    await act(async () => {
      await closeSideChatTab?.(target);
    });

    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toBeNull();
    expect(readSideChatSendDraft("user-2", "org-1", "parent-1", "mutation-1")?.body).toBe("Keep the other principal draft.");
    expect(readSideChatSendDraft("user-1", "org-2", "parent-1", "mutation-1")?.body).toBe("Keep the other org draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-2", "mutation-1")?.body).toBe("Keep the other source draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-2")?.body).toBe("Keep the other mutation draft.");
    expect(mocks.destroySideChat).not.toHaveBeenCalled();
    expect(mocks.sidePanel.closeTarget).toHaveBeenCalledWith(sidePanelTargetKey(target));
  });

  it("clears only the exact draft after fallback destroy succeeds for a created conversation", async () => {
    saveDraftScopeVariants();

    await act(async () => {
      await closeSideChatTab?.(createdTarget);
    });

    expect(mocks.destroySideChat).toHaveBeenCalledWith("side-chat-1");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toBeNull();
    expect(readSideChatSendDraft("user-2", "org-1", "parent-1", "mutation-1")?.body).toBe("Keep the other principal draft.");
    expect(readSideChatSendDraft("user-1", "org-2", "parent-1", "mutation-1")?.body).toBe("Keep the other org draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-2", "mutation-1")?.body).toBe("Keep the other source draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-2")?.body).toBe("Keep the other mutation draft.");
    expect(mocks.sidePanel.closeTarget).toHaveBeenCalledWith(sidePanelTargetKey(createdTarget));
  });

  it("clears the exact draft after its registered view close handler succeeds", async () => {
    const closeHandler = vi.fn(async () => "side-chat-1");
    saveDraftScopeVariants();
    registerSideChatCloseHandler(sideChatGenerationScopeKey("org-1", createdTarget), closeHandler);

    await act(async () => {
      await closeSideChatTab?.(createdTarget);
    });

    expect(closeHandler).toHaveBeenCalledOnce();
    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toBeNull();
    expect(readSideChatSendDraft("user-2", "org-1", "parent-1", "mutation-1")?.body).toBe("Keep the other principal draft.");
    expect(readSideChatSendDraft("user-1", "org-2", "parent-1", "mutation-1")?.body).toBe("Keep the other org draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-2", "mutation-1")?.body).toBe("Keep the other source draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-2")?.body).toBe("Keep the other mutation draft.");
    expect(mocks.sidePanel.closeTarget).toHaveBeenCalledWith(sidePanelTargetKey(createdTarget));
  });

  it.each([
    [404, null],
    [409, { details: { code: "side_chat_kept" } }],
    [410, null],
  ] as const)("clears the exact draft when destroy returns terminal %i", async (status, body) => {
    saveDraftScopeVariants();
    mocks.destroySideChat.mockRejectedValueOnce(new ApiError("Terminal close", status, body));

    await act(async () => {
      await closeSideChatTab?.(createdTarget);
    });

    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toBeNull();
    expect(readSideChatSendDraft("user-2", "org-1", "parent-1", "mutation-1")?.body).toBe("Keep the other principal draft.");
    expect(readSideChatSendDraft("user-1", "org-2", "parent-1", "mutation-1")?.body).toBe("Keep the other org draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-2", "mutation-1")?.body).toBe("Keep the other source draft.");
    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-2")?.body).toBe("Keep the other mutation draft.");
    expect(mocks.sidePanel.closeTarget).toHaveBeenCalledWith(sidePanelTargetKey(createdTarget));
  });

  it("keeps the draft when destroying a created conversation fails transiently", async () => {
    saveSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1", draft("Keep this draft until close succeeds."));
    mocks.destroySideChat.mockRejectedValueOnce(new ApiError("Unavailable", 503, null));

    await act(async () => {
      await closeSideChatTab?.(createdTarget);
    });

    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")?.body)
      .toBe("Keep this draft until close succeeds.");
    expect(mocks.sidePanel.closeTarget).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not close Side Chat" }));
  });
});
