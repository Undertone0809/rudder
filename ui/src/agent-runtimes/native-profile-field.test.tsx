// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createValuesForRuntime } from "../components/AgentConfigForm.helpers";
import { TooltipProvider } from "../components/ui/tooltip";
import { NativeProfileField } from "./native-profile-field";
import { getUIAdapter } from "./registry";
import type { CreateConfigValues } from "./types";

vi.mock("./local-workspace-runtime-fields", () => ({ LocalWorkspaceRuntimeFields: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.innerHTML = ""; });

describe("native local Profile selection", () => {
  it("preserves a saved custom Profile until an explicit edit", () => {
    const mark = vi.fn();
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container); cleanup = () => act(() => root.unmount());
    act(() => root.render(<TooltipProvider><NativeProfileField mode="edit" isCreate={false}
      agentRuntimeType="pi_local" values={null} set={null} config={{ profileId: "team-profile" }}
      eff={(_group, _field, value) => value} mark={mark} models={[]} /></TooltipProvider>));
    const profile = container.querySelector("select")!;
    expect(profile.value).toBe("team-profile");
    expect(mark).not.toHaveBeenCalled();
    act(() => { profile.value = "operator-default"; profile.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mark).toHaveBeenCalledWith("agentRuntimeConfig", "profileId", "operator-default");
  });

  for (const runtime of ["claude_local", "cursor", "pi_local", "opencode_local"]) {
    it(`persists the selected ${runtime} Profile even when instruction fields are hidden`, () => {
      const adapter = getUIAdapter(runtime);
      let current: CreateConfigValues;
      function Form() {
        const [values, setValues] = useState(() => createValuesForRuntime(runtime));
        current = values;
        const Fields = adapter.ConfigFields;
        return <TooltipProvider><Fields mode="create" isCreate agentRuntimeType={runtime} values={values}
          set={patch => setValues(value => ({ ...value, ...patch }))} config={{}}
          eff={(_group, _field, value) => value} mark={() => {}} models={[]} hideInstructionsFile /></TooltipProvider>;
      }
      const container = document.createElement("div"); document.body.appendChild(container);
      const root = createRoot(container); cleanup = () => act(() => root.unmount());
      act(() => root.render(<Form />));
      const profile = container.querySelector<HTMLSelectElement>('select[aria-label="Native Chat Profile"]')!;
      expect(profile.value).toBe("operator-default");
      expect(adapter.buildAdapterConfig(current!)).toMatchObject({ profileId: "operator-default" });
      act(() => { profile.value = "default"; profile.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(adapter.buildAdapterConfig(current!)).toMatchObject({ profileId: "default" });
      act(() => { profile.value = "operator-default"; profile.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(adapter.buildAdapterConfig(current!)).toMatchObject({ profileId: "operator-default" });
    });
  }
});
