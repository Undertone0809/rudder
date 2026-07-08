import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  AgentRuntimeAvailability,
  EnvBinding,
  OrganizationSecret
} from "@rudderhq/shared";
import {
  AGENT_RUNTIME_TYPES
} from "@rudderhq/shared";
import { ChevronDown } from "lucide-react";
import { getUIAdapter } from "../agent-runtimes";
import { ClaudeLocalAdvancedFields } from "../agent-runtimes/claude-local/config-fields";
import type { AgentRuntimeConfigFieldsProps } from "../agent-runtimes/types";
import { cn } from "../lib/utils";
import {
  DraftInput,
  DraftNumberInput,
  Field,
  adapterLabels,
  help
} from "./agent-config-primitives";
import { EnvVarEditor } from "./AgentConfigForm.env-editor";
import { EMPTY_ENV, defaultCommandForRuntime, formatArgList, inputClass, parseCommaArgs } from "./AgentConfigForm.helpers";
import { RuntimeLogoIcon } from "./RuntimeLogoIcon";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export function RuntimeAdvancedOptions({
  runtimeType,
  adapter,
  fieldProps,
  availableSecrets,
  onCreateSecret,
}: {
  runtimeType: string;
  adapter: ReturnType<typeof getUIAdapter>;
  fieldProps: AgentRuntimeConfigFieldsProps;
  availableSecrets: OrganizationSecret[];
  onCreateSecret: (name: string, value: string) => Promise<OrganizationSecret>;
}) {
  const { isCreate, values, set, config, eff, mark, disabled } = fieldProps;
  const ConfigFields = adapter.ConfigFields;
  return (
    <div className="space-y-3">
      <ConfigFields {...fieldProps} />
      {runtimeType === "claude_local" && (
        <ClaudeLocalAdvancedFields {...fieldProps} />
      )}
      <Field label="Command" hint={help.localCommand}>
        <DraftInput
          value={
            isCreate
              ? values!.command
              : eff("agentRuntimeConfig", "command", String(config.command ?? ""))
          }
          onCommit={(value) =>
            isCreate
              ? set!({ command: value })
              : mark("agentRuntimeConfig", "command", value || undefined)
          }
          immediate
          className={inputClass}
          placeholder={defaultCommandForRuntime(runtimeType)}
          disabled={disabled}
        />
      </Field>
      <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
        <DraftInput
          value={
            isCreate
              ? values!.extraArgs
              : eff("agentRuntimeConfig", "extraArgs", formatArgList(config.extraArgs))
          }
          onCommit={(value) =>
            isCreate
              ? set!({ extraArgs: value })
              : mark("agentRuntimeConfig", "extraArgs", value ? parseCommaArgs(value) : undefined)
          }
          immediate
          className={inputClass}
          placeholder="e.g. --verbose, --foo=bar"
          disabled={disabled}
        />
      </Field>
      <Field label="Environment variables" hint={help.envVars}>
        <EnvVarEditor
          value={
            isCreate
              ? ((values!.envBindings ?? EMPTY_ENV) as Record<string, EnvBinding>)
              : eff("agentRuntimeConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>)
          }
          secrets={availableSecrets}
          onCreateSecret={onCreateSecret}
          onChange={(env) =>
            isCreate
              ? set!({ envBindings: env ?? {}, envVars: "" })
              : mark("agentRuntimeConfig", "env", env)
          }
          disabled={disabled}
        />
      </Field>
      {!isCreate && (
        <>
          <Field label="Timeout (sec)" hint={help.timeoutSec}>
            <DraftNumberInput
              value={eff("agentRuntimeConfig", "timeoutSec", Number(config.timeoutSec ?? 0))}
              onCommit={(value) => mark("agentRuntimeConfig", "timeoutSec", value)}
              immediate
              className={inputClass}
              disabled={disabled}
            />
          </Field>
          <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
            <DraftNumberInput
              value={eff("agentRuntimeConfig", "graceSec", Number(config.graceSec ?? 15))}
              onCommit={(value) => mark("agentRuntimeConfig", "graceSec", value)}
              immediate
              className={inputClass}
              disabled={disabled}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/* ---- Internal sub-components ---- */

export const ENABLED_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local", "cursor"]);
const HIDDEN_ADAPTER_MENU_TYPES = new Set(["process", "http"]);
const AVAILABILITY_GROUP_LABELS = {
  available: "Ready on this machine",
  unavailable: "Needs setup",
  unknown: "Other runtimes",
} as const;

/** Display list includes operator-facing runtime choices plus selected coming-soon entries. */
export const ADAPTER_DISPLAY_LIST: { value: string; label: string; comingSoon: boolean }[] = [
  ...AGENT_RUNTIME_TYPES.filter((t) => !HIDDEN_ADAPTER_MENU_TYPES.has(t)).map((t) => ({
    value: t,
    label: adapterLabels[t] ?? t,
    comingSoon: !ENABLED_ADAPTER_TYPES.has(t),
  })),
];

export function AdapterTypeDropdown({
  value,
  onChange,
  disabled = false,
  availability = [],
}: {
  value: string;
  onChange: (type: string) => void;
  disabled?: boolean;
  availability?: AgentRuntimeAvailability[];
}) {
  const availabilityByType = new Map(availability.map((item) => [item.agentRuntimeType, item]));
  const groupedItems = (["available", "unavailable", "unknown"] as const)
    .map((status) => ({
      status,
      items: ADAPTER_DISPLAY_LIST.filter((item) => {
        const entry = availabilityByType.get(item.value);
        const itemStatus = entry?.status ?? "unknown";
        return itemStatus === status;
      }),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between"
          disabled={disabled}
        >
          <span className="inline-flex items-center gap-1.5">
            <RuntimeLogoIcon runtimeType={value} />
            <span>{adapterLabels[value] ?? value}</span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {groupedItems.map((group) => (
          <div key={group.status} className="py-1 first:pt-0 last:pb-0">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {AVAILABILITY_GROUP_LABELS[group.status]}
            </div>
            {group.items.map((item) => {
              const entry = availabilityByType.get(item.value);
              const unavailable = entry?.status === "unavailable";
              return (
                <button
                  key={item.value}
                  title={entry?.hint ?? entry?.message}
                  disabled={disabled || item.comingSoon}
                  className={cn(
                    "flex items-center justify-between gap-2 w-full px-2 py-1.5 text-sm rounded",
                    disabled || item.comingSoon
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:bg-accent/50",
                    item.value === value && !item.comingSoon && "bg-accent",
                    unavailable && "text-muted-foreground",
                  )}
                  onClick={() => {
                    if (!item.comingSoon) onChange(item.value);
                  }}
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <RuntimeLogoIcon runtimeType={item.value} />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.comingSoon ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">Coming soon</span>
                  ) : unavailable ? (
                    <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">Default CLI missing</span>
                  ) : entry?.status === "available" ? (
                    <span className="shrink-0 text-[10px] text-green-700 dark:text-green-300">Ready</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
