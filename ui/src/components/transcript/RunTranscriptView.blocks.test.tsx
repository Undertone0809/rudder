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
  CommandTerminalDetail,
  ExpandableTranscriptResponsePre,
  TranscriptActivityRow,
  TranscriptEventRow,
  TranscriptMessageBlock,
  TranscriptRunAnnotationBlock,
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

describe("CommandTerminalDetail", () => {
  it("keeps the Shell view and removes the Task and Markdown tabs", () => {
    const container = render(
      <CommandTerminalDetail
        command="rg --files ui/src/components/transcript"
        output="RunTranscriptView.tsx"
        status="completed"
      />,
    );

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Shell"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0]);
    expect(container.querySelector("[role='tab'][aria-label='Task']")).toBeNull();
    expect(container.querySelector("[role='tab'][aria-label='Markdown']")).toBeNull();
    expect(container.querySelector("[data-command-terminal-panel='shell']")?.textContent).toContain("rg --files");
    expect(container.querySelector("[data-command-terminal-panel='shell']")?.textContent).toContain("RunTranscriptView.tsx");
    expect(container.querySelector("[data-testid='command-terminal-copy-button']")).not.toBeNull();
  });

  it("keeps command output neutral when failure indicators are hidden", () => {
    const container = render(
      <CommandTerminalDetail
        command="false"
        output="exit code 1"
        status="error"
        showFailureIndicators={false}
      />,
    );
    const output = Array.from(container.querySelectorAll("pre")).find((pre) => pre.textContent?.includes("exit code 1"));
    expect(output?.className).not.toContain("text-red-300");
  });

  it("keeps the Shell view available when a command has no text", () => {
    const container = render(
      <CommandTerminalDetail command="" output={null} status="running" />,
    );
    const shellTab = container.querySelector<HTMLButtonElement>("[role='tab'][data-command-terminal-view='shell']");

    expect(shellTab?.disabled).toBe(false);
    expect(shellTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-command-terminal-panel='shell']")).not.toBeNull();
  });
});

describe("TranscriptRunAnnotationBlock", () => {
  it("waits for the selection toolbar action before creating a text annotation", () => {
    const onAnnotate = vi.fn();
    const container = render(
      <TranscriptRunAnnotationBlock
        block={{
          type: "message",
          role: "assistant",
          ts: "2026-07-23T12:00:00.000Z",
          text: "Selectable transcript text",
          streaming: false,
          sourceEntryIds: ["event-1"],
        }}
        presentation="detail"
        context={{ sourceRunId: "run-1", sourceAgentId: "agent-1", onAnnotate }}
      >
        <span>Selectable transcript text</span>
      </TranscriptRunAnnotationBlock>,
    );
    const textNode = container.querySelector("span")?.firstChild;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.selectNodeContents(textNode!);
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(20, 20, 120, 20),
    });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(onAnnotate).not.toHaveBeenCalled();
    const addButton = document.querySelector<HTMLButtonElement>("[role='toolbar'] button");
    expect(addButton?.textContent).toContain("Add to chat");

    act(() => {
      addButton?.click();
    });

    expect(document.querySelector("[data-testid='chat-response-annotation-editor']")).not.toBeNull();
    expect(onAnnotate).not.toHaveBeenCalled();
    const textarea = document.querySelector<HTMLTextAreaElement>("[data-testid='chat-response-annotation-editor'] textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Needs review");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      Array.from(document.querySelectorAll("[data-testid='chat-response-annotation-editor'] button"))
        .find((button) => button.textContent === "Save")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAnnotate).toHaveBeenCalledWith(expect.objectContaining({
      anchorKind: "text",
      text: "Selectable transcript text",
      sourceRunId: "run-1",
      sourceMemberIds: ["event-1"],
      comment: "Needs review",
      pendingFiles: [],
      attachmentIds: [],
    }));
  });

  it("discards a transition annotation when the editor is cancelled", () => {
    const onAnnotate = vi.fn();
    const container = render(
      <TranscriptRunAnnotationBlock
        block={{
          type: "thinking",
          ts: "2026-07-23T12:00:00.000Z",
          text: "Reasoning text",
          streaming: false,
          sourceEntryIds: ["event-2"],
        }}
        presentation="detail"
        context={{ sourceRunId: "run-1", sourceAgentId: "agent-1", onAnnotate }}
      >
        <span>Reasoning text</span>
      </TranscriptRunAnnotationBlock>,
    );
    const trigger = container.querySelector<HTMLButtonElement>("[data-run-transcript-annotation-trigger]");
    expect(trigger).not.toBeNull();
    trigger!.getBoundingClientRect = () => new DOMRect(20, 20, 120, 20);
    act(() => {
      trigger?.click();
    });
    expect(document.querySelector("[data-testid='chat-response-annotation-editor']")).not.toBeNull();
    act(() => {
      Array.from(document.querySelectorAll("[data-testid='chat-response-annotation-editor'] button"))
        .find((button) => button.textContent === "Cancel")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onAnnotate).not.toHaveBeenCalled();
  });

  it("bounds the editor to the transcript container instead of the block height", () => {
    const onAnnotate = vi.fn();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    const container = render(
      <TranscriptRunAnnotationBlock
        block={{
          type: "message",
          role: "assistant",
          ts: "2026-07-23T12:00:00.000Z",
          text: "A transcript block with enough context for the editor.",
          streaming: false,
          sourceEntryIds: ["event-3"],
        }}
        presentation="detail"
        context={{ sourceRunId: "run-1", sourceAgentId: "agent-1", onAnnotate }}
      >
        <span>A transcript block with enough context for the editor.</span>
      </TranscriptRunAnnotationBlock>,
    );
    container.setAttribute("data-testid", "agent-runs-detail-pane");
    container.getBoundingClientRect = () => ({
      left: 100,
      right: 500,
      top: 100,
      bottom: 600,
      width: 400,
      height: 500,
    } as DOMRect);
    const trigger = container.querySelector<HTMLButtonElement>("[data-run-transcript-annotation-trigger]");
    expect(trigger).not.toBeNull();
    trigger!.getBoundingClientRect = () => new DOMRect(180, 220, 28, 28);

    act(() => {
      trigger?.click();
    });

    const editor = document.querySelector<HTMLElement>("[data-testid='chat-response-annotation-editor']");
    expect(editor).not.toBeNull();
    expect(editor?.style.maxHeight).toBe("484px");
    expect(editor?.querySelector("textarea")).not.toBeNull();
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

  it("uses a yellow notice treatment for error events while preserving their error tone", () => {
    const container = render(
      <TranscriptEventRow
        density="compact"
        block={{
          type: "event",
          ts: "2026-07-16T12:00:00.000Z",
          label: "stderr",
          tone: "error",
          text: "Process lost -- server may have restarted",
        }}
      />,
    );
    const event = container.querySelector('[data-transcript-event-tone="error"]');

    expect(event).not.toBeNull();
    expect(event?.className).toContain("border-amber-500/30");
    expect(event?.className).toContain("bg-amber-500/[0.08]");
    expect(event?.className).toContain("text-amber-800");
    expect(event?.className).not.toContain("border-red-500/20");
    expect(event?.querySelector(".lucide-circle-alert")).not.toBeNull();
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
