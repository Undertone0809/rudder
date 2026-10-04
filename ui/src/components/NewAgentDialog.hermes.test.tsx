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
  navigate: vi.fn(),
  closeNewAgent: vi.fn(),
  openNewIssue: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[2] === "adapter-availability" ? mockState.availability : [],
  }),
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
  act(() => root.render(<NewAgentDialog />));
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
});

describe("NewAgentDialog Hermes path", () => {
  it("offers the detected local Hermes path before advanced setup", async () => {
    const container = renderDialog();
    const text = container.textContent ?? "";

    expect(text).toContain("Create with Hermes");
    expect(text).toContain("Hermes is ready locally. Rudder will connect automatically.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);

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

  it("keeps Hermes in the advanced runtime list with product-facing readiness copy", async () => {
    const container = renderDialog();
    const advancedButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("I want advanced configuration myself"));

    expect(advancedButton).toBeDefined();
    await act(async () => {
      advancedButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Hermes");
    expect(text).toContain("Ready locally. Rudder will connect automatically.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);
  });

  it("does not expose local setup diagnostics in unavailable-state text or tooltips", async () => {
    mockState.availability = [{
      ...mockState.readyAvailability,
      status: "unavailable",
      message: "ACP setup failed: native Product RPC backend is missing",
      hint: "Set the API key and retry the backend probe.",
    }];
    const container = renderDialog();
    const advancedButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("I want advanced configuration myself"));

    await act(async () => {
      advancedButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const hermesChoice = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Hermes"));
    expect(hermesChoice?.textContent).toContain("Needs setup on this machine.");
    expect(hermesChoice?.getAttribute("title")).toBe("Hermes needs setup on this machine.");
    expect(container.textContent).not.toMatch(/ACP|Product RPC|backend/i);
  });
});
