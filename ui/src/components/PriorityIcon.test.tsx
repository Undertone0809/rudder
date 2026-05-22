// @vitest-environment jsdom

import { act, type HTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriorityIcon } from "./PriorityIcon";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
    <div data-slot="priority-menu" {...props}>{children}</div>
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

function renderPriorityIcon(element: ReactNode) {
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

describe("PriorityIcon", () => {
  it("renders the replacement Urgent priority label with bar glyph", () => {
    const container = renderPriorityIcon(<PriorityIcon priority="critical" showLabel />);

    expect(container.textContent).toContain("Urgent");
    expect(container.textContent).not.toContain("Critical");
    expect(container.textContent).not.toContain("Flag");
    expect(container.querySelector('[data-slot="priority-bars-icon"]')?.children).toHaveLength(4);
  });

  it("dims inactive bars for lower priorities", () => {
    const container = renderPriorityIcon(<PriorityIcon priority="low" />);
    const bars = Array.from(container.querySelector('[data-slot="priority-bars-icon"]')?.children ?? []);

    expect(bars.filter((bar) => bar.className.includes("opacity-25"))).toHaveLength(3);
  });

  it("selects a priority from the replacement menu", () => {
    const onChange = vi.fn();
    const container = renderPriorityIcon(<PriorityIcon priority="medium" onChange={onChange} showLabel />);
    const highButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "High",
    );

    act(() => {
      highButton?.click();
    });

    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("renders priority choices as quiet menu rows with a selected check", () => {
    const container = renderPriorityIcon(<PriorityIcon priority="high" onChange={vi.fn()} showLabel />);
    const menu = container.querySelector('[data-slot="priority-menu"]');
    const selectedRow = container.querySelector('button[role="menuitemradio"][aria-checked="true"]');

    expect(menu?.textContent).toContain("Urgent");
    expect(menu?.textContent).toContain("High");
    expect(menu?.textContent).toContain("Medium");
    expect(menu?.textContent).toContain("Low");
    expect(menu?.innerHTML).not.toContain("bg-orange-600");
    expect(menu?.innerHTML).not.toContain("rounded-xl");
    expect(selectedRow?.querySelector('[data-slot="priority-menu-check"]')).toBeTruthy();
  });
});
