// @vitest-environment jsdom

import type { ChatMessage } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyStreamTranscriptItem } from "./Chat.messages";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/messenger/chat/chat-1", search: "", hash: "", key: "chat" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("@/components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: () => null,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("LazyStreamTranscriptItem", () => {
  it("shows process duration without exposing raw event counts", () => {
    const summary: NonNullable<ChatMessage["transcriptSummary"]> = {
      entryCount: 19,
      startedAt: "2026-06-09T08:00:00.000Z",
      endedAt: "2026-06-09T08:00:08.000Z",
    };

    const container = render(
      <LazyStreamTranscriptItem
        summary={summary}
        state="completed"
        onLoad={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("Worked for 8s");
    expect(container.textContent).not.toContain("19 events");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });
});
