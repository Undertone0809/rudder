// @vitest-environment jsdom

import type { AgentRuntimeAvailability } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterTypeDropdown } from "./AgentConfigForm.advanced";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./RuntimeLogoIcon", () => ({
  RuntimeLogoIcon: ({ runtimeType }: { runtimeType: string }) => (
    <span data-testid={`runtime-logo-${runtimeType}`} />
  ),
}));

const availability: AgentRuntimeAvailability[] = [
  {
    agentRuntimeType: "codex_local",
    status: "unavailable",
    command: "codex",
    resolvedCommand: null,
    message: "Codex CLI default command was not found on PATH.",
    hint: "Install the codex CLI, or set a custom command path in Advanced options and run Test runtime chain.",
    checkedAt: "2026-07-07T00:00:00.000Z",
  },
  {
    agentRuntimeType: "claude_local",
    status: "available",
    command: "claude",
    resolvedCommand: "/usr/local/bin/claude",
    message: "Claude Code CLI is available.",
    checkedAt: "2026-07-07T00:00:00.000Z",
  },
  {
    agentRuntimeType: "openclaw_gateway",
    status: "unknown",
    command: null,
    resolvedCommand: null,
    message: "This runtime does not use a local CLI command probe.",
    checkedAt: "2026-07-07T00:00:00.000Z",
  },
];

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
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  act(() => {
    root.render(element);
  });
  return container;
}

describe("AdapterTypeDropdown", () => {
  it("groups runtime choices by local CLI availability", async () => {
    const container = render(
      <AdapterTypeDropdown
        value="codex_local"
        onChange={vi.fn()}
        availability={availability}
      />,
    );

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Ready on this machine");
    expect(document.body.textContent).toContain("Needs setup");
    expect(document.body.textContent).toContain("Other runtimes");
    expect(document.body.textContent).toContain("Claude Code (local)");
    expect(document.body.textContent).toContain("Ready");
    expect(document.body.textContent).toContain("Codex (local)");
    expect(document.body.textContent).toContain("Default CLI missing");
    expect(document.body.textContent).toContain("OpenClaw Gateway");
  });
});
