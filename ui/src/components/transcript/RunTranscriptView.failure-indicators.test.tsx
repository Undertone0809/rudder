// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "../../context/ThemeContext";
import { TranscriptToolCard } from "./RunTranscriptView.blocks";
import { TranscriptChatToolActionRow } from "./RunTranscriptView.chat";
import type { TranscriptToolCardEntry } from "./RunTranscriptView.common";

vi.mock("@/components/chat/ResponseAnnotations", () => ({
  AnchoredResponseAnnotationMarkers: () => null,
  ResponseAnnotationEditor: () => null,
  SentResponseAnnotationsCard: () => null,
}));
vi.mock("@/components/chat/SelectionAnnotationToolbar", () => ({
  SelectionAnnotationToolbar: () => null,
}));
vi.mock("../MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../InspectableImage", () => ({
  InspectableImage: ({ name }: { name: string }) => <span>{name}</span>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});

const failedTool: TranscriptToolCardEntry = {
  ts: "2026-08-17T00:00:00.000Z",
  endTs: "2026-08-17T00:00:01.000Z",
  name: "generic_tool",
  toolUseId: "failed-tool-1",
  input: null,
  result: "status: failed\nexit_code: 7",
  isError: true,
  status: "error",
};

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
  }
  mountedContainer?.remove();
  mountedRoot = null;
  mountedContainer = null;
  window.localStorage.clear();
});

function mount(content: ReactNode) {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  act(() => {
    mountedRoot?.render(content);
  });
  return mountedContainer;
}

function FailureIndicatorHarness() {
  const { showToolCallFailureIndicators, setShowToolCallFailureIndicators } = useTheme();
  return (
    <>
      <button
        type="button"
        data-testid="toggle-failure-indicators"
        onClick={() => setShowToolCallFailureIndicators(!showToolCallFailureIndicators)}
      >
        Toggle failure indicators
      </button>
      <TranscriptChatToolActionRow
        block={{ ...failedTool, result: "failure output" }}
        density="compact"
        defaultOpenOnError
      />
    </>
  );
}

describe("tool call failure indicator presentation", () => {
  it("omits generic and structured failure summaries while indicators are off", () => {
    const container = mount(
      <ThemeProvider initialShowToolCallFailureIndicators={false}>
        <>
          <TranscriptChatToolActionRow
            block={{ ...failedTool, result: undefined }}
            density="compact"
            defaultOpenOnError
          />
          <TranscriptChatToolActionRow
            block={{ ...failedTool, name: "tool" }}
            density="compact"
            defaultOpenOnError
          />
        </>
      </ThemeProvider>,
    );

    expect(container.textContent).not.toContain("Tool failed");
    expect(container.textContent).not.toContain("Failed with exit code");
    expect(container.textContent).not.toContain("Failed");
    expect(container.querySelectorAll('[aria-expanded="false"]')).toHaveLength(1);
    expect(container.innerHTML).not.toContain("text-red");
  });

  it("neutralizes failed file-change summaries in full and chat presentations", () => {
    const fileChangeBlock: TranscriptToolCardEntry = {
      ...failedTool,
      name: "file_change",
      input: { status: "failed", changes: [] },
      result: "Could not apply patch",
    };
    const container = mount(
      <ThemeProvider initialShowToolCallFailureIndicators={false}>
        <TranscriptToolCard block={fileChangeBlock} density="compact" />
        <TranscriptChatToolActionRow block={fileChangeBlock} density="compact" />
      </ThemeProvider>,
    );

    expect(container.textContent).toContain("File changes");
    expect(container.textContent).not.toContain("File change failed");
    expect(container.textContent).not.toContain("Errored");
    expect(container.textContent).not.toContain("Failed");
  });

  it("restores failure wording and red presentation when indicators are on", () => {
    const fileChangeBlock: TranscriptToolCardEntry = {
      ...failedTool,
      name: "file_change",
      input: { status: "failed", changes: [] },
      result: "Could not apply patch",
    };
    const container = mount(
      <ThemeProvider initialShowToolCallFailureIndicators>
        <TranscriptToolCard block={fileChangeBlock} density="compact" />
        <TranscriptChatToolActionRow block={{ ...failedTool, name: "tool" }} density="compact" />
      </ThemeProvider>,
    );

    expect(container.textContent).toContain("File change failed");
    expect(container.textContent).toContain("Errored");
    expect(container.textContent).toContain("Failed with exit code 7");
    expect(container.innerHTML).toContain("text-red");
  });

  it("closes only failure-driven auto expansion when the mounted preference changes", () => {
    const container = mount(
      <ThemeProvider initialShowToolCallFailureIndicators={false}>
        <FailureIndicatorHarness />
      </ThemeProvider>,
    );
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="toggle-failure-indicators"]');
    const disclosure = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]');

    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");

    act(() => disclosure()?.click());
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");

    act(() => toggle?.click());
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle?.click());
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");

    act(() => disclosure()?.click());
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");

    act(() => toggle?.click());
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle?.click());
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
  });
});
