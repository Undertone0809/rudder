// @vitest-environment jsdom

import type { Agent } from "@rudderhq/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueRuntimeSelector } from "./IssueRuntimeSelector";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [{
      id: "gpt-5.6-sol",
      label: "gpt-5.6-sol",
      variants: ["low", "medium", "high", "xhigh", "max", "ultra"],
    }],
    error: null,
    isPending: false,
  }),
}));

const agent = {
  id: "agent-1",
  orgId: "org-1",
  name: "Noah",
  role: "general",
  status: "active",
  agentRuntimeType: "codex_local",
  runtimeConfig: {},
  agentRuntimeConfig: {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high",
  },
} as unknown as Agent;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function renderSelector(onApply = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <IssueRuntimeSelector
        agent={agent}
        orgId="org-1"
        overrides={null}
        variant="menu"
        onApply={onApply}
      />,
    );
  });
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { container, onApply };
}

function click(target: Element | null) {
  expect(target).toBeTruthy();
  act(() => target?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("IssueRuntimeSelector menu", () => {
  it.each([
    ["model", "issue-runtime-model-trigger", "issue-runtime-option-model-gpt-5.6-sol"],
    ["thinking effort", "issue-runtime-effort-trigger", "issue-runtime-option-effort-high"],
  ])("closes the complete menu after selecting a %s", async (_label, triggerTestId, optionTestId) => {
    const { container, onApply } = renderSelector();

    click(container.querySelector('[data-testid="issue-runtime-selector"]'));
    click(document.body.querySelector(`[data-testid="${triggerTestId}"]`));
    expect(document.body.querySelector('[data-testid="issue-runtime-profile-panel"]')).toBeTruthy();
    expect(document.body.querySelector(`[data-testid="${optionTestId}"]`)).toBeTruthy();

    click(document.body.querySelector(`[data-testid="${optionTestId}"]`));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(onApply).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-testid="issue-runtime-profile-panel"]')).toBeNull();
    expect(document.body.querySelector('[data-testid^="issue-runtime-"][role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="issue-runtime-selector"]'));
  });
});
