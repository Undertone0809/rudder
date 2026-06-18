import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentRuntimeModel } from "../api/agents";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import { cn } from "../lib/utils";
import {
  Field,
  help
} from "./agent-config-primitives";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export function ModelDropdown({
  label,
  hint,
  models,
  value,
  onChange,
  open,
  onOpenChange,
  allowDefault,
  allowClear = false,
  allowCustom = false,
  required,
  groupByProvider,
  emptyLabel,
  searchPlaceholder = "Search models...",
  emptyMessage = "No models found.",
  triggerTestId,
  disabled = false,
}: {
  label: string;
  hint?: string;
  models: AgentRuntimeModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowDefault: boolean;
  allowClear?: boolean;
  allowCustom?: boolean;
  required: boolean;
  groupByProvider: boolean;
  emptyLabel: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  triggerTestId?: string;
  disabled?: boolean;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const selected = models.find((m) => m.id === value);
  const customModel = modelSearch.trim();
  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (!modelSearch.trim()) return true;
      const q = modelSearch.toLowerCase();
      const provider = extractProviderId(m.id) ?? "";
      return (
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        provider.toLowerCase().includes(q)
      );
    });
  }, [models, modelSearch]);
  const canUseCustomModel = allowCustom
    && customModel.length > 0
    && !models.some((m) => m.id === customModel);
  const groupedModels = useMemo(() => {
    if (!groupByProvider) {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
      ];
    }
    const map = new Map<string, AgentRuntimeModel[]>();
    for (const model of filteredModels) {
      const provider = extractProviderId(model.id) ?? "other";
      const group = map.get(provider) ?? [];
      group.push(model);
      map.set(provider, group);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, groupByProvider]);

  return (
    <Field label={label} hint={hint}>
      <Popover
        open={disabled ? false : open}
        onOpenChange={(nextOpen) => {
          if (disabled) return;
          onOpenChange(nextOpen);
          if (!nextOpen) setModelSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between min-w-0"
            data-testid={triggerTestId}
            disabled={disabled}
          >
            <span className={cn("truncate text-left", !value && "text-muted-foreground")}>
              {selected
                ? selected.label
                : value || emptyLabel || (required ? "Select model (required)" : "Select model")}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          <input
            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
            placeholder={searchPlaceholder}
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-[240px] overflow-y-auto">
            {allowDefault && (
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                Default
              </button>
            )}
            {allowClear && (
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                No fallback model
              </button>
            )}
            {canUseCustomModel && (
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50"
                onClick={() => {
                  onChange(customModel);
                  onOpenChange(false);
                }}
              >
                <span className="block w-full text-left truncate" title={customModel}>
                  Use "{customModel}"
                </span>
              </button>
            )}
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
                {groupByProvider && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {group.provider} ({group.entries.length})
                  </div>
                )}
                {group.entries.map((m) => (
                  <button
                    key={m.id}
                    className={cn(
                      "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                      m.id === value && "bg-accent",
                    )}
                    onClick={() => {
                      onChange(m.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block w-full text-left truncate" title={m.id}>
                      {groupByProvider ? extractModelName(m.id) : m.label}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {filteredModels.length === 0 && !canUseCustomModel && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyMessage}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

export function ThinkingEffortDropdown({
  value,
  options,
  onChange,
  open,
  onOpenChange,
  disabled = false,
}: {
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  const selected = options.find((option) => option.id === value) ?? options[0];

  return (
    <Field label="Thinking effort" hint={help.thinkingEffort}>
      <Popover open={disabled ? false : open} onOpenChange={(nextOpen) => {
        if (!disabled) onOpenChange(nextOpen);
      }}>
        <PopoverTrigger asChild>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between"
            disabled={disabled}
          >
            <span className={cn(!value && "text-muted-foreground")}>{selected?.label ?? "Auto"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          {options.map((option) => (
            <button
              key={option.id || "auto"}
              className={cn(
                "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                option.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(option.id);
                onOpenChange(false);
              }}
            >
              <span>{option.label}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
