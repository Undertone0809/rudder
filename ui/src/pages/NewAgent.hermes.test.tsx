// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";

const mockState = vi.hoisted(() => ({
  agents: [] as unknown[],
  readyAvailability: {
    agentRuntimeType: "hermes_gateway",
    status: "available",
    hermesLocalBackend: "acp",
    hermesProductRpcCapabilityGap: "yaml_missing",
    resolvedCommand: "/opt/hermes/bin/hermes",
    message: "ACP local setup passed",
    hint: "Product RPC is unavailable",
  },
  availability: [{
    agentRuntimeType: "hermes_gateway",
    status: "available",
    hermesLocalBackend: "acp",
    hermesProductRpcCapabilityGap: "yaml_missing",
    resolvedCommand: "/opt/hermes/bin/hermes",
    message: "ACP local setup passed",
    hint: "Product RPC is unavailable",
  }],
  models: [] as unknown[],
  organizationSkills: [] as unknown[],
  nameSuggestion: { name: "Hermes helper" },
  created: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[2] === "adapter-availability") {
      return { data: mockState.availability, isPending: false };
    }
    if (queryKey[2] === "adapter-models") return { data: mockState.models };
    if (queryKey[2] === "name-suggestion") return { data: mockState.nameSuggestion };
    if (queryKey[0] === "organization-skills") {
      return { data: mockState.organizationSkills, isPending: false };
    }
    if (queryKey[0] === "agents") return { data: mockState.agents, isPending: false };
    return { data: undefined, isPending: false };
  },
  useMutation: () => ({
    mutate: (values: Record<string, unknown>) => mockState.created.push(values),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    adapterAvailability: vi.fn(),
    adapterModels: vi.fn(),
    suggestName: vi.fn(),
    hire: vi.fn(),
  },
}));

vi.mock("../api/organizationSkills", () => ({
  organizationSkillsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../agent-runtimes", () => ({
  getUIAdapter: () => ({
    buildAdapterConfig: (values: { hermesConnectionMode?: string }) => ({
      hermesConnectionMode: values.hermesConnectionMode,
    }),
  }),
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => (
    <div data-testid="advanced-runtime-config">
      <button type="button">Test runtime chain</button>
      <button type="button">Add fallback model</button>
      <label>
        Environment variables
        <input aria-label="Environment variables" />
      </label>
    </div>
  ),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockState.setBreadcrumbs }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", name: "Rudder", urlKey: "rudder" },
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockState.navigate,
  useSearchParams: () => [
    new URLSearchParams("agentRuntimeType=hermes_gateway&hermesConnectionMode=local"),
  ],
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<NewAgent />));
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
  mockState.created.length = 0;
  mockState.availability = [mockState.readyAvailability];
  mockState.navigate.mockClear();
  mockState.setBreadcrumbs.mockClear();
});

describe("NewAgent local Hermes creation", () => {
  it("keeps basic identity and local permission context visible while deferring runtime configuration", () => {
    const container = renderPage();
    const text = container.textContent ?? "";
    const advancedSettings = container.querySelector<HTMLDetailsElement>(
      "details[data-testid='new-agent-advanced-settings']",
    );

    expect(container.querySelector('input[placeholder="Agent name"]')).not.toBeNull();
    expect(container.querySelector('input[placeholder^="Title"]')).not.toBeNull();
    expect(text).toContain("This will be the root agent for the organization.");
    expect(text).toContain("You don't need to enter a server address or API key.");
    expect(text).toContain("uses the Hermes setup and access permissions already configured on this machine.");
    expect(text).toContain("Hermes is ready locally. Rudder will connect automatically.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);

    expect(advancedSettings).not.toBeNull();
    expect(advancedSettings?.open).toBe(false);
    expect(advancedSettings?.querySelector("summary")?.textContent).toBe("Advanced settings");
    expect(advancedSettings?.querySelector("[data-testid='advanced-runtime-config']")?.textContent)
      .toContain("Test runtime chain");
    expect(advancedSettings?.querySelector("[data-testid='advanced-runtime-config']")?.textContent)
      .toContain("Add fallback model");
    expect(advancedSettings?.querySelector("[aria-label='Environment variables']")?.closest("details"))
      .toBe(advancedSettings);
  });

  it("creates a local Hermes agent without a server address or API key", async () => {
    const container = renderPage();
    const createButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create agent");

    expect(createButton).toBeDefined();
    expect((createButton as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      createButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockState.created).toHaveLength(1);
    expect(mockState.created[0]).toMatchObject({
      name: "Hermes helper",
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: { hermesConnectionMode: "local" },
    });
  });

  it("keeps unavailable Hermes guidance product-facing and blocks creation", () => {
    mockState.availability = [{
      ...mockState.readyAvailability,
      status: "unavailable",
      message: "ACP setup failed: native Product RPC backend is missing",
      hint: "Set the API key and retry the backend probe.",
    }];
    const container = renderPage();
    const text = container.textContent ?? "";
    const createButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create agent");

    expect(text).toContain("Hermes isn't ready on this machine yet. Install or finish setting it up, then try again.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);
    expect((createButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
  });
});
