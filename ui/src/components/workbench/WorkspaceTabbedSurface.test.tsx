// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceTabbedSurface,
  WorkspaceTabbedSurfaceContent,
  WorkspaceTabbedSurfaceHeader,
  WorkspaceTabbedSurfaceStrip,
} from "./WorkspaceTabbedSurface";

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

describe("WorkspaceTabbedSurface", () => {
  it("keeps the caller's native root tag and forwards surface props and refs", () => {
    const rootRef = createRef<HTMLElement>();
    const headerRef = createRef<HTMLDivElement>();
    const stripRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();

    act(() => {
      root.render(
        <WorkspaceTabbedSurface
          as="aside"
          ref={rootRef}
          aria-label="Side Panel"
          data-testid="surface-root"
          className="min-h-0"
        >
          <WorkspaceTabbedSurfaceHeader
            ref={headerRef}
            role="tablist"
            aria-label="Targets"
            data-testid="surface-header"
          >
            <WorkspaceTabbedSurfaceStrip
              ref={stripRef}
              role="tablist"
              data-testid="surface-strip"
              className="overflow-hidden"
            >
              <button role="tab">Target</button>
            </WorkspaceTabbedSurfaceStrip>
          </WorkspaceTabbedSurfaceHeader>
          <WorkspaceTabbedSurfaceContent
            ref={contentRef}
            data-testid="surface-content"
          >
            <main data-testid="scroll-owner">Content</main>
          </WorkspaceTabbedSurfaceContent>
        </WorkspaceTabbedSurface>,
      );
    });

    const surface = host.querySelector<HTMLElement>("[data-testid='surface-root']")!;
    const header = host.querySelector<HTMLDivElement>("[data-testid='surface-header']")!;
    const strip = host.querySelector<HTMLDivElement>("[data-testid='surface-strip']")!;
    const content = host.querySelector<HTMLDivElement>("[data-testid='surface-content']")!;

    expect(surface.tagName).toBe("ASIDE");
    expect(surface.getAttribute("aria-label")).toBe("Side Panel");
    expect(surface.classList.contains("gap-1.5")).toBe(true);
    expect(header.tagName).toBe("DIV");
    expect(header.getAttribute("role")).toBe("tablist");
    expect(header.classList.contains("workspace-tab-header-card")).toBe(true);
    expect(strip.getAttribute("role")).toBe("tablist");
    expect(strip.classList.contains("workspace-tab-strip")).toBe(true);
    expect(strip.classList.contains("overflow-hidden")).toBe(true);
    expect(content.tagName).toBe("DIV");
    expect(content.classList.contains("workspace-tab-content-card")).toBe(true);
    expect(content.querySelector("[data-testid='scroll-owner']")).not.toBeNull();
    expect(rootRef.current).toBe(surface);
    expect(headerRef.current).toBe(header);
    expect(stripRef.current).toBe(strip);
    expect(contentRef.current).toBe(content);
  });

  it("supports the Library section root without adding a wrapper", () => {
    act(() => {
      root.render(
        <WorkspaceTabbedSurface as="section" data-testid="library-editor">
          <WorkspaceTabbedSurfaceHeader data-testid="library-tabs" />
          <WorkspaceTabbedSurfaceContent data-testid="library-content" />
        </WorkspaceTabbedSurface>,
      );
    });

    const section = host.querySelector<HTMLElement>("[data-testid='library-editor']")!;
    expect(section.tagName).toBe("SECTION");
    expect(section.querySelector(":scope > [data-testid='library-tabs']")).not.toBeNull();
    expect(section.querySelector(":scope > [data-testid='library-content']")).not.toBeNull();
  });
});
