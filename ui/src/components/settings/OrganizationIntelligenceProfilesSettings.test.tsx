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
  }: {
    title: string;
    model: string;
    environmentStatus?: string;
  }) => (
    <div>
      {title} {model} {environmentStatus ? `Env ${environmentStatus}` : ""}
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

const profiles: OrganizationIntelligenceProfile[] = [
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

describe("OrganizationIntelligenceProfilesSettings", () => {
  beforeEach(() => {
    vi.mocked(organizationsApi.listIntelligenceProfiles).mockResolvedValue(profiles);
    vi.mocked(secretsApi.list).mockResolvedValue([]);
    vi.mocked(agentsApi.adapterModels).mockResolvedValue([]);
    vi.mocked(agentsApi.testEnvironment).mockResolvedValue(passedResult());
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
    expect(fastProfile?.textContent).toContain("Test runtime chain");

    const testButton = Array.from(fastProfile?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("Test runtime chain"));
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
});
