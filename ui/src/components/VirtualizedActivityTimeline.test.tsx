// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualizedActivityTimeline } from "./VirtualizedActivityTimeline";

const virtualizerMocks = vi.hoisted(() => ({
  elementOptions: [] as Array<{
    enabled?: boolean;
    getScrollElement?: () => unknown;
  }>,
  windowOptions: [] as Array<{ enabled?: boolean }>,
  elementVirtualizer: {
    containerRef: vi.fn(),
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    isScrolling: false,
    measureElement: vi.fn(),
    scrollDirection: null,
    scrollToIndex: vi.fn(),
  },
  windowVirtualizer: {
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    isScrolling: false,
    measureElement: vi.fn(),
    scrollDirection: null,
    scrollToIndex: vi.fn(),
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn((options: { enabled?: boolean; getScrollElement?: () => unknown }) => {
    virtualizerMocks.elementOptions.push(options);
    return virtualizerMocks.elementVirtualizer;
  }),
  useWindowVirtualizer: vi.fn((options: { enabled?: boolean }) => {
    virtualizerMocks.windowOptions.push(options);
    return virtualizerMocks.windowVirtualizer;
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function TimelineHarness() {
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={scrollElementRef} style={{ overflowY: "auto" }}>
      <VirtualizedActivityTimeline
        items={[{ id: "message-1" }]}
        estimateSize={() => 40}
        getItemKey={(item) => item.id}
        scrollElementRef={scrollElementRef}
        testId="timeline"
      >
        {(item) => <div>{item.id}</div>}
      </VirtualizedActivityTimeline>
    </div>
  );
}

describe("VirtualizedActivityTimeline scroll root", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.stubEnv("MODE", "development");
    virtualizerMocks.elementOptions.length = 0;
    virtualizerMocks.windowOptions.length = 0;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllEnvs();
  });

  it("pins the mounted scroll root instead of resolving it during render", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<TimelineHarness />));

    const scrollElement = container.querySelector("[style*='overflow-y']");
    expect(scrollElement).not.toBeNull();
    expect(virtualizerMocks.elementOptions[0]?.getScrollElement?.()).toBeNull();

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(virtualizerMocks.elementOptions.at(-1)?.getScrollElement?.()).toBe(scrollElement);
  });
});
