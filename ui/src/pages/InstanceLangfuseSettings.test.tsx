// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceLangfuseSettings } from "./InstanceLangfuseSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const queryState = {
  langfuse: {
    enabled: true,
    baseUrl: "https://cloud.langfuse.com",
    publicKey: "pk-lf-current",
    environment: "prod",
    secretKeyConfigured: true,
    managedByEnv: false,
  },
  health: {
    instanceId: "default",
    version: "1.2.3",
    devServer: {
      enabled: true,
      restartRequired: false,
      reason: null,
      lastChangedAt: null,
      changedPathCount: 0,
      changedPathsSample: [],
      envFileChanged: false,
      pendingMigrations: [],
      lastRestartAt: null,
    },
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    const key = queryKey.join(":");
    if (key === "instance:langfuse-settings") {
      return {
        data: queryState.langfuse,
        isLoading: false,
        error: null,
      };
    }
    if (key === "health") {
      return {
        data: queryState.health,
        isLoading: false,
        error: null,
      };
    }
    return {
      data: null,
      isLoading: false,
      error: null,
    };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.langfuse": "Langfuse",
        "langfuse.title": "Langfuse",
        "langfuse.description": "Langfuse settings",
        "langfuse.loadFailed": "Failed to load Langfuse settings.",
        "langfuse.updateFailed": "Failed to save Langfuse settings.",
        "langfuse.section.connection.title": "Connection",
        "langfuse.section.connection.description": "Connection section",
        "langfuse.enabled.title": "Enable Langfuse tracing",
        "langfuse.enabled.description": "Enable tracing",
        "langfuse.baseUrl.label": "Base URL",
        "langfuse.baseUrl.help": "Base URL help",
        "langfuse.publicKey.label": "Public key",
        "langfuse.publicKey.help": "Public key help",
        "langfuse.secretKey.label": "Secret key",
        "langfuse.secretKey.help": "Secret key help",
        "langfuse.secretKey.configured": "A secret key is already stored for this instance.",
        "langfuse.secretKey.notConfigured": "No secret key is currently stored.",
        "langfuse.secretKey.clear": "Clear stored secret key",
        "langfuse.secretKey.clearPending": "Clear pending",
        "langfuse.environment.label": "Trace environment",
        "langfuse.environment.help": "Use a stable stage label such as prod, dev, or e2e.",
        "langfuse.environment.placeholder": "prod",
        "langfuse.environment.unset": "unset",
        "langfuse.tags.title": "Automatic trace tags",
        "langfuse.tags.description":
          "New traces from this instance also include {{instanceTag}} and {{releaseTag}} so different local instances and app versions stay distinguishable.",
        "langfuse.section.behavior.title": "Behavior",
        "langfuse.section.behavior.description": "Behavior section",
        "langfuse.restartRequired.title": "Restart required",
        "langfuse.restartRequired.description": "Restart required description",
        "langfuse.envManaged.title": "Managed by environment",
        "langfuse.envManaged.description": "Env managed description",
        "langfuse.envManagedRestartPending.title": "Running server still uses boot-time Langfuse values",
        "langfuse.envManagedRestartPending.description":
          "The watched `.env` changed after this dev server booted. Until you restart the app or local server, new traces may still use the old `LANGFUSE_*` values. The running process currently reports trace environment `{{environment}}`.",
        "langfuse.save": "Save Langfuse settings",
        "langfuse.saving": "Saving...",
        "langfuse.saved.title": "Saved",
        "langfuse.saved.body": "Saved body",
        "langfuse.saveFailed.title": "Save failed",
      };
      return (messages[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ""));
    },
  }),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  queryState.langfuse.managedByEnv = false;
  queryState.health.devServer.restartRequired = false;
  queryState.health.devServer.envFileChanged = false;
});

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<InstanceLangfuseSettings />);
  });

  return container;
}

describe("InstanceLangfuseSettings", () => {
  it("explains that trace environment is stage-only and shows automatic tags", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Trace environment");
    expect(container.textContent).toContain("Use a stable stage label such as prod, dev, or e2e.");
    expect(container.textContent).toContain("Automatic trace tags");
    expect(container.textContent).toContain("instance:default");
    expect(container.textContent).toContain("release:1.2.3");
  });

  it("shows env-managed state as read-only", async () => {
    queryState.langfuse.managedByEnv = true;
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Managed by environment");
    expect(container.querySelector("#langfuse-base-url")?.getAttribute("disabled")).not.toBeNull();
    expect(container.querySelector("#langfuse-public-key")?.getAttribute("disabled")).not.toBeNull();
    expect(container.querySelector("#langfuse-secret-key")?.getAttribute("disabled")).not.toBeNull();
  });

  it("warns when the running dev server still uses old env-managed langfuse values", async () => {
    queryState.langfuse.managedByEnv = true;
    queryState.health.devServer.restartRequired = true;
    queryState.health.devServer.envFileChanged = true;
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Running server still uses boot-time Langfuse values");
    expect(container.textContent).toContain("trace environment `prod`");
  });
});
