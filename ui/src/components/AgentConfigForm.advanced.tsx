import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_RUNTIME_TYPES,
  AGENT_RUN_CONCURRENCY_DEFAULT,
  AGENT_RUN_CONCURRENCY_MAX,
  AGENT_RUN_CONCURRENCY_MIN,
} from "@rudderhq/shared";
import { normalizeModelFallbacks } from "@rudderhq/agent-runtime-utils";
import type { ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import type {
  Agent,
  AgentRuntimeEnvironmentTestResult,
  OrganizationSecret,
  EnvBinding,
} from "@rudderhq/shared";
import type { AgentRuntimeModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH,
} from "@rudderhq/agent-runtime-codex-local";
import { models as CLAUDE_LOCAL_MODELS } from "@rudderhq/agent-runtime-claude-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  semanticBadgeToneClasses,
} from "@/components/ui/semanticTones";
import { Heart, ChevronDown, Plus, Trash2, X } from "lucide-react";
import { cn, formatTime } from "../lib/utils";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import { CODEX_LOCAL_REASONING_EFFORT_OPTIONS, withDefaultThinkingEffortOption } from "../lib/runtime-thinking-effort";
import { resolveRuntimeModels } from "../lib/runtime-models";
import { queryKeys } from "../lib/queryKeys";
import { useOrganization } from "../context/OrganizationContext";
import { useDialog } from "../context/DialogContext";
import {
  Field,
  ToggleField,
  ToggleWithNumber,
  CollapsibleSection,
  DraftInput,
  DraftNumberInput,
  help,
  adapterLabels,
} from "./agent-config-primitives";
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../agent-runtimes";
import type { AgentRuntimeConfigFieldsProps } from "../agent-runtimes/types";
import { ClaudeLocalAdvancedFields } from "../agent-runtimes/claude-local/config-fields";
import { MarkdownEditor } from "./MarkdownEditor";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { ReportsToPicker } from "./ReportsToPicker";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";
import type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";
import { AgentConfigFormProps, Overlay, emptyOverlay, EMPTY_ENV, isOverlayDirty, inputClass, parseCommaArgs, formatArgList, codexThinkingEffortOptions, openCodeThinkingEffortOptions, cursorModeOptions, claudeThinkingEffortOptions, LOCAL_MODEL_RUNTIME_TYPES, defaultModelForRuntime, defaultCommandForRuntime, createValuesForRuntime, defaultConfigForRuntime, defaultFallbackRuntime, defaultFallbackItem, thinkingEffortKeyForRuntime, thinkingEffortOptionsForRuntime, shouldShowThinkingEffort, hasClearedConfigValue, omitClearedConfigValues, primaryModelFallbackKey, normalizeModelFallbacksForEditor, runtimeProviderRailClassName, runtimeProviderItemClassName, RuntimeEnvironmentTestTarget, RuntimeEnvironmentTestItemResult, RuntimeEnvironmentStatus, RuntimeEnvironmentDisplayStatus, formatRuntimeEnvironmentLabel, normalizeRuntimeEnvironmentDisplayStatus, filterRuntimeEnvironmentDisplayChecks } from "./AgentConfigForm.helpers";
import { EnvVarEditor } from "./AgentConfigForm.env-editor";

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
  const { isCreate, values, set, config, eff, mark } = fieldProps;
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
            />
          </Field>
          <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
            <DraftNumberInput
              value={eff("agentRuntimeConfig", "graceSec", Number(config.graceSec ?? 15))}
              onCommit={(value) => mark("agentRuntimeConfig", "graceSec", value)}
              immediate
              className={inputClass}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/* ---- Internal sub-components ---- */

export const ENABLED_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local", "cursor"]);

/** Display list includes all real adapter types plus UI-only coming-soon entries. */
export const ADAPTER_DISPLAY_LIST: { value: string; label: string; comingSoon: boolean }[] = [
  ...AGENT_RUNTIME_TYPES.map((t) => ({
    value: t,
    label: adapterLabels[t] ?? t,
    comingSoon: !ENABLED_ADAPTER_TYPES.has(t),
  })),
];

export function AdapterTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (type: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className="inline-flex items-center gap-1.5">
            {value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
            <span>{adapterLabels[value] ?? value}</span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {ADAPTER_DISPLAY_LIST.map((item) => (
          <button
            key={item.value}
            disabled={item.comingSoon}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded",
              item.comingSoon
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-accent/50",
              item.value === value && !item.comingSoon && "bg-accent",
            )}
            onClick={() => {
              if (!item.comingSoon) onChange(item.value);
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
              <span>{item.label}</span>
            </span>
            {item.comingSoon && (
              <span className="text-[10px] text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
