import { Field } from "../components/agent-config-primitives";
import type { AgentRuntimeConfigFieldsProps } from "./types";

export function NativeProfileField({
  isCreate, values, set, config, eff, mark, disabled,
}: AgentRuntimeConfigFieldsProps) {
  const profile = isCreate
    ? values?.nativeProfileId ?? "operator-default"
    : eff("agentRuntimeConfig", "profileId", String(config.profileId ?? "default"));
  return (
    <Field label="Native Chat Profile" hint="Use your existing local login and settings. Agent Profile uses the existing Rudder-managed profile.">
      <select
        aria-label="Native Chat Profile"
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm"
        value={profile}
        disabled={disabled}
        onChange={(event) => isCreate
          ? set?.({ nativeProfileId: event.target.value })
          : mark("agentRuntimeConfig", "profileId", event.target.value)}
      >
        <option value="operator-default">Operator native Profile</option>
        <option value="default">Agent Profile</option>
        {profile !== "operator-default" && profile !== "default" ? (
          <option value={profile}>{profile}</option>
        ) : null}
      </select>
    </Field>
  );
}
