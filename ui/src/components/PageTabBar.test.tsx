// @vitest-environment jsdom

import { Tabs, TabsContent } from "@/components/ui/tabs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTabBar } from "./PageTabBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: true }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("PageTabBar", () => {
  it("keeps real tab semantics in scrollable mobile mode", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <Tabs value="configuration">
          <PageTabBar
            ariaLabel="Plugin settings sections"
            items={[
              { value: "configuration", label: "Configuration" },
              { value: "status", label: "Status" },
            ]}
            mobileMode="scrollable-tabs"
            value="configuration"
            onValueChange={() => undefined}
          />
          <TabsContent value="configuration">Configuration content</TabsContent>
        </Tabs>,
      );
    });

    const tablist = container.querySelector<HTMLElement>('[role="tablist"]');
    const content = container.querySelector<HTMLElement>('[role="tabpanel"]');
    const labelledBy = content?.getAttribute("aria-labelledby");

    expect(container.querySelector("select")).toBeNull();
    expect(tablist?.getAttribute("aria-label")).toBe("Plugin settings sections");
    expect(tablist?.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(tablist?.parentElement?.parentElement?.className).toContain("overflow-x-auto");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).not.toBeNull();
  });
});
