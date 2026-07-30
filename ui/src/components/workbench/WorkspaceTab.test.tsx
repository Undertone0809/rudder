// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTab } from "./WorkspaceTab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("WorkspaceTab", () => {
  it("uses the shared active tab semantics and delegates activation", () => {
    const onActivate = vi.fn();
    act(() => {
      root.render(
        <WorkspaceTab
          active
          focused
          icon={<span aria-hidden>⌂</span>}
          id="tab-home"
          label="Home"
          onActivate={onActivate}
          onFocus={() => undefined}
          onKeyDown={() => undefined}
          panelId="panel-home"
        />,
      );
    });

    const tab = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.getAttribute("aria-controls")).toBe("panel-home");
    expect(tab.tabIndex).toBe(0);
    act(() => tab.click());
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("keeps close secondary and stops close clicks from activating the tab", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <WorkspaceTab
          active={false}
          focused={false}
          icon={<span aria-hidden>⌂</span>}
          id="tab-crm"
          label="CRM"
          onActivate={onActivate}
          onClose={onClose}
          onFocus={() => undefined}
          onKeyDown={() => undefined}
          panelId="panel-crm"
        />,
      );
    });

    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close CRM tab"]')!;
    act(() => close.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('[role="tab"]')!.tabIndex).toBe(-1);
  });
});
