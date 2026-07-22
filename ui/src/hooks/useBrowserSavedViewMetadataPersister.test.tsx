// @vitest-environment jsdom

import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserSavedViewMetadataPersister } from "./useBrowserSavedViewMetadataPersister";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listCustomGroups = vi.hoisted(() => vi.fn());
const updateSavedView = vi.hoisted(() => vi.fn());
vi.mock("@/api/messenger", () => ({ messengerApi: { listCustomGroups, updateSavedView } }));

type BrowserTarget = Extract<SidePanelTarget, { kind: "browser" }>;
const initialTarget: BrowserTarget = {
  kind: "browser",
  tabId: "tab-a",
  viewInstanceId: "view-a",
  url: "https://a.example/",
  label: "A",
};

const groups = {
  groups: [{
    id: "group-a",
    name: "Group A",
    entries: [{
      id: "entry-a",
      itemKey: "saved-view:saved-a",
      item: {
        type: "saved_view",
        savedView: {
          id: "saved-a",
          title: "A",
          subtitle: "https://a.example/",
          favicon: null,
          targetPayload: {
            kind: "browser",
            tabId: "tab-a",
            viewInstanceId: "view-a",
            url: "https://a.example/",
          },
        },
      },
    }],
  }],
};

function Harness({ targets }: { targets: BrowserTarget[] }) {
  controls = useBrowserSavedViewMetadataPersister({ browserTargets: targets, organizationId: "org-a" });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;
let controls: ReturnType<typeof useBrowserSavedViewMetadataPersister> | null = null;

function render(targets: BrowserTarget[], seedGroups = true) {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (seedGroups) client.setQueryData(queryKeys.messenger.customGroups("org-a"), groups);
  }
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <Harness targets={targets} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  listCustomGroups.mockReset().mockResolvedValue(groups);
  updateSavedView.mockReset().mockResolvedValue({});
});

afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  root = null;
  client = null;
  controls = null;
  host?.remove();
  host = null;
});

describe("useBrowserSavedViewMetadataPersister", () => {
  it("flushes a quick navigation when the saved tab closes before 350ms", async () => {
    render([initialTarget]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    render([{ ...initialTarget, url: "https://b.example/", label: "B" }]);
    render([]);

    await vi.waitFor(() => expect(updateSavedView).toHaveBeenCalledTimes(1));
    expect(updateSavedView).toHaveBeenCalledWith("org-a", "saved-a", expect.objectContaining({
      title: "B",
      subtitle: "https://b.example/",
      target: expect.objectContaining({ url: "https://b.example/" }),
    }));
  });

  it("flushes pending metadata when the panel unmounts", async () => {
    render([initialTarget]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    render([{ ...initialTarget, url: "https://exit.example/", label: "Exit" }]);
    act(() => root?.unmount());
    root = null;

    await vi.waitFor(() => expect(updateSavedView).toHaveBeenCalledWith(
      "org-a",
      "saved-a",
      expect.objectContaining({ title: "Exit" }),
    ));
  });

  it("durably flushes a deep-linked saved tab before custom groups finish loading", async () => {
    let resolveGroups!: (value: typeof groups) => void;
    listCustomGroups.mockReturnValue(new Promise<typeof groups>((resolve) => { resolveGroups = resolve; }));
    const restoredTarget = {
      ...initialTarget,
      savedViewRecovery: {
        id: "saved-a",
        persistedMetadata: {
          target: {
            kind: "browser",
            tabId: "tab-a",
            viewInstanceId: "view-a",
            url: "https://a.example/",
          },
          title: "A",
          subtitle: "https://a.example/",
          favicon: null,
        },
      },
    } as BrowserTarget;

    render([restoredTarget], false);
    render([{ ...restoredTarget, url: "https://deep-link.example/new", label: "Deep link newest" }], false);
    render([], false);

    await expect.poll(() => updateSavedView.mock.calls.length).toBe(1);
    expect(updateSavedView).toHaveBeenCalledWith("org-a", "saved-a", expect.objectContaining({
      title: "Deep link newest",
      target: expect.objectContaining({ url: "https://deep-link.example/new" }),
    }));
    resolveGroups(groups);
  });

  it("stops using deep-link recovery after custom groups confirm the saved view is gone", async () => {
    listCustomGroups.mockResolvedValue({ groups: [] });
    const restoredTarget = {
      ...initialTarget,
      savedViewRecovery: {
        id: "saved-a",
        persistedMetadata: {
          target: {
            kind: "browser",
            tabId: "tab-a",
            viewInstanceId: "view-a",
            url: "https://a.example/",
          },
          title: "A",
          subtitle: "https://a.example/",
          favicon: null,
        },
      },
    } as BrowserTarget;

    render([restoredTarget], false);
    await act(async () => {
      await vi.waitFor(() => expect(listCustomGroups).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(client?.getQueryState(
        queryKeys.messenger.customGroups("org-a"),
      )?.status).toBe("success"));
    });
    render([{ ...restoredTarget, url: "https://removed.example/", label: "Removed" }], false);
    render([], false);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(updateSavedView).not.toHaveBeenCalled();
  });

  it("cancels queued navigation when custom groups confirm deletion before debounce", async () => {
    vi.useFakeTimers();
    try {
      render([initialTarget]);
      await act(async () => { await Promise.resolve(); });
      render([{ ...initialTarget, url: "https://deleted.example/newest", label: "Deleted newest" }]);
      act(() => {
        client!.setQueryData(queryKeys.messenger.customGroups("org-a"), { groups: [] });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      });

      await act(async () => { await controls!.flushAll(); });
      act(() => root?.unmount());
      root = null;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(updateSavedView).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
