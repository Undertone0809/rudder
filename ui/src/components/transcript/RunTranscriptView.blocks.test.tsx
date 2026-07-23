// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import {
  ExpandableTranscriptResponsePre,
  TranscriptActivityRow,
  TranscriptEventRow,
  TranscriptMessageBlock,
} from "./RunTranscriptView.blocks";
import { normalizeTranscript } from "./RunTranscriptView.normalize";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

let cleanupFn: (() => void) | null = null;

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

describe("ExpandableTranscriptResponsePre", () => {
  it("limits responses that overflow only after narrow-container wrapping", () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const wrappedResponse = `{"payload":"${"wrapped-json-fragment".repeat(54)}"}`;

    expect(wrappedResponse.length).toBeLessThan(1400);
    expect(wrappedResponse).not.toContain("\n");

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.tagName === "PRE" ? 720 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.tagName === "PRE" ? 288 : 0;
      },
    });

    try {
      const container = render(<ExpandableTranscriptResponsePre text={wrappedResponse} />);
      const pre = container.querySelector("pre");
      const button = container.querySelector("button");

      expect(pre?.className).toContain("max-h-72");
      expect(pre?.getAttribute("data-transcript-response-collapsed")).toBe("true");
      expect(button?.textContent).toBe("Show full response");

      act(() => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(pre?.className).not.toContain("max-h-72");
      expect(pre?.getAttribute("data-transcript-response-collapsed")).toBeNull();
      expect(button?.getAttribute("aria-expanded")).toBe("true");
      expect(button?.textContent).toBe("Show less");
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      }
    }
  });
});

describe("TranscriptEventRow", () => {
  it("renders a file change as one disclosure row and expands its raw event", () => {
    const rawEvent = "file changes: update /Users/zeeland/project/ui/src/pages/AgentDetail.tsx";
    const container = render(
      <TranscriptEventRow
        density="comfortable"
        presentation="detail"
        block={{
          type: "event",
          ts: "2026-07-16T12:00:00.000Z",
          label: "file change",
          tone: "neutral",
          text: "Updated src/pages/AgentDetail.tsx",
          detail: rawEvent,
          collapseByDefault: true,
        }}
      />,
    );
    const button = container.querySelector("button");

    expect(container.querySelectorAll('[data-transcript-file-change="true"]')).toHaveLength(1);
    expect(container.textContent?.match(/File change/g)).toHaveLength(1);
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Expand file change details: Updated src/pages/AgentDetail.tsx");
    expect(container.textContent).not.toContain(rawEvent);

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe("Collapse file change details: Updated src/pages/AgentDetail.tsx");
    expect(container.textContent).toContain(rawEvent);
  });
});

describe("TranscriptActivityRow", () => {
  it("uses the image stack icon for a completed ImageView activity", () => {
    const container = render(
      <TranscriptActivityRow
        density="comfortable"
        block={{
          type: "activity",
          ts: "2026-07-23T12:00:00.000Z",
          name: "ImageView",
          status: "completed",
        }}
      />,
    );

    expect(container.querySelector(".lucide-images")).not.toBeNull();
    expect(container.querySelector(".lucide-check")).toBeNull();
    expect(container.textContent).toContain("ImageView");
  });
});

describe("native Steer transcript blocks", () => {
  it("keeps adjacent same-anchor Steer messages as separate durable blocks", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "user",
        source: "steer",
        messageId: "steer-message-1",
        controlActionId: "steer-action-1",
        ts: "2026-07-21T08:00:00.000Z",
        text: "First same-anchor direction",
      },
      {
        kind: "user",
        source: "steer",
        messageId: "steer-message-2",
        controlActionId: "steer-action-2",
        ts: "2026-07-21T08:00:00.000Z",
        text: "Second same-anchor direction",
      },
    ];

    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toMatchObject([
      { type: "message", source: "steer", messageId: "steer-message-1", text: "First same-anchor direction" },
      { type: "message", source: "steer", messageId: "steer-message-2", text: "Second same-anchor direction" },
    ]);

    const container = render(
      <ThemeProvider>
        {blocks.map((block) => block.type === "message" ? (
          <TranscriptMessageBlock key={block.messageId} block={block} density="compact" presentation="chat" />
        ) : null)}
      </ThemeProvider>,
    );
    const steerBlocks = container.querySelectorAll("[data-testid='chat-transcript-steer-message']");
    expect(steerBlocks).toHaveLength(2);
    expect(steerBlocks[0]?.getAttribute("data-message-id")).toBe("steer-message-1");
    expect(steerBlocks[1]?.getAttribute("data-message-id")).toBe("steer-message-2");
  });
});
