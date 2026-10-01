import { Button } from "@/components/ui/button";
import { DraftInput, Field, help } from "../../components/agent-config-primitives";
import { PayloadTemplateJsonField } from "../runtime-json-fields";
import type { AgentRuntimeConfigFieldsProps } from "../types";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HermesGatewayConfigFields({ isCreate, values, set, config, eff, mark }: AgentRuntimeConfigFieldsProps) {
  const connectionMode = isCreate
    ? values!.hermesConnectionMode ?? "local"
    : config.hermesConnectionMode === "local" || (!config.url && config.hermesChatBackend !== "native_runs_http")
      ? "local"
      : "custom";
  const selectConnectionMode = (mode: "local" | "custom") => {
    if (isCreate) {
      set!({ hermesConnectionMode: mode });
      return;
    }
    mark("agentRuntimeConfig", "hermesConnectionMode", mode);
    if (mode === "custom") mark("agentRuntimeConfig", "hermesChatBackend", "native_runs_http");
  };

  return (
    <>
      {connectionMode === "local" ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
          <p className="text-sm font-medium">Use Hermes installed on this machine</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Reuses the local Hermes setup and provider login. Rudder selects one detected local backend when this agent is created.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => selectConnectionMode("custom")}>
            Connect a custom Hermes API Server
          </Button>
        </div>
      ) : (
        <>
          {isCreate && (
            <Button type="button" size="sm" variant="ghost" onClick={() => selectConnectionMode("local")}>
              Use local Hermes instead
            </Button>
          )}
          <Field label="Hermes API Server URL" hint={help.webhookUrl}>
            <DraftInput
              value={isCreate ? values!.url : eff("agentRuntimeConfig", "url", String(config.url ?? ""))}
              onCommit={(value) => isCreate ? set!({ url: value }) : mark("agentRuntimeConfig", "url", value || undefined)}
              immediate className={inputClass} placeholder="http://127.0.0.1:8642"
            />
          </Field>
          <Field label="API Server key">
            <DraftInput
              value={isCreate ? values!.apiKey ?? "" : eff("agentRuntimeConfig", "apiKey", String(config.apiKey ?? ""))}
              onCommit={(value) => isCreate ? set!({ apiKey: value }) : mark("agentRuntimeConfig", "apiKey", value || undefined)}
              immediate type="password" className={inputClass} placeholder="API_SERVER_KEY"
            />
          </Field>
        </>
      )}
      {!isCreate && (
        <>
          <Field label="Model">
            <DraftInput
              value={eff("agentRuntimeConfig", "model", String(config.model ?? ""))}
              onCommit={(value) => mark("agentRuntimeConfig", "model", value || undefined)}
              immediate className={inputClass} placeholder="hermes-agent or configured route alias"
            />
          </Field>
          <Field label="Session strategy">
            <select value={String(eff("agentRuntimeConfig", "sessionKeyStrategy", String(config.sessionKeyStrategy ?? "issue")))} onChange={(event) => mark("agentRuntimeConfig", "sessionKeyStrategy", event.target.value)} className={inputClass}>
              <option value="issue">Per issue</option>
              <option value="fixed">Fixed</option>
              <option value="run">Per run</option>
            </select>
          </Field>
          <Field label="Session key">
            <DraftInput value={eff("agentRuntimeConfig", "sessionKey", String(config.sessionKey ?? ""))} onCommit={(value) => mark("agentRuntimeConfig", "sessionKey", value || undefined)} immediate className={inputClass} placeholder="rudder" />
          </Field>
        </>
      )}
      <PayloadTemplateJsonField isCreate={isCreate} values={values} set={set} config={config} mark={mark} />
    </>
  );
}
