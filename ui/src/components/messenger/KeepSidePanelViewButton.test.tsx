// @vitest-environment jsdom

import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepSidePanelViewButton } from "./KeepSidePanelViewButton";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockKeepSavedView = vi.hoisted(() => vi.fn());
const mockListCustomGroups = vi.hoisted(() => vi.fn());
const mockUpdateSavedView = vi.hoisted(() => vi.fn());
const mockIssueGet = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockGetMoveState = vi.hoisted(() => vi.fn());
const mockPromote = vi.hoisted(() => vi.fn());
const mockRetryPromotion = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: { get: mockIssueGet },
}));

vi.mock("@/api/messenger", () => ({
  messengerApi: {
    keepSavedView: mockKeepSavedView,
    listCustomGroups: mockListCustomGroups,
    updateSavedView: mockUpdateSavedView,
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/context/SavedViewPromotionContext", () => ({
  useOptionalSavedViewPromotion: () => ({
    getMoveState: mockGetMoveState,
    isMoving: () => false,
    promote: mockPromote,
    retry: mockRetryPromotion,
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, disabled, onClick }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => <button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
}));

const organizationId = "10000000-0000-4000-8000-000000000001";
const chatId = "20000000-0000-4000-8000-000000000001";
const groupA = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Research",
  entries: [],
};
const groupB = {
  id: "40000000-0000-4000-8000-000000000001",
  name: "Review",
  entries: [],
};
const savedViewResult = {
  savedView: { id: "50000000-0000-4000-8000-000000000001" },
  group: { id: groupA.id, name: groupA.name },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderButton(props: {
  contextKey: string;
  target: SidePanelTarget;
}) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
  }
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <KeepSidePanelViewButton
          contextKey={props.contextKey}
          organizationId={organizationId}
          target={props.target}
        />
      </QueryClientProvider>,
    );
  });
}

function keepButton() {
  const button = host?.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-keep-in-messenger"]');
  if (!button) throw new Error("Keep button not found");
  return button;
}

async function clickAndWait(button: HTMLButtonElement, expectedCallCount: number) {
  await act(async () => {
    button.click();
    await flush();
  });
  await vi.waitFor(() => {
    expect(mockKeepSavedView).toHaveBeenCalledTimes(expectedCallCount);
    expect(keepButton().disabled).toBe(false);
  });
}

function mutationIdAt(callIndex: number) {
  return mockKeepSavedView.mock.calls[callIndex]?.[1]?.clientMutationId as string;
}

beforeEach(() => {
  mockKeepSavedView.mockReset();
  mockListCustomGroups.mockReset();
  mockUpdateSavedView.mockReset();
  mockIssueGet.mockReset();
  mockPushToast.mockReset();
  mockGetMoveState.mockReset().mockReturnValue({
    error: null,
    promotionId: null,
    retryable: false,
    status: "idle",
  });
  mockPromote.mockReset().mockImplementation((request) => (
    mockKeepSavedView(request.organizationId, request.input)
  ));
  mockRetryPromotion.mockReset();
  mockListCustomGroups.mockResolvedValue({ groups: [groupA, groupB] });
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  root = null;
  queryClient = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
});

describe("KeepSidePanelViewButton mutation intents", () => {
  it("reuses the same mutation id when an exact failed intent is retried", async () => {
    mockKeepSavedView
      .mockRejectedValueOnce(new Error("Connection lost after send"))
      .mockResolvedValueOnce(savedViewResult);
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });

    await clickAndWait(keepButton(), 1);
    await clickAndWait(keepButton(), 2);

    expect(mutationIdAt(1)).toBe(mutationIdAt(0));
  });

  it("retires a completed intent so a later Keep gets a fresh mutation id", async () => {
    mockKeepSavedView.mockResolvedValue(savedViewResult);
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });

    await clickAndWait(keepButton(), 1);
    await clickAndWait(keepButton(), 2);

    expect(mutationIdAt(1)).not.toBe(mutationIdAt(0));
  });

  it("uses a fresh mutation id when the same Browser tab navigates to a new URL", async () => {
    mockKeepSavedView.mockRejectedValue(new Error("Offline"));
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "browser",
        tabId: "browser-tab-1",
        viewInstanceId: "browser-tab-1",
        url: "https://example.com/first",
        label: "example.com",
      },
    });
    await clickAndWait(keepButton(), 1);

    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "browser",
        tabId: "browser-tab-1",
        viewInstanceId: "browser-tab-1",
        url: "https://example.com/second",
        label: "example.com",
      },
    });
    await clickAndWait(keepButton(), 2);

    expect(mutationIdAt(1)).not.toBe(mutationIdAt(0));
  });

  it("uses a fresh mutation id when metadata changes on the same view instance", async () => {
    mockKeepSavedView.mockRejectedValue(new Error("Offline"));
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Original title",
        viewInstanceId: "file-view-1",
      },
    });
    await clickAndWait(keepButton(), 1);

    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Renamed title",
        viewInstanceId: "file-view-1",
      },
    });
    await clickAndWait(keepButton(), 2);

    expect(mutationIdAt(1)).not.toBe(mutationIdAt(0));
  });

  it("uses a fresh mutation id when a failed global intent chooses a different group", async () => {
    mockKeepSavedView.mockRejectedValue(new Error("Offline"));
    renderButton({
      contextKey: "organization:global",
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });
    await act(async () => {
      await vi.waitFor(() => expect(host?.textContent).toContain(groupA.name));
    });

    const groupButton = (name: string) => Array.from(host!.querySelectorAll("button"))
      .find((button) => button.textContent === name) as HTMLButtonElement;
    await clickAndWait(groupButton(groupA.name), 1);
    await clickAndWait(groupButton(groupB.name), 2);

    expect(mutationIdAt(1)).not.toBe(mutationIdAt(0));
  });

  it("bounds failed intent retention and evicts the oldest retry id", async () => {
    mockKeepSavedView.mockRejectedValue(new Error("Offline"));
    for (let index = 0; index < 33; index += 1) {
      renderButton({
        contextKey: `chat:${chatId}`,
        target: {
          kind: "library_file",
          filePath: "docs/spec.md",
          label: `Spec version ${index}`,
          viewInstanceId: "file-view-1",
        },
      });
      await clickAndWait(keepButton(), index + 1);
    }
    const oldestMutationId = mutationIdAt(0);

    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec version 0",
        viewInstanceId: "file-view-1",
      },
    });
    await clickAndWait(keepButton(), 34);

    expect(mutationIdAt(33)).not.toBe(oldestMutationId);
  });

  it("shows an actionable retry when the Issue anchor cannot be resolved", async () => {
    mockIssueGet
      .mockRejectedValueOnce(new Error("Issue lookup failed"))
      .mockResolvedValueOnce({ id: "60000000-0000-4000-8000-000000000001" });
    renderButton({
      contextKey: "issue:RUD-42",
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });

    await act(async () => {
      await vi.waitFor(() => expect(host?.textContent).toContain("Could not load this Issue"));
    });
    const retry = Array.from(host!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Retry Issue lookup"));
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await vi.waitFor(() => expect(mockIssueGet).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(keepButton().disabled).toBe(false));
    });
  });

  it("shows and invokes the retained move retry instead of starting a new keep", async () => {
    mockGetMoveState.mockReturnValue({
      error: "Keep response timed out",
      promotionId: "promotion-a",
      retryable: true,
      status: "commit_unknown",
    });
    mockRetryPromotion.mockResolvedValue(savedViewResult);
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });

    expect(keepButton().textContent).toContain("Retry move");
    await act(async () => {
      keepButton().click();
      await vi.waitFor(() => expect(mockRetryPromotion).toHaveBeenCalledWith(
        organizationId,
        `chat:${chatId}`,
        expect.objectContaining({ viewInstanceId: "file-view-1" }),
      ));
    });
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("retires the original mutation intent after a retained retry succeeds", async () => {
    let retryable = false;
    let firstMutationId: string | null = null;
    mockGetMoveState.mockImplementation(() => ({
      clientMutationId: retryable ? firstMutationId : null,
      error: retryable ? "Keep response timed out" : null,
      promotionId: retryable ? "promotion-a" : null,
      retryable,
      status: retryable ? "commit_unknown" : "idle",
    }));
    mockPromote.mockImplementation((request) => {
      if (!firstMutationId) {
        firstMutationId = request.input.clientMutationId;
        retryable = true;
        return Promise.reject(new Error("Keep response timed out"));
      }
      return Promise.resolve(savedViewResult);
    });
    mockRetryPromotion.mockImplementation(() => {
      retryable = false;
      return Promise.resolve(savedViewResult);
    });
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });

    await act(async () => {
      keepButton().click();
      await vi.waitFor(() => expect(keepButton().textContent)
        .toContain("Retry move"));
    });
    await act(async () => {
      keepButton().click();
      await vi.waitFor(() => expect(mockRetryPromotion).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(keepButton().textContent).toContain("Keep"));
    });
    await act(async () => {
      keepButton().click();
      await vi.waitFor(() => expect(mockPromote).toHaveBeenCalledTimes(2));
    });

    expect(mockPromote.mock.calls[1]?.[0].input.clientMutationId)
      .not.toBe(firstMutationId);
  });

  it("shows group loading failure separately from an empty group list and can retry", async () => {
    mockListCustomGroups
      .mockRejectedValueOnce(new Error("Groups unavailable"))
      .mockResolvedValueOnce({ groups: [groupA, groupB] });
    renderButton({
      contextKey: "organization:global",
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        label: "Spec",
        viewInstanceId: "file-view-1",
      },
    });

    await act(async () => {
      await vi.waitFor(() => expect(host?.textContent).toContain("Could not load Messenger groups"));
    });
    expect(host?.textContent).not.toContain("No groups yet");
    const retry = Array.from(host!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Retry groups"));
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await vi.waitFor(() => expect(host?.textContent).toContain(groupA.name));
    });
  });

  it("leaves Browser recovery metadata to the live side-panel persister", async () => {
    const savedViewId = "70000000-0000-4000-8000-000000000001";
    mockListCustomGroups.mockResolvedValue({
      groups: [{
        ...groupA,
        entries: [{
          id: "browser-entry",
          itemKey: `saved_view:${savedViewId}`,
          item: {
            type: "saved_view",
            savedView: {
              id: savedViewId,
              title: "Old title",
              subtitle: "https://example.com/old",
              favicon: null,
              targetPayload: {
                kind: "browser",
                tabId: "browser-tab-1",
                viewInstanceId: "browser-tab-1",
                url: "https://example.com/old",
              },
            },
          },
        }],
      }],
    });
    mockUpdateSavedView.mockImplementation(async (_orgId, _savedViewId, patch) => ({
      id: savedViewId,
      ...patch,
    }));
    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "browser",
        tabId: "browser-tab-1",
        viewInstanceId: "browser-tab-1",
        url: "https://example.com/old",
        label: "Old title",
      },
    });
    await act(async () => {
      await vi.waitFor(() => expect(mockListCustomGroups).toHaveBeenCalled());
    });

    renderButton({
      contextKey: `chat:${chatId}`,
      target: {
        kind: "browser",
        tabId: "browser-tab-1",
        viewInstanceId: "browser-tab-1",
        url: "https://example.com/newest",
        label: "Newest title",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockUpdateSavedView).not.toHaveBeenCalled();
  });
});
