// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptContinuationControls } from "./TranscriptContinuationControls";
import type { AgentRunTranscriptNavigation, AgentRunTranscriptState } from "./useAgentRunTranscripts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function renderControls(
  navigation: Partial<AgentRunTranscriptNavigation> = {},
  state: Partial<AgentRunTranscriptState> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const resolvedNavigation: AgentRunTranscriptNavigation = {
    cursor: null,
    pageNumber: 1,
    previousPageCount: 0,
    historyTruncated: false,
    canPrevious: false,
    canNext: true,
    hasMore: true,
    revision: "revision-1",
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    ...navigation,
  };
  const resolvedState: AgentRunTranscriptState = {
    loading: false,
    fetching: false,
    hasData: true,
    error: null,
    source: "native",
    revision: "revision-1",
    availability: "available",
    completeness: "partial",
    ...state,
  };
  act(() => {
    root?.render(
      <TranscriptContinuationControls
        navigation={resolvedNavigation}
        state={resolvedState}
      />,
    );
  });
  return { navigation: resolvedNavigation, state: resolvedState };
}

describe("TranscriptContinuationControls", () => {
  it("shows bounded partial navigation and invokes the selected direction", () => {
    const { navigation } = renderControls({
      canPrevious: true,
      previousPageCount: 1,
      pageNumber: 2,
      onPrevious: vi.fn(),
      onNext: vi.fn(),
    });
    expect(host?.textContent).toContain("Partial transcript");
    expect(host?.textContent).toContain("Page 2");

    const previousButton = host?.querySelector<HTMLButtonElement>("[aria-label='Previous transcript page']");
    const nextButton = host?.querySelector<HTMLButtonElement>("[aria-label='Next transcript page']");
    act(() => previousButton?.click());
    act(() => nextButton?.click());
    expect(navigation.onPrevious).toHaveBeenCalledTimes(1);
    expect(navigation.onNext).toHaveBeenCalledTimes(1);
  });

  it("makes unavailable state visible even when the page has no entries", () => {
    renderControls(
      { canNext: false, hasMore: false },
      {
        hasData: true,
        availability: "offline",
        completeness: "unknown",
      },
    );
    expect(host?.querySelector("[role='alert']")?.textContent).toContain("Transcript offline.");
    expect(host?.querySelector("[data-testid='transcript-continuation']")).not.toBeNull();
  });
});
