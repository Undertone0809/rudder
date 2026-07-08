// @vitest-environment jsdom

import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SidePanelProvider, useSidePanel } from "./SidePanelContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const issueTarget: SidePanelTarget = {
  kind: "issue",
  issueId: "issue-1",
  ref: "ORZ-13",
  commentId: null,
  label: "ORZ-13 create coding agent",
};

function SidePanelProbe() {
  const sidePanel = useSidePanel();

  return (
    <div>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:a")}>Chat A</button>
      <button type="button" onClick={() => sidePanel.setContextKey("chat:b")}>Chat B</button>
      <button type="button" onClick={() => sidePanel.openTarget(issueTarget)}>Open issue</button>
      <button type="button" onClick={() => sidePanel.openTargetForContext("chat:a", issueTarget)}>Open issue for A</button>
      <button type="button" onClick={sidePanel.hidePanel}>Hide</button>
      <span data-testid="context-key">{sidePanel.contextKey}</span>
      <span data-testid="open">{String(sidePanel.open)}</span>
      <span data-testid="active-key">{sidePanel.activeKey ?? ""}</span>
      <span data-testid="tab-count">{String(sidePanel.tabs.length)}</span>
    </div>
  );
}

function renderSidePanelProvider() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <SidePanelProvider>
        <SidePanelProbe />
      </SidePanelProvider>,
    );
  });

  return { container, root };
}

function click(container: Element, label: string) {
  act(() => {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === label);
    button?.click();
  });
}

function text(container: Element, testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("SidePanelProvider context visibility", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("restores an open chat side panel after switching away and back", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat B");
    expect(text(container, "context-key")).toBe("chat:b");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("0");

    click(container, "Chat A");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("preserves hidden tabs without reopening a chat the operator closed", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Hide");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat B");
    click(container, "Chat A");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("preserves the destination chat closed state even when the current chat is open", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat A");
    click(container, "Open issue");
    click(container, "Hide");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat B");
    click(container, "Open issue");
    expect(text(container, "context-key")).toBe("chat:b");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "tab-count")).toBe("1");

    click(container, "Chat A");
    expect(text(container, "context-key")).toBe("chat:a");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });

  it("opens targets into an explicit chat context even when the provider context is stale", () => {
    ({ container, root } = renderSidePanelProvider());

    click(container, "Chat B");
    click(container, "Open issue for A");
    expect(text(container, "context-key")).toBe("chat:b");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "active-key")).toBe("");
    expect(text(container, "tab-count")).toBe("0");

    click(container, "Chat B");
    expect(text(container, "open")).toBe("false");
    expect(text(container, "tab-count")).toBe("0");

    click(container, "Chat A");
    expect(text(container, "open")).toBe("true");
    expect(text(container, "active-key")).toBe("issue:issue-1:");
    expect(text(container, "tab-count")).toBe("1");
  });
});
