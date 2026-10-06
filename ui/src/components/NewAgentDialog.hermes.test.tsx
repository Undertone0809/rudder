// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";

const mockState = vi.hoisted(() => ({
  readyAvailability: {
    agentRuntimeType: "hermes_gateway",
    status: "available",
    hermesLocalBackend: "acp",
    hermesProductRpcCapabilityGap: "yaml_missing",
    message: "ACP local setup passed",
    hint: "Product RPC is unavailable",
  },
  availability: [{
    agentRuntimeType: "hermes_gateway",
    status: "available",
    hermesLocalBackend: "acp",
    hermesProductRpcCapabilityGap: "yaml_missing",
    message: "ACP local setup passed",
    hint: "Product RPC is unavailable",
  }],
  availabilityError: false,
  retryAvailability: vi.fn(async () => undefined),
  rerender: null as null | (() => void),
  navigate: vi.fn(),
  closeNewAgent: vi.fn(),
  openNewIssue: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => queryKey[2] === "adapter-availability"
    ? {
        data: mockState.availability,
        isPending: false,
        isFetching: false,
        isError: mockState.availabilityError,
        refetch: mockState.retryAvailability,
      }
    : { data: [] },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    adapterAvailability: vi.fn(),
  },
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newAgentOpen: true,
    closeNewAgent: mockState.closeNewAgent,
    openNewIssue: mockState.openNewIssue,
  }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockState.navigate,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => act(() => root.render(<NewAgentDialog />));
  render();
  mockState.rerender = render;
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  mockState.navigate.mockClear();
  mockState.closeNewAgent.mockClear();
  mockState.openNewIssue.mockClear();
  mockState.availability = [mockState.readyAvailability];
  mockState.availabilityError = false;
  mockState.retryAvailability.mockReset().mockResolvedValue(undefined);
  mockState.rerender = null;
});

describe("NewAgentDialog Hermes path", () => {
  it("offers the detected local Hermes path before advanced setup", async () => {
    const container = renderDialog();
    const text = container.textContent ?? "";

    expect(text).toContain("Create with Hermes");
    expect(text).toContain("Hermes was found on this machine. Rudder will use its existing provider setup.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);
    expect([...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Hermes")))
      .toHaveLength(1);

    const createWithHermes = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Create with Hermes"));
    expect(createWithHermes).toBeDefined();
    await act(async () => {
      createWithHermes!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockState.closeNewAgent).toHaveBeenCalledOnce();
    expect(mockState.navigate).toHaveBeenCalledWith(
      "/agents/new?agentRuntimeType=hermes_gateway&hermesConnectionMode=local",
    );
  });

  it("keeps Hermes out of the advanced list so it has one selectable path", async () => {
    const container = renderDialog();
    const advancedButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("I want advanced configuration myself"));

    expect(advancedButton).toBeDefined();
    await act(async () => {
      advancedButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\bHermes\b/);
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);
  });

  it("keeps unavailable setup guidance product-facing and offers retry", async () => {
    mockState.availability = [{
      ...mockState.readyAvailability,
      status: "unavailable",
      message: "ACP setup failed: native Product RPC backend is missing",
      hint: "Set the API key and retry the backend probe.",
    }];
    const container = renderDialog();
    expect(container.textContent).toContain(
      "Hermes isn't ready on this machine. Install or finish setting it up, then retry.",
    );
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Retry"))
      .toBe(true);
    expect(container.textContent).not.toMatch(/ACP|Product RPC|backend/i);
    expect(container.textContent).not.toContain("Hermes (legacy local)");
  });

  it("retries failed Hermes detection and recovers to the ready state", async () => {
    mockState.availability = [];
    mockState.availabilityError = true;
    mockState.retryAvailability.mockImplementationOnce(async () => {
      mockState.availability = [mockState.readyAvailability];
      mockState.availabilityError = false;
    });

    const container = renderDialog();
    expect(container.textContent).toContain(
      "Couldn't check Hermes on this machine. Restart Rudder, then retry.",
    );
    const retryButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Retry");
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    mockState.rerender?.();

    expect(mockState.retryAvailability).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "Hermes was found on this machine. Rudder will use its existing provider setup.",
    );
    expect(container.textContent).not.toContain("Couldn't check Hermes");
  });
});
