// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { CommentThread } from "./CommentThread";

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

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <div>Markdown editor</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="mock-dialog-root">{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
  }) => <div data-slot="dialog-content" {...props}>{children}</div>,
  DialogClose: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => <button data-slot="dialog-close" {...props}>{children}</button>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

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

describe("CommentThread markdown images", () => {
  it("renders issue comment images with preview and context-menu actions", () => {
    const container = render(
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter>
            <CommentThread
              comments={[
                {
                  id: "comment-1",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Evidence: ![Screenshot](/api/attachments/comment-image/content)",
                  createdAt: new Date("2026-05-13T00:00:00.000Z"),
                  updatedAt: new Date("2026-05-13T00:00:00.000Z"),
                },
              ]}
              onAdd={async () => undefined}
            />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>,
    );

    const imageButton = container.querySelector(".rudder-inspectable-image-trigger");
    expect(imageButton).toBeTruthy();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.body.querySelector('[data-testid="markdown-body-image-preview-dialog"]')).toBeTruthy();

    const image = container.querySelector("img");
    act(() => {
      image?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 64,
        clientY: 80,
      }));
    });

    const menu = document.body.querySelector('[data-testid="markdown-image-context-menu"]');
    expect(menu?.textContent).toContain("Copy Image");
    expect(menu?.textContent).toContain("Open Image");
  });
});
