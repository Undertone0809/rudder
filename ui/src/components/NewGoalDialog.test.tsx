// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
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
  DialogDescription: ({ children, ...props }: { children: ReactNode }) => <p {...props}>{children}</p>,
  DialogTitle: ({ children, ...props }: { children: ReactNode }) => <h2 {...props}>{children}</h2>,
}));
vi.mock("../context/DialogContext", () => ({ useDialog: () => ({ newGoalOpen: true, newGoalDefaults, closeNewGoal }) }));
vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1", selectedOrganization: { id: "org-1", name: "Rudder" } }),
}));
vi.mock("./AssigneeLabel", () => ({ AgentMenuLabel: ({ agent }: { agent: { name: string } }) => <span>{agent.name}</span> }));
vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: ({ value, options, ariaLabel, onChange, disablePortal, side }: {
    value: string;
    options: Array<{ id: string; label: string }>;
    ariaLabel: string;
    onChange: (id: string) => void;
    disablePortal?: boolean;
    side?: "top" | "right" | "bottom" | "left";
  }) => <button
    type="button"
    aria-label={ariaLabel}
    data-option-count={options.length}
    data-disable-portal={disablePortal ? "true" : "false"}
    data-side={side}
    onClick={() => {
      const currentIndex = options.findIndex((option) => option.id === value);
      onChange(options[(currentIndex + 1) % options.length]?.id ?? "");
    }}
  >{options.find((option) => option.id === value)?.label ?? "No assignee"}</button>,
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MarkdownEditorMock({
    value,
    onChange,
    ariaLabel,
    documentIdentity,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
    documentIdentity: string;
  }, ref) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      insertTextAtSelection: () => false,
    }));
    return (
      <textarea
        ref={inputRef}
        aria-label={ariaLabel}
        data-document-identity={documentIdentity}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Context" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { previewStart: vi.fn(), start: vi.fn(), create: vi.fn(), update: vi.fn() } }));

const agent = { id: "agent-1", name: "Workspace owner", title: "Operator", role: "engineer", status: "idle" };
const alternateAgent = { id: "agent-2", name: "Verification owner", title: "Reviewer", role: "engineer", status: "idle" };
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
  blockers: [],
  warning: null,
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
  vi.mocked(agentsApi.list).mockResolvedValue([agent, alternateAgent] as never);
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
  it("changes the Markdown document identity between create sessions", () => {
    renderDialog();
    const firstIdentity = field("Context").dataset.documentIdentity;

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());

    expect(field("Context").dataset.documentIdentity).not.toBe(firstIdentity);
  });

  it("previews and starts without internal Contract fields, retaining the request key on retry", async () => {
    vi.mocked(goalsApi.start).mockRejectedValueOnce(new Error("The response was lost")).mockResolvedValueOnce({ id: "goal-1" } as never);
    const container = renderDialog();
    change(field("Goal"), "Ship Goal Workspace");
    change(field("Context"), "Keep the operator journey inspectable.");

    for (const hidden of ["Objective mode", "Evaluator", "Allowed autonomy", "Initial Plan"]) {
      expect(container.textContent).not.toContain(hidden);
    }
    await waitUntil(() => {
      expect(button("Start Goal")).not.toBeNull();
      expect(button("Start Goal")?.disabled).toBe(false);
    });
    expect(container.textContent).toContain("How we will know it worked");
    expect(container.textContent).toContain("The operator workflow passes");
    expect(container.textContent).toContain("First action");

    act(() => button("Start Goal")?.click());
    await waitUntil(() => expect(container.querySelector("[role=alert]")?.textContent).toContain("Unable to start this Goal right now"));
    act(() => button("Start Goal")?.click());
    await waitUntil(() => expect(navigate).toHaveBeenCalledWith("/goals/goal-1"));

    const firstPayload = vi.mocked(goalsApi.start).mock.calls[0]?.[1] as Record<string, unknown>;
    const retryPayload = vi.mocked(goalsApi.start).mock.calls[1]?.[1] as Record<string, unknown>;
    expect(firstPayload.requestKey).toBe("request-key-1");
    expect(retryPayload.requestKey).toBe("request-key-1");
    expect(firstPayload.packetHash).toBe(validPreview.packetHash);
    expect(firstPayload.packet).toBe(validPreview.packet);
    expect(firstPayload).not.toHaveProperty("allowCapabilityMismatch");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("does not silently assign the first Agent", async () => {
    const container = renderDialog();
    await waitUntil(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.dataset.optionCount).toBe("2"));
    await waitUntil(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.textContent).toBe("No assignee"));
    expect(goalsApi.previewStart).not.toHaveBeenCalledWith("org-1", expect.objectContaining({ ownerAgentId: agent.id }));
  });

  it("requires explicit confirmation before starting with a capability warning", async () => {
    vi.mocked(goalsApi.previewStart).mockResolvedValue({
      ...validPreview,
      warning: "This Agent may not be the best match for this Goal.",
    } as never);
    newGoalDefaults = { ownerAgentId: agent.id };
    const container = renderDialog();
    change(field("Goal"), "Publish the release notes");

    await waitUntil(() => {
      expect(container.textContent).toContain("This Agent may not be the best match for this Goal.");
      expect(button("Start Goal")?.disabled).toBe(false);
    });
    expect(button("Save draft")).not.toBeNull();
    act(() => button("Start Goal")?.click());
    await waitUntil(() => expect(navigate).toHaveBeenCalledWith("/goals/goal-1"));
    expect(goalsApi.start).toHaveBeenCalledWith("org-1", expect.objectContaining({
      allowCapabilityMismatch: true,
      packetHash: validPreview.packetHash,
    }));
    expect(goalsApi.create).not.toHaveBeenCalled();
  });

  it("does not start from a stale preview after assignee and target time change", async () => {
    const updatedPreview = {
      ...validPreview,
      packetHash: "b".repeat(64),
      packet: {
        ...validPreview.packet,
        ownerAgentId: "agent-2",
        targetTime: new Date("2026-08-25T14:30").toISOString(),
      },
      review: { ...validPreview.review, owner: "Verification owner" },
    };
    vi.mocked(goalsApi.previewStart).mockImplementation(async (_orgId, input) => (
      input.ownerAgentId === "agent-2" ? updatedPreview : validPreview
    ) as never);
    newGoalDefaults = { ownerAgentId: agent.id };
    const container = renderDialog();
    change(field("Goal"), "Ship Goal Workspace");
    await waitUntil(() => expect(button("Start Goal")?.disabled).toBe(false));

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.click());
    change(field("Target time"), "2026-08-25T14:30");

    expect(button("Start Goal")?.disabled).toBe(true);
    act(() => button("Start Goal")?.click());
    expect(goalsApi.start).not.toHaveBeenCalled();

    await waitUntil(() => expect(button("Start Goal")?.disabled).toBe(false));
    act(() => button("Start Goal")?.click());
    await waitUntil(() => expect(navigate).toHaveBeenCalledWith("/goals/goal-1"));

    expect(goalsApi.previewStart).toHaveBeenLastCalledWith("org-1", expect.objectContaining({
      ownerAgentId: "agent-2",
      targetTime: new Date("2026-08-25T14:30").toISOString(),
    }));
    expect(goalsApi.start).toHaveBeenCalledWith("org-1", expect.objectContaining({
      packetHash: updatedPreview.packetHash,
      packet: updatedPreview.packet,
    }));
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("keeps the eligible Goal-owner menu portaled and excludes invalid defaults", async () => {
    const pendingAgent = { id: "agent-pending", name: "Pending owner", title: null, role: "engineer", status: "pending_approval" };
    const terminatedAgent = { id: "agent-terminated", name: "Terminated owner", title: null, role: "engineer", status: "terminated" };
    newGoalDefaults = { ownerAgentId: pendingAgent.id };
    vi.mocked(agentsApi.list).mockResolvedValue([pendingAgent, terminatedAgent, agent, alternateAgent] as never);

    const container = renderDialog();
    await waitUntil(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.dataset.optionCount).toBe("2"));
    await waitUntil(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.textContent).toBe("No assignee"));
    const assignee = container.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')!;

    expect(assignee.dataset.disablePortal).toBe("false");
    expect(assignee.dataset.side).toBe("top");
    act(() => assignee.click());
    await waitUntil(() => expect(assignee.textContent).toBe(agent.name));
    act(() => assignee.click());
    expect(assignee.textContent).toBe(alternateAgent.name);
    expect(container.textContent).not.toContain(pendingAgent.name);
    expect(container.textContent).not.toContain(terminatedAgent.name);
  });

  it("does not treat an Agent loading failure as an empty list", async () => {
    vi.mocked(agentsApi.list).mockRejectedValueOnce(new Error("Failed to fetch"));
    const container = renderDialog();
    change(field("Goal"), "Ship Goal Workspace");

    await waitUntil(() => {
      expect(container.textContent).toContain("Available Agents could not be loaded");
      expect(button("Retry Agents")).not.toBeNull();
      expect(button("Start Goal")?.disabled).toBe(true);
    });
  });

  it("explains how to continue when no Agent is available", async () => {
    vi.mocked(agentsApi.list).mockResolvedValueOnce([] as never);
    const container = renderDialog();

    await waitUntil(() => {
      expect(container.textContent).toContain("No available Agents yet");
      expect(button("Open Agents")).not.toBeNull();
    });
    act(() => button("Open Agents")?.click());
    expect(closeNewGoal).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/agents");
  });

  it("saves an invalid preview as a Draft with its alignment question", async () => {
    vi.mocked(goalsApi.previewStart).mockResolvedValue({
      valid: false,
      packetHash: null,
      packet: null,
      review: null,
      blockers: [{ code: "outcome_required", field: "goal", message: "Describe a verifiable result." }],
      alignmentQuestion: "What external result should change?",
      warning: null,
    } as never);
    const container = renderDialog();
    change(field("Goal"), "Explore");
    change(field("Target time"), "2026-08-20T10:00");
    await waitUntil(() => {
      expect(button("Save draft")).not.toBeNull();
      expect(button("Save draft")?.disabled).toBe(false);
      expect(button("Start Goal")?.disabled).toBe(true);
      expect(container.textContent).toContain("Describe a verifiable result.");
    });
    expect(container.textContent).toContain("Describe a verifiable result.");
    expect(container.textContent).toContain("What external result should change?");
    act(() => button("Save draft")?.click());
    await waitUntil(() => expect(goalsApi.create).toHaveBeenCalledWith("org-1", expect.objectContaining({
      title: "Explore",
      ownerAgentId: null,
      targetTime: new Date("2026-08-20T10:00").toISOString(),
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
      targetTime: "2026-08-20T10:00",
    };
    const container = renderDialog();
    await waitUntil(() => expect(button("Start Goal")?.disabled).toBe(false));
    act(() => button("Start Goal")?.click());
    await waitUntil(() => expect(navigate).toHaveBeenCalledWith("/goals/goal-1"));
    expect(goalsApi.start).toHaveBeenCalledWith("org-1", expect.objectContaining({ draftGoalId: "draft-1" }));
    expect(goalsApi.create).not.toHaveBeenCalled();
    expect(goalsApi.update).not.toHaveBeenCalled();
  });

  it("persists changed assignee and target time when an existing Draft still needs alignment", async () => {
    newGoalDefaults = {
      draftId: "draft-1",
      title: "Explore the release path",
      context: "Keep the draft while the outcome is clarified.",
      ownerAgentId: "agent-1",
      targetTime: "2026-08-20T10:00",
    };
    vi.mocked(goalsApi.previewStart).mockResolvedValue({
      valid: false,
      packetHash: null,
      packet: null,
      review: null,
      blockers: [{ code: "outcome_required", field: "goal", message: "Describe a verifiable result." }],
      alignmentQuestion: "What external result should change?",
      warning: null,
    } as never);
    const container = renderDialog();

    await waitUntil(() => {
      expect(button("Save draft")?.disabled).toBe(false);
      expect(container.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.textContent).toBe(agent.name);
    });
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Assignee"]')?.click());
    change(field("Target time"), "2026-08-25T14:30");
    await waitUntil(() => {
      expect(button("Save draft")?.disabled).toBe(false);
      expect(vi.mocked(goalsApi.previewStart)).toHaveBeenLastCalledWith("org-1", expect.objectContaining({ ownerAgentId: "agent-2" }));
    });
    act(() => button("Save draft")?.click());

    await waitUntil(() => expect(goalsApi.update).toHaveBeenCalledWith("draft-1", expect.objectContaining({
      ownerAgentId: "agent-2",
      targetTime: new Date("2026-08-25T14:30").toISOString(),
      alignmentQuestion: "What external result should change?",
    })));
  });
});
