// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { NewGoalDialog } from "./NewGoalDialog";

const navigate = vi.fn();
const closeNewGoal = vi.fn();
const randomUUID = vi.fn();
let newGoalDefaults: Record<string, string> = {};
let dispose: (() => void) | null = null;

vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children, showCloseButton: _showCloseButton, ...props }: { children: ReactNode; showCloseButton?: boolean }) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: { children: ReactNode }) => <h2 {...props}>{children}</h2>,
}));
vi.mock("../context/DialogContext", () => ({ useDialog: () => ({ newGoalOpen: true, newGoalDefaults, closeNewGoal }) }));
vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1", selectedOrganization: { id: "org-1", name: "Rudder" } }),
}));
vi.mock("./AssigneeLabel", () => ({ AgentMenuLabel: ({ agent }: { agent: { name: string } }) => <span>{agent.name}</span> }));
vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: ({ value, options, ariaLabel, onChange }: {
    value: string;
    options: Array<{ id: string; label: string }>;
    ariaLabel: string;
    onChange: (id: string) => void;
  }) => <button type="button" aria-label={ariaLabel} onClick={() => onChange(options[0]?.id ?? "")}>{options.find((option) => option.id === value)?.label ?? "No assignee"}</button>,
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Context" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { previewStart: vi.fn(), start: vi.fn(), create: vi.fn(), update: vi.fn() } }));

const agent = { id: "agent-1", name: "Workspace owner", title: "Operator", role: "engineer", status: "idle" };
const validPreview = {
  valid: true,
  packetHash: "a".repeat(64),
  packet: { version: 1, title: "Ship Goal Workspace", ownerAgentId: "agent-1", activation: {} },
  review: {
    outcome: "Goal Workspace is shipped",
    success: "The operator workflow passes",
    owner: "Workspace owner",
    boundary: "No public release",
    firstAction: "Verify the bounded UI journey",
  },
  alignmentQuestion: null,
};

function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={queryClient}><NewGoalDialog /></QueryClientProvider>));
  dispose = () => act(() => root.unmount());
  return container;
}

async function waitUntil(assertion: () => void, timeout = 2500) {
  const started = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeout) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(label: string) {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing field ${label}`);
  return element;
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string) {
  return Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

beforeEach(() => {
  vi.mocked(agentsApi.list).mockResolvedValue([agent] as never);
  vi.mocked(goalsApi.previewStart).mockResolvedValue(validPreview as never);
  vi.mocked(goalsApi.start).mockResolvedValue({ id: "goal-1" } as never);
  vi.mocked(goalsApi.create).mockResolvedValue({ id: "draft-1" } as never);
  vi.mocked(goalsApi.update).mockResolvedValue({ id: "draft-1" } as never);
  newGoalDefaults = {};
  randomUUID.mockReset();
  randomUUID.mockReturnValueOnce("request-key-1").mockReturnValueOnce("request-key-2");
  vi.stubGlobal("crypto", { randomUUID });
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("NewGoalDialog", () => {
  it("previews and starts without internal Contract fields, retaining the request key on retry", async () => {
    vi.mocked(goalsApi.start).mockRejectedValueOnce(new Error("The response was lost")).mockResolvedValueOnce({ id: "goal-1" } as never);
    const container = renderDialog();
    change(field("Goal"), "Ship Goal Workspace");
    change(field("Context"), "Keep the operator journey inspectable.");

    for (const hidden of ["Objective mode", "Evaluator", "Allowed autonomy", "Initial Plan"]) {
      expect(container.textContent).not.toContain(hidden);
    }
    await waitUntil(() => {
      expect(button("Create and start")).not.toBeNull();
      expect(button("Create and start")?.disabled).toBe(false);
    });
    expect(container.textContent).toContain("How we will know it worked");
    expect(container.textContent).toContain("The operator workflow passes");
    expect(container.textContent).toContain("First action");

    act(() => button("Create and start")?.click());
    await waitUntil(() => expect(container.querySelector("[role=alert]")?.textContent).toContain("The response was lost"));
    act(() => button("Create and start")?.click());
    await waitUntil(() => expect(navigate).toHaveBeenCalledWith("/goals/goal-1"));

    const firstPayload = vi.mocked(goalsApi.start).mock.calls[0]?.[1] as Record<string, unknown>;
    const retryPayload = vi.mocked(goalsApi.start).mock.calls[1]?.[1] as Record<string, unknown>;
    expect(firstPayload.requestKey).toBe("request-key-1");
    expect(retryPayload.requestKey).toBe("request-key-1");
    expect(firstPayload.packetHash).toBe(validPreview.packetHash);
    expect(firstPayload.packet).toBe(validPreview.packet);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("saves an invalid preview as a Draft with its alignment question", async () => {
    vi.mocked(goalsApi.previewStart).mockResolvedValue({ valid: false, packetHash: null, packet: null, review: null, alignmentQuestion: "What external result should change?" } as never);
    const container = renderDialog();
    change(field("Goal"), "Explore");
    await waitUntil(() => {
      expect(button("Save draft")).not.toBeNull();
      expect(button("Save draft")?.disabled).toBe(false);
    });
    expect(container.textContent).toContain("What external result should change?");
    act(() => button("Save draft")?.click());
    await waitUntil(() => expect(goalsApi.create).toHaveBeenCalledWith("org-1", expect.objectContaining({
      title: "Explore",
      alignmentQuestion: "What external result should change?",
    })));
    expect(goalsApi.start).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/goals/draft-1");
  });

  it("keeps Draft creation available when the preview service is unavailable", async () => {
    vi.mocked(goalsApi.previewStart).mockRejectedValue(new Error("Preview unavailable"));
    const container = renderDialog();
    change(field("Goal"), "Save despite preview outage");

    await waitUntil(() => {
      expect(container.textContent).toContain("Preview unavailable");
      expect(button("Retry preview")).not.toBeNull();
      expect(button("Save draft")?.disabled).toBe(false);
    });

    act(() => button("Save draft")?.click());
    await waitUntil(() => expect(goalsApi.create).toHaveBeenCalledWith("org-1", expect.objectContaining({
      title: "Save despite preview outage",
    })));
    expect(goalsApi.start).not.toHaveBeenCalled();
  });

  it("continues an existing Draft through the same plain-language start path", async () => {
    newGoalDefaults = {
      draftId: "draft-1",
      title: "Continue the Goal alignment",
      context: "Clarify the external result before work starts.",
      ownerAgentId: "agent-1",
    };
    const container = renderDialog();
    await waitUntil(() => expect(button("Create and start")?.disabled).toBe(false));
    act(() => button("Create and start")?.click());
    await waitUntil(() => expect(navigate).toHaveBeenCalledWith("/goals/goal-1"));
    expect(goalsApi.start).toHaveBeenCalledWith("org-1", expect.objectContaining({ draftGoalId: "draft-1" }));
    expect(goalsApi.create).not.toHaveBeenCalled();
    expect(goalsApi.update).not.toHaveBeenCalled();
  });
});
