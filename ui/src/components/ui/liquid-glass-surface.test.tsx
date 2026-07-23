// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { LiquidGlassSurface } from "./liquid-glass-surface";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

class ResizeObserverMock implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = ResizeObserverMock;

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

function render(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}

describe("shared liquid glass surfaces", () => {
  it("decorates dialogs as a non-interactive modal glass surface", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Review change</DialogTitle>
          <DialogDescription>Inspect the proposed change.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const content = document.querySelector("[data-slot='dialog-content']");
    const glass = content?.querySelector("[data-rudder-liquid-glass]");

    expect(glass?.getAttribute("data-liquid-glass-variant")).toBe("modal");
    expect(glass?.getAttribute("aria-hidden")).toBe("true");
    expect(glass?.classList.contains("pointer-events-none")).toBe(true);
  });

  it("decorates dropdowns as a non-interactive menu glass surface", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = document.querySelector("[data-slot='dropdown-menu-content']");
    const glass = content?.querySelector("[data-rudder-liquid-glass]");

    expect(glass?.getAttribute("data-liquid-glass-variant")).toBe("menu");
    expect(glass?.getAttribute("aria-hidden")).toBe("true");
    expect(glass?.classList.contains("pointer-events-none")).toBe(true);
  });

  it("uses unique SVG filters and stable material layers for simultaneous surfaces", () => {
    render(
      <>
        <LiquidGlassSurface variant="preview" />
        <LiquidGlassSurface variant="tooltip" />
      </>,
    );

    const surfaces = Array.from(
      document.querySelectorAll<HTMLElement>("[data-rudder-liquid-glass]"),
    );
    const filters = Array.from(
      document.querySelectorAll<SVGFilterElement>("[data-liquid-glass-filter]"),
    );

    expect(surfaces).toHaveLength(2);
    expect(filters).toHaveLength(2);
    expect(filters[0]?.id).not.toBe(filters[1]?.id);

    for (const [index, surface] of surfaces.entries()) {
      const warp = surface.querySelector<HTMLElement>("[data-liquid-glass-warp]");
      const highlight = surface.querySelector<HTMLElement>("[data-liquid-glass-highlight]");
      expect(warp?.style.backdropFilter).toBe("");
      expect(highlight?.style.filter).toBe("");
      expect(surface.querySelector("[data-liquid-glass-tint]")).toBeTruthy();
    }
  });

  it("binds the SVG refraction filter to the non-scrolling host material", () => {
    render(
      <div className="liquid-glass-host" data-testid="scroll-host">
        <LiquidGlassSurface variant="menu" />
        <div>Scrollable menu content</div>
      </div>,
    );

    const host = document.querySelector<HTMLElement>("[data-testid='scroll-host']");
    const filter = host?.querySelector<SVGFilterElement>("[data-liquid-glass-filter]");

    expect(filter?.id).toBeTruthy();
    expect(host?.style.getPropertyValue("--liquid-glass-filter"))
      .toContain(`url("#${filter?.id}")`);
    expect(host?.getAttribute("data-liquid-glass-variant")).toBe("menu");
  });

  it("decorates nested dropdown content without nesting its portal", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Open in app</DropdownMenuSubTrigger>
            <DropdownMenuSubContent forceMount>
              <DropdownMenuItem>VS Code</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = document.querySelector("[data-slot='dropdown-menu-content']");
    const subContent = document.querySelector("[data-slot='dropdown-menu-sub-content']");

    expect(content?.contains(subContent)).toBe(false);
    expect(
      subContent
        ?.querySelector("[data-rudder-liquid-glass]")
        ?.getAttribute("data-liquid-glass-variant"),
    ).toBe("menu");
  });

  it("decorates context menus and popovers as menu glass surfaces", () => {
    render(
      <>
        <ContextMenu>
          <ContextMenuTrigger data-testid="context-target">Context target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Rename</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <Popover open>
          <PopoverTrigger>Popover target</PopoverTrigger>
          <PopoverContent forceMount>Popover body</PopoverContent>
        </Popover>
      </>,
    );

    const contextTarget = document.querySelector<HTMLElement>("[data-testid='context-target']");
    act(() => {
      contextTarget?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: 24,
        clientY: 24,
      }));
    });

    for (const slot of ["context-menu-content", "popover-content"]) {
      const content = document.querySelector(`[data-slot='${slot}']`);
      expect(
        content
          ?.querySelector("[data-rudder-liquid-glass]")
          ?.getAttribute("data-liquid-glass-variant"),
      ).toBe("menu");
    }
  });

  it("decorates sheets as modal glass and tooltips as lightweight glass", () => {
    render(
      <>
        <Sheet open>
          <SheetContent>
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription>Update the workspace.</SheetDescription>
          </SheetContent>
        </Sheet>
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Help</TooltipTrigger>
            <TooltipContent>More information</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </>,
    );

    const sheet = document.querySelector("[data-slot='sheet-content']");
    const tooltip = document.querySelector("[data-slot='tooltip-content']");

    expect(
      sheet
        ?.querySelector("[data-rudder-liquid-glass]")
        ?.getAttribute("data-liquid-glass-variant"),
    ).toBe("modal");
    expect(
      tooltip
        ?.querySelector("[data-rudder-liquid-glass]")
        ?.getAttribute("data-liquid-glass-variant"),
    ).toBe("tooltip");
  });

  it("decorates select content without wrapping selectable items", () => {
    render(
      <Select open defaultValue="one">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="one">One</SelectItem>
          <SelectItem value="two">Two</SelectItem>
        </SelectContent>
      </Select>,
    );

    const content = document.querySelector("[data-slot='select-content']");
    const items = content?.querySelectorAll("[data-slot='select-item']");

    expect(
      content
        ?.querySelector("[data-rudder-liquid-glass]")
        ?.getAttribute("data-liquid-glass-variant"),
    ).toBe("menu");
    expect(items).toHaveLength(2);
    expect(items?.[0]?.closest("[data-rudder-liquid-glass]")).toBeNull();
  });

});
