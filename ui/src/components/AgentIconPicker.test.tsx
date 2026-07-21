// @vitest-environment jsdom

import { palettes as oreoPalettes, shapes as oreoShapes } from "@oreo-design/avatar";
import {
  AGENT_OREO_PALETTE_IDS,
  AGENT_OREO_SHAPE_IDS,
} from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAgentOreoIcon } from "../lib/agent-avatar";
import { AgentIcon, AgentIconPicker, getAgentAvatarImageSrc } from "./AgentIconPicker";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
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

function click(element: Element | null) {
  expect(element).toBeTruthy();
  act(() => {
    (element as HTMLElement).click();
  });
}

function queryButton(label: string) {
  return document.querySelector(`button[aria-label="${label}"]`);
}

function activateTab(label: string) {
  const tab = Array.from(document.querySelectorAll('[role="tab"]'))
    .find((candidate) => candidate.textContent === label);
  expect(tab).toBeTruthy();
  act(() => {
    tab!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
    }));
  });
}

describe("Oreo avatar contract", () => {
  it("keeps shared shape and palette ids aligned with the pinned package", () => {
    expect(AGENT_OREO_SHAPE_IDS).toEqual(oreoShapes.map((shape) => shape.id));
    expect(AGENT_OREO_PALETTE_IDS).toEqual(oreoPalettes.map((palette) => palette.id));
  });
});

describe("AgentIcon", () => {
  it("renders uploaded avatar asset references as images", () => {
    const icon = "asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?bg=mint";
    const container = render(<AgentIcon icon={icon} className="h-4 w-4" />);

    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content");
    expect(getAgentAvatarImageSrc(icon)).toBe("/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content");
    expect(img?.getAttribute("style")).toContain("background:");
  });

  it("renders DiceBear Notionists avatar references as images", () => {
    const icon = "dicebear:notionists:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?bg=slate";
    const container = render(<AgentIcon icon={icon} className="h-4 w-4" />);

    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(getAgentAvatarImageSrc(icon)).toMatch(/^data:image\/svg\+xml/);
  });

  it("renders and caches deterministic Oreo avatar references by their complete value", () => {
    const icon = "oreo:nova:vanilla-sky:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const otherPalette = "oreo:nova:rose-milk:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const container = render(<AgentIcon icon={icon} className="h-4 w-4" />);

    const imageSrc = getAgentAvatarImageSrc(icon);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(imageSrc);
    expect(imageSrc).toMatch(/^data:image\/svg\+xml/);
    expect(getAgentAvatarImageSrc(icon)).toBe(imageSrc);
    expect(getAgentAvatarImageSrc(otherPalette)).not.toBe(imageSrc);
    expect(container.querySelector("img")?.getAttribute("style") ?? "").not.toContain("background");
  });

  it("uses the agent role avatar when no custom icon is set", () => {
    const container = render(<AgentIcon icon={null} role="ceo" />);

    expect(container.textContent).toBe("");
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("uses a generated fallback avatar when an agent seed is available", () => {
    const container = render(<AgentIcon icon={null} role="general" fallbackSeed="agent-1" />);

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("AgentIconPicker", () => {
  it("opens on Oreo with all shapes, all palettes, and a quiet bounded palette scroller", () => {
    render(
      <AgentIconPicker value={null} onChange={() => undefined}>
        <button type="button">Open picker</button>
      </AgentIconPicker>,
    );

    click(document.querySelector("button"));

    expect(document.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Oreo");
    expect(document.querySelectorAll('button[aria-label^="Oreo shape "]')).toHaveLength(6);
    expect(document.querySelectorAll('button[aria-label^="Oreo palette "]')).toHaveLength(40);
    const styleTabs = document.querySelector('[role="tablist"]');
    const styleTab = document.querySelector('[role="tab"]');
    expect(styleTabs?.className).toContain("rounded-[var(--segmented-control-radius)]");
    expect(styleTab?.className).toContain("rounded-[var(--segmented-control-item-radius)]");
    const paletteScroller = document.querySelector('[data-testid="agent-avatar-oreo-palettes"]');
    expect(paletteScroller?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(paletteScroller?.className).toContain("overflow-y-auto");
    expect(document.querySelector('[data-testid="agent-avatar-picker"]')?.className).toContain("100dvh");
  });

  it("keeps the Oreo variant stable across consecutive shape and palette selections", () => {
    const changes: string[] = [];
    const startingIcon = "oreo:bloom:rose-milk:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    render(
      <AgentIconPicker value={startingIcon} onChange={(icon) => icon && changes.push(icon)}>
        <button type="button">Open picker</button>
      </AgentIconPicker>,
    );

    click(document.querySelector("button"));
    click(queryButton("Oreo shape Nova"));
    click(queryButton("Oreo palette Vanilla Sky"));

    expect(changes).toHaveLength(2);
    expect(parseAgentOreoIcon(changes[0])).toEqual({
      shape: "nova",
      palette: "rose-milk",
      variantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(parseAgentOreoIcon(changes[1])).toEqual({
      shape: "nova",
      palette: "vanilla-sky",
      variantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
  });

  it("scopes Random to the selected style and resets new opens to Oreo", () => {
    const changes: string[] = [];
    render(
      <AgentIconPicker value={null} onChange={(icon) => icon && changes.push(icon)}>
        <button type="button">Open picker</button>
      </AgentIconPicker>,
    );

    click(document.querySelector("button"));
    activateTab("DiceBear");
    expect(document.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("DiceBear");
    expect(document.querySelectorAll('button[aria-label^="DiceBear background "]')).toHaveLength(6);
    click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Random")) ?? null);
    expect(changes.at(-1)).toMatch(/^dicebear:notionists:/);

    click(document.querySelector("button"));
    expect(document.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Oreo");
    click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Random")) ?? null);
    expect(changes.at(-1)).toMatch(/^oreo:/);
  });

  it("keeps upload available outside both generated styles", () => {
    const uploads: File[] = [];
    render(
      <AgentIconPicker
        value={null}
        onChange={() => undefined}
        onUpload={(file) => uploads.push(file)}
      >
        <button type="button">Open picker</button>
      </AgentIconPicker>,
    );

    click(document.querySelector("button"));
    activateTab("DiceBear");
    expect(document.querySelector("input[type=file]")).toBeTruthy();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(uploads).toEqual([file]);
  });
});
