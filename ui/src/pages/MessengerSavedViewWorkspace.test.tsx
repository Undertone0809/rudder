// @vitest-environment jsdom

import { LiveSurfaceRuntimeProvider } from "@/context/LiveSurfaceRuntimeContext";
import { MainWorkbenchProvider } from "@/context/MainWorkbenchContext";
import type { MainWorkbenchState } from "@/lib/main-workbench-state";
import type { MessengerSavedView } from "@rudderhq/shared";
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MessengerSavedViewWorkspace } from "./MessengerSavedViewWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const getSavedView = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/api/messenger", () => ({
  messengerApi: {
    getSavedView,
    listCustomGroups: vi.fn().mockResolvedValue({ groups: [] }),
  },
}));
vi.mock("@/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/router")>()),
  useNavigate: () => navigate,
}));

const savedView: MessengerSavedView = {
  id: "saved-a",
  orgId: "org-a",
  userId: "user-a",
  targetKind: "local_app",
  targetPayload: {
    kind: "local_app",
    desktopInstallationId: "installation-a",
    appPublicId: "public-a",
    localBindingId: "binding-a",
    viewInstanceId: "view-a",
  },
  resourceKey: "local-app",
  instanceId: "view-a",
  canonicalResourceKey: "local-app",
  clientMutationId: null,
  title: "MKT dashboard",
  subtitle: "Local app",
  favicon: null,
  sortOrder: 0,
  hiddenAt: null,
  createdAt: new Date("2026-07-23T00:00:00.000Z"),
  updatedAt: new Date("2026-07-23T00:00:00.000Z"),
};

const savedBrowserView: MessengerSavedView = {
  ...savedView,
  id: "saved-browser-a",
  targetKind: "browser",
  targetPayload: {
    kind: "browser",
    tabId: "saved-browser-tab",
    url: "https://example.com/saved",
    viewInstanceId: "saved-browser-instance",
  },
  resourceKey: "browser-tab:saved-browser-tab",
  instanceId: "saved-browser-instance",
  canonicalResourceKey: "browser-tab:saved-browser-tab",
  title: "Saved browser",
  subtitle: "https://example.com/saved",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;

beforeAll(() => {
  notifyManager.setNotifyFunction((callback) => act(callback));
});

afterAll(() => {
  notifyManager.setNotifyFunction((callback) => callback());
});

async function waitForAct(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assertion();
  });
}

async function renderWorkspace(
  initialState?: MainWorkbenchState,
  savedViewId = "saved-a",
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <LiveSurfaceRuntimeProvider>
          <MainWorkbenchProvider initialState={initialState}>
            <MessengerSavedViewWorkspace
              organizationId="org-a"
              savedViewId={savedViewId}
            />
          </MainWorkbenchProvider>
        </LiveSurfaceRuntimeProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  getSavedView.mockReset().mockResolvedValue(savedView);
  navigate.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  root = null;
  client = null;
  host?.remove();
  host = null;
  Reflect.deleteProperty(window, "desktopShell");
});

describe("MessengerSavedViewWorkspace", () => {
  it("opens the exact Local App instance in Main without probing or starting it", async () => {
    const localApps = {
      supported: true,
      list: vi.fn(),
      status: vi.fn(),
      start: vi.fn(),
    };
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { localApps },
    });
    await renderWorkspace();

    await waitForAct(() => expect(
      host?.querySelector('[data-view-instance-id="view-a"]'),
    ).not.toBeNull());
    expect(localApps.list).not.toHaveBeenCalled();
    expect(localApps.status).not.toHaveBeenCalled();
    expect(localApps.start).not.toHaveBeenCalled();
  });

  it("keeps a binding from another installation as an isolated Main tab", async () => {
    getSavedView.mockResolvedValue({
      ...savedView,
      targetPayload: {
        ...savedView.targetPayload,
        desktopInstallationId: "installation-other",
      },
    });
    await renderWorkspace();

    await waitForAct(() => expect(
      host?.querySelector('[data-view-instance-id="view-a"]'),
    ).not.toBeNull());
    expect(host?.querySelector(
      '[data-testid="messenger-saved-view-unavailable"]',
    )).toBeNull();
  });

  it("keeps Saved View loading failures inside Main and retries them", async () => {
    getSavedView
      .mockRejectedValueOnce(new Error("Saved View unavailable"))
      .mockResolvedValueOnce(savedView);
    await renderWorkspace();
    await waitForAct(() => expect(
      host?.querySelector('[data-testid="messenger-saved-view-error"]')
        ?.textContent,
    ).toContain("Saved View unavailable"));

    await act(async () => {
      Array.from(host!.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Retry"))
        ?.click();
    });
    await waitForAct(() => expect(
      host?.querySelector('[data-view-instance-id="view-a"]'),
    ).not.toBeNull());
  });

  it("shows a recoverable capacity state for a cold Browser reopen", async () => {
    getSavedView.mockResolvedValue(savedBrowserView);
    const runtimesById = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const viewInstanceId = `view-${index}`;
        const target = {
          kind: "browser" as const,
          tabId: `tab-${index}`,
          url: `https://example.com/${index}`,
          label: `Browser ${index}`,
          viewInstanceId,
        };
        return [
          `runtime-${index}`,
          {
            id: `runtime-${index}`,
            organizationId: "org-a",
            viewInstanceId,
            targetKind: "browser" as const,
            target,
            host: { kind: "main" as const, organizationId: "org-a" },
          },
        ];
      }),
    );
    await renderWorkspace(
      {
        organizations: {
          "org-a": {
            activeViewInstanceId: null,
            tabOrder: [],
            tabsByViewInstanceId: {},
            runtimesById,
            promotionsById: {},
          },
        },
      },
      "saved-browser-a",
    );

    await waitForAct(() => expect(
      host?.querySelector(
        '[data-testid="messenger-saved-view-capacity-error"]',
      ),
    ).not.toBeNull());
    expect(host?.querySelector(
      '[data-view-instance-id="saved-browser-instance"]',
    )).toBeNull();
  });

  it.each([
    "claim_failed",
    "commit_unknown",
    "server_failed",
    "pending",
    "reconciling",
    "claiming",
    "detaching",
  ] as const)(
    "does not cold-open a retained %s promotion source as a duplicate Main tab",
    async (status) => {
      const sourceTarget = {
        kind: "local_app" as const,
        desktopInstallationId: "installation-a",
        appPublicId: "public-a",
        localBindingId: "binding-a",
        label: "MKT dashboard",
        viewInstanceId: "view-a",
      };
      const promotion = {
        id: "promotion-a",
        organizationId: "org-a",
        clientMutationId: "mutation-a",
        status,
        source: {
          viewInstanceId: "view-a",
          savedViewId: status === "pending"
              || status === "server_failed"
              || status === "commit_unknown"
            ? null
            : "saved-a",
          sourceRevision: 2,
          target: sourceTarget,
          originContextKey: "chat:chat-a",
          runtimeId: "runtime-a",
        },
        ...(status === "claim_failed"
          || status === "claiming"
          || status === "detaching"
          ? { savedViewId: "saved-a" }
          : {}),
        ...(status === "claim_failed"
          || status === "commit_unknown"
          || status === "server_failed"
          ? { error: "retry required" }
          : {}),
        ...(status === "detaching"
          ? { rollback: { activeViewInstanceId: null, tab: null } }
          : {}),
      };
      await renderWorkspace({
        organizations: {
          "org-a": {
            activeViewInstanceId: null,
            tabOrder: [],
            tabsByViewInstanceId: {},
            // Hydration must be guarded by the retained attempt itself rather
            // than relying on a coincidental runtime-host conflict.
            runtimesById: {},
            promotionsById: {
              "promotion-a": promotion,
            },
          },
        },
      } as MainWorkbenchState);

      await waitForAct(() => expect(getSavedView).toHaveBeenCalled());
      expect(host?.querySelector('[data-view-instance-id="view-a"]'))
        .toBeNull();
    },
  );

  it("does not let a retained promotion for another exact instance block hydration", async () => {
    await renderWorkspace({
      organizations: {
        "org-a": {
          activeViewInstanceId: null,
          tabOrder: [],
          tabsByViewInstanceId: {},
          runtimesById: {},
          promotionsById: {
            "promotion-other": {
              id: "promotion-other",
              organizationId: "org-a",
              clientMutationId: "mutation-other",
              status: "pending",
              source: {
                viewInstanceId: "view-other",
                savedViewId: null,
                sourceRevision: 1,
                target: {
                  kind: "local_app",
                  desktopInstallationId: "installation-a",
                  appPublicId: "public-other",
                  localBindingId: "binding-other",
                  label: "Other app",
                  viewInstanceId: "view-other",
                },
                originContextKey: "chat:chat-a",
                runtimeId: "runtime-other",
              },
            },
          },
        },
      },
    });

    await waitForAct(() => expect(
      host?.querySelector('[data-view-instance-id="view-a"]'),
    ).not.toBeNull());
  });

  it("does not let the same view id from another target kind block hydration", async () => {
    await renderWorkspace({
      organizations: {
        "org-a": {
          activeViewInstanceId: null,
          tabOrder: [],
          tabsByViewInstanceId: {},
          runtimesById: {},
          promotionsById: {
            "promotion-browser": {
              id: "promotion-browser",
              organizationId: "org-a",
              clientMutationId: "mutation-browser",
              status: "pending",
              source: {
                viewInstanceId: "view-a",
                savedViewId: null,
                sourceRevision: 1,
                target: {
                  kind: "browser",
                  tabId: "tab-a",
                  url: "https://example.com",
                  label: "Example",
                  viewInstanceId: "view-a",
                },
                originContextKey: "chat:chat-a",
                runtimeId: "runtime-browser",
              },
            },
          },
        },
      },
    });

    await waitForAct(() => expect(
      host?.querySelector('[data-view-instance-id="view-a"]'),
    ).not.toBeNull());
  });
});
