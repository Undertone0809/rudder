// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createValuesForRuntime } from "../../components/AgentConfigForm.helpers";
import { TooltipProvider } from "../../components/ui/tooltip";
import { getUIAdapter } from "../registry";
import type { CreateConfigValues } from "../types";
import { CodexLocalConfigFields } from "./config-fields";

vi.mock("../local-workspace-runtime-fields", () => ({ LocalWorkspaceRuntimeFields: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.innerHTML = ""; });

describe("Codex Profile permission selection", () => {
  it("serializes automatic Profile defaults while preserving explicit permission choices", () => {
    const adapter = getUIAdapter("codex_local");
    for (const [profile, expected] of [["operator-default", false], ["default", true]] as const) {
      const automatic = { ...createValuesForRuntime("codex_local"), codexProfileId: profile };
      delete (automatic as Partial<CreateConfigValues>).dangerouslyBypassSandbox;
      expect(adapter.buildAdapterConfig(automatic)).toMatchObject({ profileId: profile, dangerouslyBypassApprovalsAndSandbox: expected });
      for (const explicit of [true, false]) {
        expect(adapter.buildAdapterConfig({ ...automatic, dangerouslyBypassSandbox: explicit })).toMatchObject({ profileId: profile, dangerouslyBypassApprovalsAndSandbox: explicit });
      }
    }
  });

  it("inherits Operator permissions, updates untouched defaults, and preserves explicit toggles across Profile changes", () => {
    let current: CreateConfigValues;
    function Form() {
      const [values, setValues] = useState(() => createValuesForRuntime("codex_local"));
      current = values;
      return <TooltipProvider><CodexLocalConfigFields mode="create" isCreate agentRuntimeType="codex_local" values={values} set={patch => setValues(value => ({ ...value, ...patch }))} config={{}} eff={(_group, _field, value) => value} mark={() => {}} models={[]} hideInstructionsFile /></TooltipProvider>;
    }
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container); cleanup = () => act(() => root.unmount());
    act(() => root.render(<Form />));
    const profile = container.querySelector("select")!;
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Bypass sandbox"]')!;
    const select = (value: string) => act(() => { profile.value = value; profile.dispatchEvent(new Event("change", { bubbles: true })); });
    const checked = () => toggle.getAttribute("aria-checked") === "true";
    expect(profile.value).toBe("operator-default"); expect(checked()).toBe(false);
    select("default"); expect(checked()).toBe(true);
    select("operator-default"); expect(checked()).toBe(false);
    act(() => toggle.click()); expect(checked()).toBe(true);
    select("default"); expect(checked()).toBe(true);
    act(() => toggle.click()); expect(checked()).toBe(false);
    select("operator-default"); select("default"); expect(checked()).toBe(false);
    expect(getUIAdapter("codex_local").buildAdapterConfig(current!)).toMatchObject({ profileId: "default", dangerouslyBypassApprovalsAndSandbox: false });
  });
});
