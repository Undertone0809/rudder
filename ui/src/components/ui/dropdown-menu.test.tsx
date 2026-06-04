// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  act(() => {
    cleanupFn?.();
  });
  cleanupFn = null;
  document.body.innerHTML = "";
});

function renderOpenDropdown() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Copy</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Open in app</DropdownMenuSubTrigger>
            <DropdownMenuSubContent forceMount>
              <DropdownMenuItem>VS Code</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  });
  cleanupFn = () => root?.unmount();
}

describe("DropdownMenuSubContent", () => {
  it("renders outside parent content so submenus are not clipped by parent overflow", () => {
    renderOpenDropdown();

    const menuContent = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-content']");
    const subContent = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-sub-content']");

    expect(menuContent).toBeTruthy();
    expect(subContent).toBeTruthy();
    expect(menuContent?.contains(subContent)).toBe(false);
  });
});
