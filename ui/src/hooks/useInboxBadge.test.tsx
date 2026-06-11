// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarBadges } from "@rudderhq/shared";
import { useInboxBadge } from "./useInboxBadge";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockApis = vi.hoisted(() => ({
  listThreadPage: vi.fn(),
  getSidebarBadges: vi.fn(),
}));

vi.mock("../api/messenger", () => ({
  messengerApi: {
    listThreadPage: mockApis.listThreadPage,
  },
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: {
    get: mockApis.getSidebarBadges,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createBadges(overrides: Partial<SidebarBadges> = {}): SidebarBadges {
  return {
    inbox: 0,
    approvals: 0,
    failedRuns: 0,
    joinRequests: 0,
    unreadTouchedIssues: 0,
    chatAttention: 0,
    alerts: 0,
    ...overrides,
  };
}

function BadgeProbe({
  orgId,
  onRender,
}: {
  orgId: string;
  onRender: (badge: ReturnType<typeof useInboxBadge>) => void;
}) {
  onRender(useInboxBadge(orgId));
  return null;
}

async function renderWithQueryClient(children: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>,
    );
  });

  return () => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApis.listThreadPage.mockResolvedValue({
    items: [],
    pageInfo: { limit: 10, nextCursor: null, hasMore: false },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useInboxBadge", () => {
  it("keeps badge counts empty until the server sidebar badge response is ready", async () => {
    const sidebarBadges = deferred<SidebarBadges>();
    mockApis.getSidebarBadges.mockReturnValue(sidebarBadges.promise);
    const renders: Array<ReturnType<typeof useInboxBadge>> = [];
    const cleanup = await renderWithQueryClient(
      <BadgeProbe orgId="org-1" onRender={(badge) => renders.push(badge)} />,
    );

    expect(mockApis.getSidebarBadges).toHaveBeenCalledWith("org-1");
    expect(renders.at(-1)).toMatchObject({
      inbox: 0,
      isReady: false,
    });

    await act(async () => {
      sidebarBadges.resolve(createBadges({ inbox: 7, unreadTouchedIssues: 5, chatAttention: 2 }));
      await sidebarBadges.promise;
    });

    expect(renders.at(-1)).toMatchObject({
      inbox: 7,
      unreadTouchedIssues: 5,
      chatAttention: 2,
      isReady: true,
    });

    cleanup();
  });
});
