// @vitest-environment jsdom

import { act, type HTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
    <div data-slot="status-menu" {...props}>{children}</div>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function renderStatusIcon(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(element);
  });

  return container;
}

describe("StatusIcon", () => {
  it("renders Linear-style distinct issue status glyphs", () => {
    const container = renderStatusIcon(
      <div>
        <StatusIcon status="backlog" />
        <StatusIcon status="in_progress" />
        <StatusIcon status="in_review" />
        <StatusIcon status="done" />
        <StatusIcon status="cancelled" />
        <StatusIcon status="blocked" />
      </div>,
    );

    expect(container.querySelector('[data-status="backlog"] [data-slot="status-backlog-ring"]')).toBeTruthy();
    expect(container.querySelector('[data-status="in_progress"] [data-slot="status-progress-arc"]')).toBeTruthy();
    expect(container.querySelector('[data-status="in_review"] [data-slot="status-review-dot"]')).toBeTruthy();
    expect(container.querySelector('[data-status="done"] [data-slot="status-done-check"]')).toBeTruthy();
    expect(container.querySelector('[data-status="cancelled"] [data-slot="status-cancel-mark"]')).toBeTruthy();
    expect(container.querySelector('[data-status="blocked"] [data-slot="status-blocked-mark"]')).toBeTruthy();
  });

  it("keeps todo quiet and unfilled", () => {
    const container = renderStatusIcon(<StatusIcon status="todo" />);
    const icon = container.querySelector('[data-status="todo"]');

    expect(icon?.className).toContain("text-muted-foreground");
    expect(icon?.querySelector("circle")).toBeTruthy();
    expect(icon?.querySelector("[fill='currentColor']")).toBeFalsy();
  });

  it("selects a status from the quiet status menu", () => {
    const onChange = vi.fn();
    const container = renderStatusIcon(<StatusIcon status="todo" onChange={onChange} showLabel />);
    const blockedButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Blocked",
    );

    act(() => {
      blockedButton?.click();
    });

    expect(onChange).toHaveBeenCalledWith("blocked");
  });

  it("marks the current status as selected in the menu", () => {
    const container = renderStatusIcon(<StatusIcon status="in_progress" onChange={vi.fn()} showLabel />);
    const menu = container.querySelector('[data-slot="status-menu"]');
    const selectedRow = container.querySelector('button[role="menuitemradio"][aria-checked="true"]');

    expect(menu?.textContent).toContain("In Progress");
    expect(menu?.innerHTML).not.toContain("rounded-full border-2");
    expect(selectedRow?.textContent).toContain("In Progress");
    expect(selectedRow?.querySelector('[data-slot="status-menu-check"]')).toBeTruthy();
  });
});
