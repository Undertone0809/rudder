// @vitest-environment jsdom

import type { MainWorkbenchTarget } from "@/lib/main-workbench-state";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  MainWorkbenchProvider,
  useMainWorkbench,
  useOrganizationMainWorkbench,
} from "./MainWorkbenchContext";
import {
  createLiveSurfaceRuntimeId,
  LiveSurfaceAnchor,
  LiveSurfaceRuntimeProvider,
} from "./LiveSurfaceRuntimeContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let organizationA: ReturnType<typeof useOrganizationMainWorkbench> | null = null;
let organizationB: ReturnType<typeof useOrganizationMainWorkbench> | null = null;
let globalWorkbench: ReturnType<typeof useMainWorkbench> | null = null;

function Probe() {
  const a = useOrganizationMainWorkbench("org-a");
  const b = useOrganizationMainWorkbench("org-b");
  const global = useMainWorkbench();
  useEffect(() => {
    organizationA = a;
    organizationB = b;
    globalWorkbench = global;
  }, [a, b, global]);
  return null;
}

function browserTarget(viewInstanceId: string): Extract<MainWorkbenchTarget, { kind: "browser" }> {
  return {
    kind: "browser",
    label: "Same URL",
    tabId: `browser-${viewInstanceId}`,
    url: "https://example.com/shared",
    viewInstanceId,
  };
}

function PhysicalBrowserFixtures({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => {
    const target = browserTarget(`physical-${index}`);
    const runtimeId = createLiveSurfaceRuntimeId("org-a", target);
    return (
      <LiveSurfaceAnchor
        key={runtimeId}
        active
        hostId={`side-host-${index}`}
        ownerId={`side:chat-source:${target.viewInstanceId}`}
        runtimeId={runtimeId}
        target={target}
      />
    );
  });
}

describe("MainWorkbenchProvider", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    organizationA = null;
    organizationB = null;
    globalWorkbench = null;
  });

  function renderProvider(physicalBrowserCount = 0) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <MainWorkbenchProvider>
          <LiveSurfaceRuntimeProvider>
            <PhysicalBrowserFixtures count={physicalBrowserCount} />
            <Probe />
          </LiveSurfaceRuntimeProvider>
        </MainWorkbenchProvider>,
      );
    });
  }

  it("keeps exact same-URL instances and organizations independent", () => {
    renderProvider();

    act(() => {
      organizationA?.createSessionTab({
        viewInstanceId: "view-a",
        runtimeId: "runtime-a",
        target: browserTarget("view-a"),
        originContextKey: "chat:source",
      });
      organizationA?.createSessionTab({
        viewInstanceId: "view-b",
        runtimeId: "runtime-b",
        target: browserTarget("view-b"),
        originContextKey: "chat:source",
      });
      organizationB?.createSessionTab({
        viewInstanceId: "view-c",
        runtimeId: "runtime-c",
        target: browserTarget("view-c"),
        originContextKey: "chat:other",
      });
    });

    expect(organizationA?.tabOrder).toEqual(["view-a", "view-b"]);
    expect(organizationA?.activeViewInstanceId).toBe("view-b");
    expect(organizationB?.tabOrder).toEqual(["view-c"]);
    expect(globalWorkbench?.getState().organizations["org-a"]?.tabOrder).toEqual([
      "view-a",
      "view-b",
    ]);
  });

  it("keeps close and Saved binding lifecycle orthogonal", () => {
    renderProvider();

    act(() => {
      organizationA?.openSavedTab("saved-a", {
        viewInstanceId: "view-a",
        runtimeId: "runtime-a",
        target: browserTarget("view-a"),
        originContextKey: "chat:source",
      });
      organizationA?.unbindSavedView("view-a", "saved-a");
    });
    expect(organizationA?.tabsByViewInstanceId["view-a"]?.savedViewId).toBeNull();

    act(() => {
      organizationA?.bindSavedView("view-a", "saved-b");
    });
    expect(organizationA?.tabsByViewInstanceId["view-a"]?.savedViewId).toBe("saved-b");

    act(() => {
      organizationA?.closeTab("view-a");
    });
    expect(organizationA?.tabsByViewInstanceId["view-a"]).toBeUndefined();
  });

  it("enforces the organization Browser capacity without reusing an exact tab", () => {
    renderProvider();
    const admissions: Array<ReturnType<NonNullable<typeof organizationA>["createSessionBrowser"]>> = [];

    act(() => {
      for (let index = 0; index < 9; index += 1) {
        admissions.push(organizationA!.createSessionBrowser(browserTarget(`view-${index}`)));
      }
    });

    expect(admissions.slice(0, 8).every((result) => result.admitted)).toBe(true);
    expect(admissions[8]).toEqual({
      admitted: false,
      reason: "browser_capacity",
      viewInstanceId: null,
    });
    expect(organizationA?.tabs).toHaveLength(8);
    expect(organizationA?.canCreateBrowser).toBe(false);
  });

  it("shares the physical Side and Main Browser cap while exempting exact transfer", () => {
    renderProvider(8);
    const exactTarget = browserTarget("physical-0");
    const exactRuntimeId = createLiveSurfaceRuntimeId("org-a", exactTarget);
    let exactTransfer:
      | ReturnType<NonNullable<typeof organizationA>["createSessionTab"]>
      | undefined;
    let coldReopen:
      | ReturnType<NonNullable<typeof organizationA>["openSavedTab"]>
      | undefined;

    act(() => {
      exactTransfer = organizationA?.createSessionTab({
        viewInstanceId: exactTarget.viewInstanceId,
        runtimeId: exactRuntimeId,
        target: exactTarget,
        originContextKey: "chat:source",
      });
      const coldTarget = browserTarget("cold-reopen");
      coldReopen = organizationA?.openSavedTab("saved-cold", {
        viewInstanceId: coldTarget.viewInstanceId,
        runtimeId: createLiveSurfaceRuntimeId("org-a", coldTarget),
        target: coldTarget,
        originContextKey: "messenger:saved",
      });
    });

    expect(exactTransfer).toEqual({
      admitted: true,
      reason: null,
      viewInstanceId: "physical-0",
    });
    expect(coldReopen).toEqual({
      admitted: false,
      reason: "browser_capacity",
      viewInstanceId: null,
    });
    expect(organizationA?.canCreateBrowser).toBe(false);
  });
});
