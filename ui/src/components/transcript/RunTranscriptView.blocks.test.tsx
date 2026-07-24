// @vitest-environment jsdom

import type { ChatMessage } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import { ThemeProvider } from "../../context/ThemeContext";
import { readChatAnnotationSourceText } from "../../lib/chat-response-annotation-selection";
import { mergeNativeSteerTranscriptEntries } from "../../lib/chat-stream-state";
import {
  ExpandableTranscriptResponsePre,
  TranscriptActivityRow,
  TranscriptEventRow,
  TranscriptMessageBlock,
} from "./RunTranscriptView.blocks";
import { normalizeTranscript } from "./RunTranscriptView.normalize";

vi.mock("../../pages/Chat.attachments", () => ({
  ChatFileAttachmentChip: ({ name, href }: { name: string; href?: string }) => (
    href ? <a href={href}>{name}</a> : <span>{name}</span>
  ),
  ChatImageAttachmentTile: ({ name }: { name: string }) => <span>{name}</span>,
  PendingAttachmentPreview: ({ file, onRemove }: { file: File; onRemove: () => void }) => (
    <span>
      {file.name}
      <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove}>
        Remove
      </button>
    </span>
  ),
}));

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
  it("registers the exact visible Process projection as the annotation source", () => {
    const visibleProcess = "Exploration before the final answer";
    const container = render(
      <ThemeProvider>
        <TranscriptMessageBlock
          block={{
            type: "message",
            role: "assistant",
            ts: "2026-07-23T10:00:00.000Z",
            text: visibleProcess,
            streaming: false,
            generationId: "generation-visible-prefix",
            generationSeqStart: 1,
            generationSeqEnd: 1,
          }}
          density="compact"
          presentation="chat"
          annotationSource={{
            sourceConversationId: "conversation-visible-prefix",
            sourceMessageId: "message-visible-prefix",
          }}
        />
      </ThemeProvider>,
    );
    const sourceRoot = container.querySelector<HTMLElement>(
      '[data-annotation-surface="process_transcript"]',
    )!;

    expect(readChatAnnotationSourceText(sourceRoot)).toBe(visibleProcess);
  });

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

  it("keeps sent annotation evidence attached to the embedded Steer bubble", () => {
    const steerMessage: ChatMessage = {
      id: "steer-with-annotation",
      orgId: "org-1",
      conversationId: "chat-1",
      role: "user",
      kind: "message",
      status: "completed",
      body: "Use the selected evidence",
      structuredPayload: {
        source: "steer",
        targetGenerationId: "generation-1",
        afterTranscriptEntryCount: 0,
        generationSeq: 4,
        controlActionId: "control-1",
        deliveryDisposition: "accepted_current",
        inlineAnnotations: [{
          id: "10000000-0000-4000-8000-000000000001",
          selectedText: "selected evidence",
          comment: "Preserve this comment.",
          sourceConversationId: "20000000-0000-4000-8000-000000000001",
          sourceMessageId: "30000000-0000-4000-8000-000000000001",
          surface: "assistant_body",
          sourceHash: "a".repeat(64),
          start: 0,
          end: 17,
          prefix: "",
          suffix: "",
          attachmentIds: [],
        }],
      },
      approvalId: null,
      approval: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: "turn-1",
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date("2026-07-21T08:00:00.000Z"),
      updatedAt: new Date("2026-07-21T08:00:00.000Z"),
    };
    const [block] = normalizeTranscript(
      mergeNativeSteerTranscriptEntries([], [steerMessage]),
      false,
    );
    expect(block).toMatchObject({
      type: "message",
      source: "steer",
      steerMessage: { id: "steer-with-annotation" },
    });
    if (block?.type !== "message") throw new Error("Expected a Steer message block");

    render(
      <ThemeProvider>
        <TranscriptMessageBlock block={block} density="compact" presentation="chat" />
      </ThemeProvider>,
    );
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Show 1 annotation"]',
    );
    expect(chip).not.toBeNull();

    act(() => chip?.click());

    expect(document.body.textContent).toContain("selected evidence");
    expect(document.body.textContent).toContain("Preserve this comment.");
    expect(document.querySelector('[aria-label^="Edit annotation"]')).toBeNull();
    expect(document.querySelector('[aria-label^="Delete annotation"]')).toBeNull();
  });
});
