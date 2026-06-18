import { Button } from "@/components/ui/button";
import type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";
import type {
  AgentRuntimeEnvironmentTestResult,
  OrganizationSecret
} from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { getUIAdapter } from "../agent-runtimes";
import type { AgentRuntimeConfigFieldsProps } from "../agent-runtimes/types";
import type { AgentRuntimeModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import {
  requiresExplicitProviderModel,
  resolveRuntimeModels,
  runtimeModelEmptyLabel,
  runtimeModelEmptyMessage,
  runtimeModelSearchPlaceholder,
} from "../lib/runtime-models";
import { cn, formatTime } from "../lib/utils";
import {
  CollapsibleSection,
  Field,
  help
} from "./agent-config-primitives";
import { AdapterTypeDropdown, RuntimeAdvancedOptions } from "./AgentConfigForm.advanced";
import { RuntimeEnvironmentStatus, filterRuntimeEnvironmentDisplayChecks, normalizeRuntimeEnvironmentDisplayStatus, shouldShowThinkingEffort, thinkingEffortKeyForRuntime, thinkingEffortOptionsForRuntime } from "./AgentConfigForm.helpers";
import { ModelDropdown, ThinkingEffortDropdown } from "./AgentConfigForm.model-dropdown";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export function AdapterEnvironmentResult({
  result,
  label,
}: {
  result: AgentRuntimeEnvironmentTestResult;
  label?: string;
}) {
  const displayStatus = normalizeRuntimeEnvironmentDisplayStatus(result.status) ?? "pass";
  const visibleChecks = filterRuntimeEnvironmentDisplayChecks(result);
  const statusLabel =
    displayStatus === "pass" ? "Passed" : displayStatus === "warn" ? "Needs setup" : "Failed";
  const statusClass =
    displayStatus === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : displayStatus === "warn"
        ? "text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label ? `${label}: ${statusLabel}` : statusLabel}</span>
        <span className="text-[11px] opacity-80">
          {formatTime(result.testedAt)}
        </span>
      </div>
      {visibleChecks.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {visibleChecks.map((check, idx) => (
            <div key={`${check.code}-${idx}`} className="text-[11px] leading-relaxed break-words">
              <span className="font-medium uppercase tracking-wide opacity-80">
                {check.level}
              </span>
              <span className="mx-1 opacity-60">·</span>
              <span>{check.message}</span>
              {check.detail && <span className="block opacity-75 break-all">({check.detail})</span>}
              {check.hint && <span className="block opacity-90 break-words">Hint: {check.hint}</span>}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AdapterEnvironmentError({
  label,
  message,
}: {
  label: string;
  message: string;
}) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
      <div className="font-medium">{label}: Failed</div>
      <div className="mt-1 text-[11px] leading-relaxed break-words opacity-90">{message}</div>
    </div>
  );
}

export function RuntimeEnvironmentStatusBadge({
  status,
}: {
  status?: RuntimeEnvironmentStatus;
}) {
  const displayStatus = normalizeRuntimeEnvironmentDisplayStatus(status);
  if (!displayStatus) return null;
  const label =
    displayStatus === "pass"
      ? "Env passed"
      : displayStatus === "warn"
        ? "Env needs setup"
      : displayStatus === "testing"
        ? "Testing env"
        : "Env failed";
  const className =
    displayStatus === "pass"
      ? "border-green-300 bg-green-50 text-green-700 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300"
      : displayStatus === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      : displayStatus === "testing"
        ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300"
        : "border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300";
  return (
    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", className)}>
      {label}
    </span>
  );
}

export function RuntimeProviderCard({
  title,
  className,
  runtimeType,
  model,
  config,
  selectedOrganizationId,
  externalModels,
  availableSecrets,
  onCreateSecret,
  onRuntimeTypeChange,
  onModelChange,
  onConfigFieldChange,
  onConfigPatchChange,
  onRemove,
  hideRuntimeType = false,
  hideInstructionsFile = false,
  runtimeTypeLabel = "Runtime type",
  runtimeTypeHint = help.agentRuntimeType,
  createValues,
  createSet,
  environmentStatus,
  triggerTestId,
  disabled = false,
}: {
  title: string;
  className?: string;
  runtimeType: string;
  model: string;
  config: Record<string, unknown>;
  selectedOrganizationId: string | null | undefined;
  externalModels?: AgentRuntimeModel[];
  availableSecrets: OrganizationSecret[];
  onCreateSecret: (name: string, value: string) => Promise<OrganizationSecret>;
  onRuntimeTypeChange: (runtimeType: string) => void;
  onModelChange: (model: string) => void;
  onConfigFieldChange: (field: string, value: unknown) => void;
  onConfigPatchChange?: (patch: Record<string, unknown>) => void;
  onRemove?: () => void;
  hideRuntimeType?: boolean;
  hideInstructionsFile?: boolean;
  runtimeTypeLabel?: string;
  runtimeTypeHint?: string;
  createValues?: CreateConfigValues | null;
  createSet?: ((patch: Partial<CreateConfigValues>) => void) | null;
  environmentStatus?: RuntimeEnvironmentStatus;
  triggerTestId?: string;
  disabled?: boolean;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingEffortOpen, setThinkingEffortOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const adapter = useMemo(() => getUIAdapter(runtimeType), [runtimeType]);
  const { data: fetchedModels } = useQuery({
    queryKey: selectedOrganizationId
      ? queryKeys.agents.adapterModels(selectedOrganizationId, runtimeType)
      : ["agents", "none", "adapter-models", runtimeType],
    queryFn: () => agentsApi.adapterModels(selectedOrganizationId!, runtimeType),
    enabled: Boolean(selectedOrganizationId),
  });
  const models = useMemo(
    () => resolveRuntimeModels(runtimeType, fetchedModels, externalModels),
    [runtimeType, fetchedModels, externalModels],
  );
  const requiresProviderModel = requiresExplicitProviderModel(runtimeType);
  const thinkingEffortKey = thinkingEffortKeyForRuntime(runtimeType);
  const currentThinkingEffort = createValues
    ? createValues.thinkingEffort
    : String(config[thinkingEffortKey] ?? config.reasoningEffort ?? "");
  const adapterFieldProps: AgentRuntimeConfigFieldsProps = {
    mode: createValues ? "create" : "edit",
    isCreate: Boolean(createValues),
    agentRuntimeType: runtimeType,
    values: createValues ?? null,
    set: disabled ? (() => undefined) : createSet ?? null,
    config,
    eff: <T,>(_group: "agentRuntimeConfig", field: string, original: T): T =>
      Object.prototype.hasOwnProperty.call(config, field) ? config[field] as T : original,
    mark: disabled
      ? (() => undefined)
      : (_group: "agentRuntimeConfig", field: string, value: unknown) => onConfigFieldChange(field, value),
    models,
    hideInstructionsFile,
    disabled,
  };

  return (
    <div className={cn("rounded-lg border border-border/80 bg-background/30 p-3", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">{title}</div>
          <RuntimeEnvironmentStatusBadge status={environmentStatus} />
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${title}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="space-y-3">
        {!hideRuntimeType && (
          <Field label={runtimeTypeLabel} hint={runtimeTypeHint}>
            <AdapterTypeDropdown value={runtimeType} onChange={onRuntimeTypeChange} disabled={disabled} />
          </Field>
        )}
        <ModelDropdown
          label="Model"
          hint={help.model}
          models={models}
          value={model}
          onChange={onModelChange}
          open={modelOpen}
          onOpenChange={setModelOpen}
          allowDefault={!requiresProviderModel && !onRemove}
          required={requiresProviderModel || Boolean(onRemove)}
          groupByProvider={requiresProviderModel}
          emptyLabel={runtimeModelEmptyLabel(runtimeType, Boolean(onRemove))}
          searchPlaceholder={runtimeModelSearchPlaceholder(runtimeType)}
          emptyMessage={runtimeModelEmptyMessage(runtimeType)}
          allowCustom
          triggerTestId={triggerTestId}
          disabled={disabled}
        />
        {shouldShowThinkingEffort(runtimeType) && (
          <>
            <ThinkingEffortDropdown
              value={currentThinkingEffort}
              options={thinkingEffortOptionsForRuntime(runtimeType)}
              onChange={(value) => {
                if (createSet) {
                  createSet({ thinkingEffort: value });
                } else if (runtimeType === "codex_local") {
                  onConfigPatchChange?.({ modelReasoningEffort: value || undefined, reasoningEffort: undefined });
                } else {
                  onConfigFieldChange(thinkingEffortKey, value || undefined);
                }
              }}
              open={thinkingEffortOpen}
              onOpenChange={setThinkingEffortOpen}
              disabled={disabled}
            />
          </>
        )}
        <CollapsibleSection
          title="Advanced options"
          bordered
          open={advancedOpen}
          onToggle={() => setAdvancedOpen(!advancedOpen)}
          disabled={disabled}
        >
          <RuntimeAdvancedOptions
            runtimeType={runtimeType}
            adapter={adapter}
            fieldProps={adapterFieldProps}
            availableSecrets={availableSecrets}
            onCreateSecret={onCreateSecret}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}
