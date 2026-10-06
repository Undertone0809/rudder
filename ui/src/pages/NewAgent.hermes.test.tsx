// @vitest-environment jsdom

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
  availabilityError: false,
  retryAvailability: vi.fn(async () => undefined),
  rerender: null as null | (() => void),
  routeSearchParams: "agentRuntimeType=hermes_gateway",
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
      return {
        data: mockState.availability,
        isPending: false,
        isFetching: false,
        isError: mockState.availabilityError,
        refetch: mockState.retryAvailability,
      };
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
    buildAdapterConfig: (values: { hermesConnectionMode?: string; url?: string; apiKey?: string }) => ({
      hermesConnectionMode: values.hermesConnectionMode,
      ...(values.hermesConnectionMode === "custom"
        ? { url: values.url, apiKey: values.apiKey }
        : {}),
    }),
  }),
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: ({
    values,
    onChange,
  }: {
    values: { hermesConnectionMode?: string; url?: string; apiKey?: string };
    onChange: (patch: Record<string, unknown>) => void;
  }) => (
    <div data-testid="advanced-runtime-config">
      {values.hermesConnectionMode === "custom" && (
        <>
          <label>
            Hermes API Server URL
            <input
              aria-label="Hermes API Server URL"
              value={values.url ?? ""}
              onChange={(event) => onChange({ url: event.currentTarget.value })}
            />
          </label>
          <label>
            API Server key
            <input
              aria-label="API Server key"
              type="password"
              value={values.apiKey ?? ""}
              onChange={(event) => onChange({ apiKey: event.currentTarget.value })}
            />
          </label>
        </>
      )}
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
    new URLSearchParams(mockState.routeSearchParams),
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
  const render = () => act(() => root.render(<NewAgent />));
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
  mockState.created.length = 0;
  mockState.availability = [mockState.readyAvailability];
  mockState.availabilityError = false;
  mockState.routeSearchParams = "agentRuntimeType=hermes_gateway";
  mockState.retryAvailability.mockReset().mockResolvedValue(undefined);
  mockState.rerender = null;
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
    expect(text).toContain("Hermes was found on this machine. Rudder will use its existing provider setup.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);

    expect(advancedSettings).not.toBeNull();
    expect(advancedSettings?.open).toBe(false);
    expect(advancedSettings?.querySelector("[aria-label='Hermes API Server URL']")).toBeNull();
    expect(advancedSettings?.querySelector("[aria-label='API Server key']")).toBeNull();
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
    expect(container.querySelector("input[aria-label='Hermes API Server URL']")).toBeNull();
    expect(container.querySelector("input[aria-label='API Server key']")).toBeNull();
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

  it("shows custom Hermes controls and preserves required-field validation and submission", async () => {
    mockState.routeSearchParams = "agentRuntimeType=hermes_gateway&hermesConnectionMode=custom";
    const container = renderPage();
    const advancedSettings = container.querySelector<HTMLDetailsElement>(
      "details[data-testid='new-agent-advanced-settings']",
    );
    const serverUrl = container.querySelector<HTMLInputElement>(
      "input[aria-label='Hermes API Server URL']",
    );
    const apiKey = container.querySelector<HTMLInputElement>(
      "input[aria-label='API Server key']",
    );

    expect(advancedSettings?.open).toBe(true);
    expect(serverUrl).not.toBeNull();
    expect(apiKey?.type).toBe("password");
    expect(container.textContent).toContain("Hermes API Server URL");
    expect(container.textContent).toContain("API Server key");

    const createButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create agent");
    expect(createButton).toBeDefined();
    await act(async () => {
      createButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain(
      "Custom Hermes connections need both a URL and an API key. Choose local Hermes to use this machine's existing setup.",
    );
    expect(mockState.created).toHaveLength(0);

    const setInputValue = (input: HTMLInputElement, value: string) => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setInputValue(serverUrl!, "http://127.0.0.1:18642");
      setInputValue(apiKey!, "custom-hermes-key");
    });

    await act(async () => {
      createButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain(
      "Custom Hermes connections need both a URL and an API key.",
    );
    expect(mockState.created).toHaveLength(1);
    expect(mockState.created[0]).toMatchObject({
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: {
        hermesConnectionMode: "custom",
        url: "http://127.0.0.1:18642",
        apiKey: "custom-hermes-key",
      },
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

    expect(text).toContain("Hermes isn't ready on this machine yet. Install or finish setting it up, then retry.");
    expect(text).not.toMatch(/ACP|Product RPC|backend/i);
    expect((createButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Retry"))
      .toBe(true);
    expect(text).not.toContain("API key and retry the backend probe");
  });

  it("retries failed local detection and allows creation after Hermes becomes available", async () => {
    mockState.availability = [];
    mockState.availabilityError = true;
    mockState.retryAvailability.mockImplementationOnce(async () => {
      mockState.availability = [mockState.readyAvailability];
      mockState.availabilityError = false;
    });

    const container = renderPage();
    expect(container.textContent).toContain(
      "Couldn't check Hermes on this machine. Restart Rudder, then retry.",
    );
    const createButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create agent");
    const retryButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Retry");
    expect((createButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
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
    const recoveredCreateButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Create agent");
    expect((recoveredCreateButton as HTMLButtonElement | undefined)?.disabled).toBe(false);
    await act(async () => {
      recoveredCreateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockState.created).toHaveLength(1);
    expect(mockState.created[0]).toMatchObject({
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: { hermesConnectionMode: "local" },
    });
  });
});
