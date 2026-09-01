// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef(({
      value,
      onChange,
    }: {
      value: string;
      onChange: (value: string) => void;
    }, ref) => {
      const textareaRef = React.useRef<HTMLTextAreaElement>(null);
      React.useImperativeHandle(ref, () => ({
        focus: () => textareaRef.current?.focus(),
        getMarkdown: () => textareaRef.current?.value ?? value,
      }));
      return (
        <textarea
          ref={textareaRef}
          aria-label="Comment draft"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    }),
  };
});

describe("CommentComposer pending Agent wakes", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("deduplicates Agent mentions and toggles one wake without removing the draft token", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    function Harness() {
      const [body, setBody] = useState([
        "[Noah](agent://agent-noah?intent=wake)",
        "[Noah again](agent://agent-noah?intent=wake)",
        "[Sage](agent://agent-sage?intent=wake)",
      ].join(" "));
      return (
        <CommentComposer
          body={body}
          onBodyChange={setBody}
          onSubmit={vi.fn()}
          canSubmit
          submitting={false}
          mentions={[
            { id: "agent:agent-noah", agentId: "agent-noah", kind: "agent", name: "Noah" },
            { id: "agent:agent-sage", agentId: "agent-sage", kind: "agent", name: "Sage" },
          ]}
        />
      );
    }

    await act(async () => root.render(<Harness />));

    const status = container.querySelector<HTMLElement>("[data-testid='comment-agent-wake-status']");
    expect(status).not.toBeNull();
    const summary = status?.querySelector<HTMLButtonElement>("[data-testid='comment-agent-wake-summary']");
    expect(summary?.textContent).toContain("2 agents will start when sent");

    await act(async () => summary?.click());
    const popover = document.body.querySelector<HTMLElement>("[data-testid='comment-agent-wake-popover']");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("Will start when sent");
    expect(popover?.textContent).toContain("Noah");
    expect(popover?.textContent).toContain("Sage");

    const cancelNoah = document.body.querySelector<HTMLButtonElement>(
      "button[aria-label='Cancel starting Noah when this comment is sent']",
    );
    expect(cancelNoah).not.toBeNull();
    expect(cancelNoah?.hasAttribute("aria-pressed")).toBe(false);
    await act(async () => cancelNoah?.click());

    const skippedNoah = document.body.querySelector<HTMLButtonElement>(
      "button[aria-label='Start Noah when this comment is sent']",
    );
    expect(skippedNoah?.dataset.wakeState).toBe("skipped");
    expect(skippedNoah?.textContent).toContain("reference only");
    expect(summary?.textContent).toContain("1 of 2 agents will start when sent");
    expect(document.body.querySelector("[data-testid='comment-agent-wake-status-agent-sage']")?.getAttribute("data-wake-state"))
      .toBe("pending");

    const draft = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment draft']")?.value ?? "";
    expect(draft).toContain("[Noah](agent://agent-noah)");
    expect(draft).toContain("[Noah again](agent://agent-noah)");
    expect(draft).toContain("[Sage](agent://agent-sage?intent=wake)");

    await act(async () => skippedNoah?.click());
    expect(document.body.querySelector("[data-testid='comment-agent-wake-status-agent-noah']")?.getAttribute("data-wake-state"))
      .toBe("pending");
    expect(summary?.textContent).toContain("2 agents will start when sent");
  });

  it("shows no wake status for unknown or code-only Agent links", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => root.render(
      <CommentComposer
        body="`[Noah](agent://agent-noah?intent=wake)` [Unknown](agent://agent-unknown?intent=wake)"
        onBodyChange={vi.fn()}
        onSubmit={vi.fn()}
        canSubmit
        submitting={false}
        mentions={[{ id: "agent:agent-noah", agentId: "agent-noah", kind: "agent", name: "Noah" }]}
      />,
    ));

    expect(container.querySelector("[data-testid='comment-agent-wake-status']")).toBeNull();
  });

  it("keeps the pre-submit control in the shared status row when Agent wakes are present", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => root.render(
      <CommentComposer
        body="[Noah](agent://agent-noah?intent=wake)"
        onBodyChange={vi.fn()}
        onSubmit={vi.fn()}
        canSubmit
        submitting={false}
        mentions={[{ id: "agent:agent-noah", agentId: "agent-noah", kind: "agent", name: "Noah" }]}
        beforeSubmit={<label><input type="checkbox" aria-label="Re-open" /> Re-open</label>}
      />,
    ));

    const status = container.querySelector<HTMLElement>("[data-testid='comment-agent-wake-status']");
    expect(status).not.toBeNull();
    expect(status?.querySelector("input[aria-label='Re-open']")).not.toBeNull();
  });
});
