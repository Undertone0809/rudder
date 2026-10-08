// @vitest-environment jsdom

import type { Agent } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUIAdapter } from "../agent-runtimes";
import { AgentConfigForm } from "./AgentConfigForm";
import { ADAPTER_DISPLAY_LIST } from "./AgentConfigForm.advanced";
import { createValuesForRuntime } from "./AgentConfigForm.helpers";
import type { CreateConfigValues } from "./AgentConfigForm.helpers";
import { TooltipProvider } from "./ui/tooltip";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: null }),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

let cleanupFn: (() => void) | null = null;
let queryClient: QueryClient | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  queryClient?.clear();
  queryClient = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
  };
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient!}>
        <TooltipProvider>{element}</TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

function click(button: HTMLButtonElement) {
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function buttonByText(container: ParentNode, text: string) {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `button named ${text}`).toBeDefined();
  return button as HTMLButtonElement;
}

function inputByAccessibleName(container: ParentNode, name: string) {
  const input = [...container.querySelectorAll("input")]
    .find((candidate) => [...(candidate.labels ?? [])]
      .some((label) => label.textContent?.trim() === name));
  expect(input, `input named ${name}`).toBeDefined();
  expect(input?.id).not.toBe("");
  const labels = [...((input as HTMLInputElement).labels ?? [])];
  expect(labels.map((label) => label.textContent?.trim())).toContain(name);
  expect(labels.map((label) => label.htmlFor)).toContain((input as HTMLInputElement).id);
  return input as HTMLInputElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function RealHermesCreateForm() {
  const [values, setValues] = useState<CreateConfigValues>(() => createValuesForRuntime("hermes_gateway"));
  const [submittedConfig, setSubmittedConfig] = useState("");

  return (
    <>
      <AgentConfigForm
        mode="create"
        values={values}
        onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
        showAdapterTestEnvironmentButton={false}
        showCreateRunPolicySection={false}
      />
      <button
        type="button"
        onClick={() => setSubmittedConfig(JSON.stringify(
          getUIAdapter(values.agentRuntimeType).buildAdapterConfig(values),
        ))}
      >
        Submit runtime config
      </button>
      <output data-testid="submitted-runtime-config">{submittedConfig}</output>
    </>
  );
}

describe("AgentConfigForm Hermes compatibility", () => {
  it("keeps legacy Hermes out of choices and marks saved legacy config as requiring reconfiguration", () => {
    expect(ADAPTER_DISPLAY_LIST.filter((item) => item.value.includes("hermes")))
      .toEqual([{ value: "hermes_gateway", label: "Hermes", comingSoon: false }]);

    const legacyAgent = {
      id: "agent-hermes-legacy",
      name: "Legacy Hermes agent",
      role: "general",
      agentRuntimeType: "hermes_local",
      agentRuntimeConfig: { command: "hermes", model: "legacy-model" },
      runtimeConfig: {},
    } as unknown as Agent;
    const onSave = vi.fn();
    const container = render(
      <AgentConfigForm mode="edit" agent={legacyAgent} onSave={onSave} />,
    );

    expect(container.textContent).toContain("Legacy · migration required");
    const warning = container.querySelector('[role="alert"]');
    expect(warning?.textContent).toContain("legacy Hermes Local runtime");
    expect(warning?.textContent).toContain("requires reconfiguration to the supported Hermes runtime");
    expect(warning?.textContent).toContain("Existing settings remain unchanged until you save.");
    expect(container.textContent).not.toContain("Advanced options");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses the real form and Hermes adapter for local-to-custom fields and config submission", () => {
    const container = render(<RealHermesCreateForm />);

    expect(container.querySelector("input[id$='-server-url']")).toBeNull();
    expect(container.querySelector("input[id$='-api-key']")).toBeNull();
    click(buttonByText(container, "Submit runtime config"));

    const submittedConfig = container.querySelector("[data-testid='submitted-runtime-config']")!;
    const localConfig = JSON.parse(submittedConfig.textContent ?? "{}") as Record<string, unknown>;
    expect(localConfig.hermesConnectionMode).toBe("local");
    expect(localConfig).not.toHaveProperty("url");
    expect(localConfig).not.toHaveProperty("apiKey");

    click(buttonByText(container, "Advanced options"));
    click(buttonByText(container, "Connect a custom Hermes API Server"));

    const serverUrl = inputByAccessibleName(container, "Hermes API Server URL");
    const apiKey = inputByAccessibleName(container, "API Server key");
    expect(serverUrl.id).not.toBe(apiKey.id);
    expect(apiKey.type).toBe("password");
    setInputValue(serverUrl, "http://127.0.0.1:18642");
    setInputValue(apiKey, "custom-hermes-key");
    click(buttonByText(container, "Submit runtime config"));

    const customConfig = JSON.parse(submittedConfig.textContent ?? "{}") as Record<string, unknown>;
    expect(customConfig).toMatchObject({
      hermesConnectionMode: "custom",
      hermesChatBackend: "native_runs_http",
      url: "http://127.0.0.1:18642",
      apiKey: "custom-hermes-key",
    });
  });
});
