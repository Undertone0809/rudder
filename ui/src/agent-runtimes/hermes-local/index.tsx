import { DraftInput, Field } from "../../components/agent-config-primitives";
import { parseProcessStdoutLine } from "../process/parse-stdout";
import type { AgentRuntimeConfigFieldsProps, CreateConfigValues, UIAgentRuntimeModule } from "../types";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm placeholder:text-muted-foreground/40";

export function buildHermesLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  return {
    ...(values.hermesProfileId?.trim() ? { profileId: values.hermesProfileId.trim() } : {}),
    ...(values.model.trim() ? { model: values.model.trim() } : {}),
  };
}

export function HermesLocalConfigFields({ isCreate, values, set, config, eff, mark }: AgentRuntimeConfigFieldsProps) {
  return <>
    <p className="text-sm text-muted-foreground">Uses the installed Hermes CLI and an existing local Profile. Run Hermes setup locally before sending your first message.</p>
    <Field label="Profile" hint="Leave blank to use the default Hermes Profile. Named Profiles must already exist locally.">
      <DraftInput value={isCreate ? values!.hermesProfileId ?? "" : eff("agentRuntimeConfig", "profileId", String(config.profileId ?? ""))}
        onCommit={(value) => isCreate ? set!({ hermesProfileId: value }) : mark("agentRuntimeConfig", "profileId", value || undefined)}
        immediate className={inputClass} placeholder="default" />
    </Field>
    <Field label="Model" hint="Leave blank to use the model configured in this Hermes Profile.">
      <DraftInput value={isCreate ? values!.model : eff("agentRuntimeConfig", "model", String(config.model ?? ""))}
        onCommit={(value) => isCreate ? set!({ model: value }) : mark("agentRuntimeConfig", "model", value || undefined)}
        immediate className={inputClass} placeholder="Profile default" />
    </Field>
  </>;
}

export const hermesLocalUIAdapter: UIAgentRuntimeModule = {
  type: "hermes_local", label: "Hermes (local)",
  // Keep historical Run logs readable; native Chat uses typed events.
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesLocalConfig,
};
