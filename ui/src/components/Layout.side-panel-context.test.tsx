// @vitest-environment jsdom

import type { AuthSession } from "@/api/auth";
import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import { queryKeys } from "@/lib/queryKeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSidePanelRouteContextReady,
  SidePanelRouteContextBinder,
} from "./SidePanelRouteContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const organizationSelection = vi.hoisted(() => {
  let selectedOrganizationId: string | null = "org-a";
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => selectedOrganizationId,
    set: (next: string) => {
      selectedOrganizationId = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/context/OrganizationContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/context/OrganizationContext")>();
  return {
    ...actual,
    useOptionalOrganization: () => ({
      selectedOrganizationId: useSyncExternalStore(
        organizationSelection.subscribe,
        organizationSelection.getSnapshot,
        organizationSelection.getSnapshot,
      ),
    }),
  };
});

const contextKey = "chat:route-collision";
const observations: Array<{
  ready: boolean;
  routeOrganizationId: string | null;
  visibleLabels: string[];
}> = [];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function SeedSidePanelOwners() {
  const sidePanel = useSidePanel();
  const initialized = useRef(false);

  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    sidePanel.setContextKey(contextKey, "org-a");
    sidePanel.openTargetForContext(contextKey, {
      kind: "issue",
      issueId: "same-target",
      ref: null,
      commentId: null,
      label: "Organization A target",
    }, undefined, "org-a");
    sidePanel.openTargetForContext(contextKey, {
      kind: "issue",
      issueId: "same-target",
      ref: null,
      commentId: null,
      label: "Organization B target",
    }, undefined, "org-b");
  }, [sidePanel]);

  return null;
}

function RouteProbe() {
  const sidePanel = useSidePanel();
  const routeOrganizationId = useSyncExternalStore(
    organizationSelection.subscribe,
    organizationSelection.getSnapshot,
    organizationSelection.getSnapshot,
  );
  const ready = isSidePanelRouteContextReady({
    sidePanelContextKey: sidePanel.contextKey,
    sidePanelOwnerOrganizationId: sidePanel.ownerOrganizationId,
    routeContextKey: contextKey,
    routeOrganizationId,
  });
  const visibleLabels = ready ? sidePanel.tabs.map((target) => target.label) : [];
  observations.push({ ready, routeOrganizationId, visibleLabels });

  return (
    <output data-testid="route-panel">
      {ready ? visibleLabels.join(",") : "pending"}
    </output>
  );
}

function RouteTree() {
  const routeOrganizationId = useSyncExternalStore(
    organizationSelection.subscribe,
    organizationSelection.getSnapshot,
    organizationSelection.getSnapshot,
  );

  return (
    <>
      <SeedSidePanelOwners />
      <SidePanelRouteContextBinder
        contextKey={contextKey}
        organizationId={routeOrganizationId}
        preserveHold={false}
      />
      <RouteProbe />
    </>
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  queryClient?.clear();
  queryClient = null;
  observations.length = 0;
  organizationSelection.set("org-a");
  window.localStorage.removeItem(
    "rudder:side-chat-panel-state:v1:user-route-test:org-org-a:chat%3Aroute-collision",
  );
  window.localStorage.removeItem(
    "rudder:side-chat-panel-state:v1:user-route-test:org-org-b:chat%3Aroute-collision",
  );
});

describe("Side Panel route owner readiness", () => {
  it("hides the previous organization's same-key target until the route binder selects its owner", () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.auth.session, {
      session: { id: "session-route-test", userId: "user-route-test" },
      user: { id: "user-route-test", email: null, name: null },
    } satisfies AuthSession);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient!}>
          <SidePanelProvider>
            <RouteTree />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector("[data-testid='route-panel']")?.textContent)
      .toBe("Organization A target");

    act(() => organizationSelection.set("org-b"));

    expect(observations).toContainEqual({
      ready: false,
      routeOrganizationId: "org-b",
      visibleLabels: [],
    });
    expect(container.querySelector("[data-testid='route-panel']")?.textContent)
      .toBe("Organization B target");
    expect(observations.some((observation) => (
      observation.routeOrganizationId === "org-b"
      && observation.visibleLabels.includes("Organization A target")
    ))).toBe(false);
  });
});
