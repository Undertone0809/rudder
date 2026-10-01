// @vitest-environment jsdom

import type { OrganizationSecret } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProviderCard } from "./AgentConfigForm.environment";
import { TooltipProvider } from "./ui/tooltip";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
  };
  act(() => root.render(element));
  return container;
}

describe("RuntimeProviderCard", () => {
  it("shows legacy Gemini as unsupported and directs operators to reconfigure it", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onRuntimeTypeChange = vi.fn();
    const container = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RuntimeProviderCard
            title="Primary"
            runtimeType="gemini_local"
            model="gemini-2.5-pro"
            config={{ command: "gemini" }}
            selectedOrganizationId={null}
            availableSecrets={[]}
            onCreateSecret={async () => ({} as OrganizationSecret)}
            onRuntimeTypeChange={onRuntimeTypeChange}
            onModelChange={vi.fn()}
            onConfigFieldChange={vi.fn()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("Unsupported");
    expect(container.textContent).toContain("Gemini CLI runtime support has been removed.");
    expect(container.textContent).toContain("Choose a supported runtime above to reconfigure this Agent.");
    expect(container.textContent).toContain("Existing settings remain unchanged until you save.");
    expect(container.textContent).toContain("Gemini CLI (removed)");
    expect(container.textContent).not.toContain("Model");
    expect(container.textContent).not.toContain("Advanced options");
    expect(container.textContent).not.toContain("Command");
    expect(onRuntimeTypeChange).not.toHaveBeenCalled();
  });
});
