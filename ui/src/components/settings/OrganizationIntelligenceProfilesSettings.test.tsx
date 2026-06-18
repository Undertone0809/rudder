// @vitest-environment jsdom

import { agentsApi } from "@/api/agents";
import { organizationsApi } from "@/api/orgs";
import { secretsApi } from "@/api/secrets";
import type { AgentRuntimeEnvironmentTestResult, OrganizationIntelligenceProfile } from "@rudderhq/shared";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationIntelligenceProfilesSettings } from "./OrganizationIntelligenceProfilesSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn(),
    testEnvironment: vi.fn(),
  },
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    listIntelligenceProfiles: vi.fn(),
    updateIntelligenceProfile: vi.fn(),
  },
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    list: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/AgentConfigForm.environment", () => ({
  AdapterEnvironmentResult: ({ label }: { label?: string }) => (
    <div>{label ? `${label}: Passed` : "Passed"}</div>
  ),
  AdapterEnvironmentError: ({ label, message }: { label: string; message: string }) => (
    <div>{label}: Failed {message}</div>
  ),
  RuntimeProviderCard: ({
    title,
    model,
    environmentStatus,
    disabled,
  }: {
    title: string;
    model: string;
    environmentStatus?: string;
    disabled?: boolean;
  }) => (
    <div>
      {title} {model} {environmentStatus ? `Env ${environmentStatus}` : ""}
      <button disabled={disabled}>{title} model control</button>
    </div>
  ),
}));

vi.mock("@tanstack/react-query", async () => {
  const React = await import("react");
  return {
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "organizations") {
        return { data: profiles, isLoading: false, isError: false, error: null };
      }
      if (queryKey[0] === "secrets") {
        return { data: [], isLoading: false, isError: false, error: null };
      }
      if (queryKey[0] === "agents") {
        return { data: [], isLoading: false, isError: false, error: null };
      }
      return { data: null, isLoading: false, isError: false, error: null };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useMutation: ({ mutationFn, onSuccess }: {
      mutationFn: (variables: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown) => void;
    }) => {
      const [isPending, setIsPending] = React.useState(false);
      const [variables, setVariables] = React.useState<unknown>(undefined);
      const [error, setError] = React.useState<unknown>(null);
      return {
        isPending,
        variables,
        error,
        isError: Boolean(error),
        mutate: (nextVariables: unknown) => {
          setIsPending(true);
          setVariables(nextVariables);
          void mutationFn(nextVariables)
            .then((data) => {
              onSuccess?.(data);
              setError(null);
            })
            .catch(setError)
            .finally(() => setIsPending(false));
        },
        mutateAsync: async (nextVariables: unknown) => {
          setIsPending(true);
          setVariables(nextVariables);
          try {
            const data = await mutationFn(nextVariables);
            onSuccess?.(data);
            setError(null);
            return data;
          } catch (nextError) {
            setError(nextError);
            throw nextError;
          } finally {
            setIsPending(false);
          }
        },
      };
    },
  };
});

let profiles: OrganizationIntelligenceProfile[];

const baseProfiles: OrganizationIntelligenceProfile[] = [
  {
    id: "profile-lightweight",
    orgId: "org-1",
    purpose: "lightweight",
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {
      model: "gpt-5.4-mini",
      modelReasoningEffort: "low",
      modelFallbacks: [
        {
          agentRuntimeType: "claude_local",
          model: "claude-sonnet-4-5",
          config: {
            model: "claude-sonnet-4-5",
            effort: "medium",
          },
        },
      ],
    },
    status: "configured",
    lastError: null,
    lastVerifiedAt: null,
    createdAt: new Date("2026-06-16T08:00:00.000Z"),
    updatedAt: new Date("2026-06-16T08:00:00.000Z"),
  },
  {
    id: "profile-reasoning",
    orgId: "org-1",
    purpose: "reasoning",
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {
      model: "gpt-5.4",
      modelReasoningEffort: "medium",
    },
    status: "configured",
    lastError: null,
    lastVerifiedAt: null,
    createdAt: new Date("2026-06-16T08:00:00.000Z"),
    updatedAt: new Date("2026-06-16T08:00:00.000Z"),
  },
];

async function renderComponent() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(<OrganizationIntelligenceProfilesSettings orgId="org-1" />);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function passedResult(): AgentRuntimeEnvironmentTestResult {
  return {
    agentRuntimeType: "codex_local",
    status: "pass",
    testedAt: "2026-06-16T08:30:00.000Z",
    checks: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("OrganizationIntelligenceProfilesSettings", () => {
  beforeEach(() => {
    profiles = structuredClone(baseProfiles);
    vi.mocked(organizationsApi.listIntelligenceProfiles).mockResolvedValue(profiles);
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(agentsApi.adapterModels).mockResolvedValue([]);
    vi.mocked(agentsApi.testEnvironment).mockResolvedValue(passedResult());
    vi.mocked(organizationsApi.updateIntelligenceProfile).mockImplementation(async (_orgId, purpose, data) => ({
      id: `profile-${purpose}`,
      orgId: "org-1",
      purpose,
      agentRuntimeType: data.agentRuntimeType,
      agentRuntimeConfig: data.agentRuntimeConfig,
      status: data.status ?? "configured",
      lastError: null,
      lastVerifiedAt: null,
      createdAt: new Date("2026-06-16T08:00:00.000Z"),
      updatedAt: new Date("2026-06-16T08:30:00.000Z"),
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("tests the selected organization intelligence profile runtime chain", async () => {
    const rendered = await renderComponent();
    await vi.waitFor(() => {
      expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).not.toBeNull();
    });

    const fastProfile = rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]');
    const testButton = Array.from(fastProfile?.querySelectorAll("button") ?? [])
      .find((button) => button.getAttribute("aria-label") === "Test runtime chain");
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(agentsApi.testEnvironment).toHaveBeenNthCalledWith(1, "org-1", "codex_local", {
      agentRuntimeConfig: {
        model: "gpt-5.4-mini",
        modelReasoningEffort: "low",
      },
    });
    expect(agentsApi.testEnvironment).toHaveBeenNthCalledWith(2, "org-1", "claude_local", {
      agentRuntimeConfig: {
        model: "claude-sonnet-4-5",
        effort: "medium",
      },
    });
    expect(fastProfile?.textContent).toContain("Runtime chain environment");
    expect(fastProfile?.textContent).toContain("Primary · Codex (local) · gpt-5.4-mini: Passed");
    expect(fastProfile?.textContent).toContain("Fallback 1 · Claude (local) · claude-sonnet-4-5: Passed");

    rendered.cleanup();
  });

  it("enables a disabled profile without retesting when the selected chain already passed", async () => {
    profiles[0] = { ...profiles[0]!, status: "disabled" };
    const rendered = await renderComponent();
    await vi.waitFor(() => {
      expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).not.toBeNull();
    });

    const fastProfile = rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')!;
    const testButton = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Test runtime chain");
    const enableButton = () => Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enable"));

    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(agentsApi.testEnvironment).toHaveBeenCalledTimes(2);

    const update = deferred<OrganizationIntelligenceProfile>();
    vi.mocked(organizationsApi.updateIntelligenceProfile).mockImplementationOnce(async () => update.promise);
    await act(async () => {
      enableButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fastProfile.textContent).toContain("Enabling...");
    expect(fastProfile.textContent).not.toContain("Testing...");
    update.resolve({
      ...profiles[0]!,
      status: "configured",
      lastVerifiedAt: new Date("2026-06-16T08:30:00.000Z"),
    });
    await act(async () => {
      await update.promise;
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(organizationsApi.updateIntelligenceProfile).toHaveBeenCalledWith("org-1", "lightweight", {
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4-mini",
        modelReasoningEffort: "low",
        modelFallbacks: [
          {
            agentRuntimeType: "claude_local",
            model: "claude-sonnet-4-5",
            config: {
              model: "claude-sonnet-4-5",
              effort: "medium",
            },
          },
        ],
      },
      status: "configured",
    });

    rendered.cleanup();
  });

  it("keeps other profiles interactive while one enable flow is testing a chain", async () => {
    profiles[0] = { ...profiles[0]!, status: "disabled" };
    profiles[1] = { ...profiles[1]!, status: "disabled" };
    const firstProbe = deferred<AgentRuntimeEnvironmentTestResult>();
    vi.mocked(agentsApi.testEnvironment)
      .mockImplementationOnce(async () => firstProbe.promise)
      .mockResolvedValue(passedResult());
    const rendered = await renderComponent();
    await vi.waitFor(() => {
      expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).not.toBeNull();
    });

    const fastProfile = rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')!;
    const smartProfile = rendered.host.querySelector('[data-testid="intelligence-profile-reasoning"]')!;
    const fastEnableButton = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enable"));
    const smartTestButton = Array.from(smartProfile.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Test runtime chain") as HTMLButtonElement;
    const smartEnableButton = Array.from(smartProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enable")) as HTMLButtonElement;
    const smartAddFallbackButton = Array.from(smartProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add fallback model")) as HTMLButtonElement;
    const fastAddFallbackButton = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add fallback model")) as HTMLButtonElement;
    const fastModelControl = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Primary model control")) as HTMLButtonElement;

    await act(async () => {
      fastEnableButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fastProfile.textContent).toContain("Testing...");
    expect(fastAddFallbackButton.disabled).toBe(true);
    expect(fastModelControl.disabled).toBe(true);
    expect(smartTestButton.disabled).toBe(false);
    expect(smartEnableButton.disabled).toBe(false);
    expect(smartAddFallbackButton.disabled).toBe(false);

    await act(async () => {
      smartTestButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(smartProfile.textContent).toContain("Runtime chain environment");
    expect(smartProfile.textContent).toContain("Primary · Codex (local) · gpt-5.4: Passed");

    firstProbe.resolve(passedResult());
    await act(async () => {
      await firstProbe.promise;
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    rendered.cleanup();
  });

  it("shows saved state as text instead of a disabled button", async () => {
    const rendered = await renderComponent();
    await vi.waitFor(() => {
      expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).not.toBeNull();
    });

    const fastProfile = rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')!;
    expect(fastProfile.textContent).toContain("Saved");
    const savedButton = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Saved");

    expect(savedButton).toBeUndefined();

    rendered.cleanup();
  });

  it("tests a disabled profile runtime chain before enabling when no current pass exists", async () => {
    profiles[0] = { ...profiles[0]!, status: "disabled" };
    const rendered = await renderComponent();
    await vi.waitFor(() => {
      expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).not.toBeNull();
    });

    const fastProfile = rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')!;
    const enableButton = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enable"));

    await act(async () => {
      enableButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(organizationsApi.updateIntelligenceProfile).toHaveBeenCalledWith("org-1", "lightweight", expect.objectContaining({
      status: "configured",
    }));
    expect(fastProfile.textContent).toContain("Runtime chain environment");

    rendered.cleanup();
  });

  it("marks the profile invalid instead of enabling when the runtime chain test fails", async () => {
    profiles[0] = { ...profiles[0]!, status: "disabled" };
    vi.mocked(agentsApi.testEnvironment).mockResolvedValueOnce({
      ...passedResult(),
      status: "fail",
      checks: [{
        code: "codex_hello_probe_model_unavailable",
        level: "error",
        message: "Model is not available.",
      }],
    });
    const rendered = await renderComponent();
    await vi.waitFor(() => {
      expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).not.toBeNull();
    });

    const fastProfile = rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')!;
    const enableButton = Array.from(fastProfile.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enable"));

    await act(async () => {
      enableButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(organizationsApi.updateIntelligenceProfile).toHaveBeenCalledWith("org-1", "lightweight", expect.objectContaining({
      status: "invalid",
    }));
    expect(organizationsApi.updateIntelligenceProfile).not.toHaveBeenCalledWith("org-1", "lightweight", expect.objectContaining({
      status: "configured",
    }));

    rendered.cleanup();
  });
});
