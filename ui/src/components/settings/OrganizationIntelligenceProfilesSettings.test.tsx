// @vitest-environment jsdom

import { organizationsApi } from "@/api/orgs";
import type { OrganizationIntelligenceProfile } from "@rudderhq/shared";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationIntelligenceProfilesSettings } from "./OrganizationIntelligenceProfilesSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let profiles: OrganizationIntelligenceProfile[] = [];

vi.mock("@/api/agents", () => ({ agentsApi: { adapterModels: vi.fn(async () => []), testEnvironment: vi.fn() } }));
vi.mock("@/api/orgs", () => ({ organizationsApi: { listIntelligenceProfiles: vi.fn(), updateIntelligenceProfile: vi.fn() } }));
vi.mock("@/api/secrets", () => ({ secretsApi: { list: vi.fn(async () => []), create: vi.fn() } }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
  sortableKeyboardCoordinates: vi.fn(),
  arrayMove: <T,>(items: T[]) => items,
}));
vi.mock("@/components/AgentConfigForm.environment", () => ({
  AdapterEnvironmentResult: () => null,
  AdapterEnvironmentError: () => null,
  SortableRuntimeProviderCard: ({ title, model, config }: {
    title: string;
    model: string;
    config: Record<string, unknown>;
  }) => <div>{title} {model} {String(config.modelReasoningEffort ?? "")}</div>,
}));
vi.mock("@tanstack/react-query", async () => {
  const React = await import("react");
  return {
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "organizations") return { data: profiles, isLoading: false, isError: false, error: null };
      return { data: [], isLoading: false, isError: false, error: null };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useMutation: ({ mutationFn }: { mutationFn: (variables: unknown) => Promise<unknown> }) => {
      const [isPending, setIsPending] = React.useState(false);
      return {
        isPending,
        mutateAsync: async (variables: unknown) => {
          setIsPending(true);
          try { return await mutationFn(variables); } finally { setIsPending(false); }
        },
      };
    },
  };
});

async function renderComponent() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<OrganizationIntelligenceProfilesSettings orgId="org-1" />);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, cleanup: () => { act(() => root.unmount()); host.remove(); } };
}

describe("OrganizationIntelligenceProfilesSettings", () => {
  beforeEach(() => {
    profiles = [{
      id: "profile-default",
      orgId: "org-1",
      purpose: "default",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
      status: "configured",
      lastError: null,
      lastVerifiedAt: new Date("2026-09-22T00:00:00.000Z"),
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
      updatedAt: new Date("2026-09-22T00:00:00.000Z"),
    }];
    vi.mocked(organizationsApi.listIntelligenceProfiles).mockResolvedValue(profiles);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders one Default model profile instead of Fast and Smart tiers", async () => {
    const rendered = await renderComponent();
    await vi.waitFor(() => expect(rendered.host.querySelector('[data-testid="intelligence-profile-default"]')).not.toBeNull());
    expect(rendered.host.querySelector('[data-testid="intelligence-profile-lightweight"]')).toBeNull();
    expect(rendered.host.querySelector('[data-testid="intelligence-profile-reasoning"]')).toBeNull();
    expect(rendered.host.textContent).toContain("Default model");
    expect(rendered.host.textContent).toContain("gpt-5.6-luna");
    expect(rendered.host.textContent).toContain("medium");
    rendered.cleanup();
  });

  it("uses Luna Medium for a fresh organization profile", async () => {
    profiles = [];
    const rendered = await renderComponent();
    await vi.waitFor(() => expect(rendered.host.querySelector('[data-testid="intelligence-profile-default"]')).not.toBeNull());
    const card = rendered.host.querySelector('[data-testid="intelligence-profile-default"]')!;
    expect(card.textContent).toContain("gpt-5.6-luna");
    expect(card.textContent).toContain("medium");
    rendered.cleanup();
  });
});
