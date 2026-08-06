// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { Goals } from "./Goals";

const openNewGoal = vi.fn();
let dispose: (() => void) | null = null;

vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));
vi.mock("../context/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: "org-1" }) }));
vi.mock("../context/DialogContext", () => ({ useDialog: () => ({ openNewGoal }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { listWorkspace: vi.fn() } }));

const longProgress = "Evidence from the customer deployment confirms that the very long release outcome now survives restart, preserves operator continuity, and remains readable without clipping or horizontal overflow.";
const cards = [
  { id: "goal-agent", title: "Advance the verified release", facet: "agent_advancing", ownerAgentId: "agent-1", progressSummary: longProgress, nextStepSummary: "Run the next bounded verification." },
  { id: "goal-attention", title: "Resolve the launch boundary", facet: "needs_attention", ownerAgentId: "agent-1", progressSummary: "The boundary is the only unresolved commitment.", nextStepSummary: "Wait for the operator decision.", attentionReason: "Choose whether the rollout remains internal." },
  { id: "goal-waiting", title: "Observe the external result", facet: "waiting_external", ownerAgentId: "agent-1", progressSummary: "The external check is active.", nextStepSummary: "Resume when the external signal arrives." },
  { id: "goal-ready", title: "Accept the verified outcome", facet: "ready_for_acceptance", ownerAgentId: "agent-1", progressSummary: "The terminal result is supported by evidence.", nextStepSummary: "Accept or reject the result." },
  { id: "goal-closed", title: "Keep the accepted outcome", facet: "closed", ownerAgentId: "agent-1", progressSummary: "The result was accepted by the operator.", nextStepSummary: "No further action is required." },
];

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={queryClient}><Goals /></QueryClientProvider>));
  dispose = () => act(() => root.unmount());
  return container;
}

async function waitUntil(assertion: () => void, timeout = 2000) {
  const started = Date.now();
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - started > timeout) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

beforeEach(() => {
  vi.mocked(goalsApi.listWorkspace).mockResolvedValue(cards as never);
  vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-1", name: "Goal owner" }] as never);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Goals", () => {
  it("renders four read-only derived columns and a mobile attention-sorted list", async () => {
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[data-testid="goal-derived-board"]')).not.toBeNull());
    for (const heading of ["Agent advancing", "Needs your attention", "Waiting for external result", "Ready for acceptance"]) {
      expect(Array.from(container.querySelectorAll("h2")).some((element) => element.textContent === heading)).toBe(true);
    }
    const board = container.querySelector<HTMLElement>('[data-testid="goal-derived-board"]')!;
    const mobileList = container.querySelector<HTMLElement>('[data-testid="goal-mobile-attention-list"]')!;
    expect(board.classList.contains("hidden")).toBe(true);
    expect(board.classList.contains("md:grid")).toBe(true);
    expect(board.classList.contains("min-w-0")).toBe(true);
    expect(mobileList.classList.contains("md:hidden")).toBe(true);
    expect(mobileList.classList.contains("min-w-0")).toBe(true);
    expect(container.querySelector("[draggable=true]")).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((button) => /status/i.test(button.textContent ?? ""))).toBe(false);

    const mobileLinks = Array.from(mobileList.querySelectorAll("a"));
    expect(mobileLinks.map((link) => link.textContent)).toEqual([
      expect.stringContaining("Accept the verified outcome"),
      expect.stringContaining("Resolve the launch boundary"),
      expect.stringContaining("Observe the external result"),
      expect.stringContaining("Advance the verified release"),
    ]);
    const longText = Array.from(mobileList.querySelectorAll("p")).find((element) => element.textContent === longProgress);
    expect(longText?.classList.contains("break-words")).toBe(true);
    expect(mobileList.textContent).toContain("Goal owner");
    expect(container.querySelector("#goal-history")?.textContent).toContain("History");
    expect(container.textContent).toContain("Keep the accepted outcome");
  });

  it("uses the compact New Goal command", async () => {
    const container = renderPage();
    await waitUntil(() => expect(container.textContent).toContain("New Goal"));
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("New Goal"));
    act(() => button?.click());
    expect(openNewGoal).toHaveBeenCalledTimes(1);
  });
});
