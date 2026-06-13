import { instanceSettingsApi } from "@/api/instanceSettings";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useI18n } from "@/context/I18nContext";
import { useToast } from "@/context/ToastContext";
import {
  findShortcutConflict,
  formatShortcutBinding,
  getDefaultShortcutBindings,
  isReservedShortcut,
  KEYBOARD_SHORTCUT_REGISTRY,
  normalizeShortcutBinding,
  resolveKeyboardShortcutBindings,
  setShortcutPreference,
  shortcutEventToBinding,
} from "@/lib/keyboard-shortcuts";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { cn } from "@/lib/utils";
import type { KeyboardShortcutActionId, KeyboardShortcutSettings } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Pencil, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

const EMPTY_SHORTCUT_SETTINGS: KeyboardShortcutSettings = { shortcuts: [] };

function isConfigurableActionId(actionId: string): actionId is KeyboardShortcutActionId {
  return actionId !== "system.escapeBack";
}

function shortcutSettingsEqual(a: KeyboardShortcutSettings, b: KeyboardShortcutSettings) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function IconTooltipButton({
  label,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn("size-8 text-muted-foreground", className)}
          aria-label={label}
          title={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ShortcutChips({ bindings, muted = false }: { bindings: readonly { key: string }[]; muted?: boolean }) {
  if (bindings.length === 0) {
    return (
      <span className="inline-flex min-h-7 items-center rounded-full bg-[color:color-mix(in_oklab,var(--surface-inset)_80%,transparent)] px-3 text-[13px] text-muted-foreground">
        Unassigned
      </span>
    );
  }

  return (
    <div className="flex min-h-7 flex-wrap items-center gap-1.5">
      {bindings.map((binding) => (
        <kbd
          key={formatShortcutBinding(binding)}
          className={cn(
            "inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[12px] leading-none",
            muted
              ? "border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] bg-transparent text-muted-foreground"
              : "border-transparent bg-[color:color-mix(in_oklab,var(--surface-active)_82%,transparent)] text-foreground",
          )}
        >
          {formatShortcutBinding(binding)}
        </kbd>
      ))}
    </div>
  );
}

export function InstanceShortcutsSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<KeyboardShortcutSettings>(EMPTY_SHORTCUT_SETTINGS);
  const [editingActionId, setEditingActionId] = useState<KeyboardShortcutActionId | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.shortcuts") },
    ]);
  }, [setBreadcrumbs, t]);

  const shortcutsQuery = useQuery({
    queryKey: queryKeys.instance.shortcutSettings,
    queryFn: () => instanceSettingsApi.getShortcuts(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
    retry: false,
  });

  useEffect(() => {
    if (!shortcutsQuery.data) return;
    setDraft(shortcutsQuery.data);
  }, [shortcutsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => instanceSettingsApi.updateShortcuts(draft),
    onSuccess: async (next) => {
      setDraft(next);
      setActionError(null);
      setCaptureError(null);
      setEditingActionId(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.shortcutSettings });
      pushToast({
        title: "Shortcuts saved",
        body: "Your shortcut preferences have been updated.",
        tone: "success",
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to save shortcuts.";
      setActionError(message);
      pushToast({
        title: "Failed to save shortcuts",
        body: message,
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!editingActionId) return;
    const activeActionId = editingActionId;

    function handleCapture(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setEditingActionId(null);
        setCaptureError(null);
        return;
      }

      const binding = shortcutEventToBinding(event);
      if (!binding) return;
      if (isReservedShortcut(binding)) {
        setCaptureError("That shortcut is reserved by the browser or operating system.");
        return;
      }
      const conflictActionId = findShortcutConflict(activeActionId, binding, draft);
      if (conflictActionId) {
        const conflict = KEYBOARD_SHORTCUT_REGISTRY.find((entry) => entry.actionId === conflictActionId);
        setCaptureError(`Conflicts with ${conflict?.label ?? conflictActionId}.`);
        return;
      }

      setDraft((current) => setShortcutPreference(current, activeActionId, { bindings: [binding] }));
      setEditingActionId(null);
      setCaptureError(null);
    }

    document.addEventListener("keydown", handleCapture, true);
    return () => document.removeEventListener("keydown", handleCapture, true);
  }, [draft, editingActionId]);

  const resolvedBindings = useMemo(() => resolveKeyboardShortcutBindings(draft), [draft]);
  const persisted = shortcutsQuery.data ?? EMPTY_SHORTCUT_SETTINGS;
  const hasChanges = !shortcutSettingsEqual(draft, persisted);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleShortcutEntries = useMemo(() => {
    if (!normalizedSearchQuery) return KEYBOARD_SHORTCUT_REGISTRY;
    return KEYBOARD_SHORTCUT_REGISTRY.filter((entry) => {
      return `${entry.label} ${entry.description} ${entry.scope}`.toLowerCase().includes(normalizedSearchQuery);
    });
  }, [normalizedSearchQuery]);

  if (shortcutsQuery.isLoading) {
    return <SettingsPageSkeleton />;
  }

  if (shortcutsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {shortcutsQuery.error instanceof Error ? shortcutsQuery.error.message : "Failed to load shortcuts."}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 pb-6">
      <SettingsPageHeader
        icon={Keyboard}
        title={t("common.shortcuts")}
        description="Configure personal global shortcuts. System Escape behavior is shown for reference and stays read-only in this version."
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection
        title="Global"
        description="These shortcuts work outside text inputs, editors, menus, and dialogs."
      >
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_92%,transparent)]">
          <label className="flex min-h-12 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] px-3.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="sr-only">Search shortcuts</span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search shortcuts"
              className="h-11 min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>

          <div className="hidden min-h-10 grid-cols-[minmax(0,1fr)_minmax(14rem,0.58fr)_6.5rem] items-center border-b border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] px-4 text-[12px] font-medium text-muted-foreground sm:grid">
            <div>Command</div>
            <div>Keybinding</div>
            <div className="sr-only">Actions</div>
          </div>

          <div className="divide-y divide-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)]">
            {visibleShortcutEntries.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                No shortcuts match your search.
              </div>
            ) : null}

            {visibleShortcutEntries.map((entry) => {
              const actionId = entry.configurable && isConfigurableActionId(entry.actionId) ? entry.actionId : null;
              const configurable = actionId !== null;
              const preference = actionId
                ? draft.shortcuts.find((shortcut) => shortcut.actionId === actionId)
                : null;
              const disabled = preference?.disabled === true;
              const customized = preference !== null && preference !== undefined;
              const bindings = actionId ? resolvedBindings[actionId] ?? [] : getDefaultShortcutBindings(entry);
              const editing = actionId !== null && editingActionId === actionId;
              const hasSingleKeyCreateIssueBinding = actionId === "issue.create"
                && bindings.some((binding) => {
                  const normalized = normalizeShortcutBinding(binding);
                  return normalized.key === "c" &&
                    !normalized.metaKey &&
                    !normalized.ctrlKey &&
                    !normalized.altKey &&
                    !normalized.shiftKey;
                });

              return (
                <div
                  key={entry.actionId}
                  className="grid gap-3 px-4 py-3.5 transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-active)_42%,transparent)] sm:min-h-[5.25rem] sm:grid-cols-[minmax(0,1fr)_minmax(14rem,0.58fr)_6.5rem] sm:items-center"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-medium text-foreground">{entry.label}</h3>
                      <span className="rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] px-2 py-0.5 text-[11px] text-muted-foreground">
                        {entry.scope}
                      </span>
                      {!configurable ? (
                        <span className="rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] px-2 py-0.5 text-[11px] text-muted-foreground">
                          Read-only
                        </span>
                      ) : null}
                    </div>
                    <p className="max-w-2xl truncate text-[13px] leading-5 text-muted-foreground sm:whitespace-normal">
                      {entry.description}
                    </p>
                  </div>

                  <div className="min-w-0">
                    {editing ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span
                          className={cn(
                            "inline-flex min-h-9 items-center rounded-[var(--radius-md)] border px-4 text-[13px]",
                            captureError
                              ? "border-destructive/42 bg-destructive/8 text-destructive"
                              : "border-[color:var(--border-base)] bg-[color:var(--surface-active)] text-foreground",
                          )}
                        >
                          {captureError ?? "Press shortcut"}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-muted-foreground"
                          onClick={() => {
                            setEditingActionId(null);
                            setCaptureError(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <ShortcutChips bindings={bindings} muted={disabled || !configurable} />
                    )}
                  </div>

                  <div className="flex min-w-0 items-center gap-1 sm:justify-end">
                    {actionId ? (
                      <>
                        {hasSingleKeyCreateIssueBinding ? (
                          <IconTooltipButton
                            label="Disable C"
                            onClick={() => {
                              const nextBindings = bindings.filter((binding) => {
                                const normalized = normalizeShortcutBinding(binding);
                                return !(
                                  normalized.key === "c" &&
                                  !normalized.metaKey &&
                                  !normalized.ctrlKey &&
                                  !normalized.altKey &&
                                  !normalized.shiftKey
                                );
                              });
                              setDraft((current) => setShortcutPreference(current, actionId, { bindings: nextBindings }));
                              if (editingActionId === actionId) setEditingActionId(null);
                              setCaptureError(null);
                            }}
                          >
                            <X className="h-4 w-4" />
                          </IconTooltipButton>
                        ) : null}
                        <IconTooltipButton
                          label={editing ? "Cancel shortcut capture" : `Edit ${entry.label}`}
                          onClick={() => {
                            setEditingActionId(editing ? null : actionId);
                            setCaptureError(null);
                          }}
                        >
                          {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                        </IconTooltipButton>
                        {customized && !disabled ? (
                          <IconTooltipButton
                            label={`Restore default for ${entry.label}`}
                            onClick={() => {
                              setDraft((current) => setShortcutPreference(current, actionId, null));
                              if (editingActionId === actionId) setEditingActionId(null);
                              setCaptureError(null);
                            }}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </IconTooltipButton>
                        ) : null}
                        <IconTooltipButton
                          label={disabled ? `Enable shortcut for ${entry.label}` : `Disable shortcut for ${entry.label}`}
                          className={disabled ? "text-[color:var(--accent-strong)]" : undefined}
                          onClick={() => {
                            setDraft((current) =>
                              disabled
                                ? setShortcutPreference(current, actionId, null)
                                : setShortcutPreference(current, actionId, { disabled: true }),
                            );
                            if (editingActionId === actionId) setEditingActionId(null);
                            setCaptureError(null);
                          }}
                        >
                          {disabled ? <RotateCcw className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                        </IconTooltipButton>
                      </>
                    ) : (
                      <span className="text-[12px] text-muted-foreground sm:sr-only">Read-only</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </SettingsSection>

      <div className="flex justify-end gap-2 border-t border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={!hasChanges || saveMutation.isPending}
          onClick={() => {
            setDraft(persisted);
            setEditingActionId(null);
            setCaptureError(null);
            setActionError(null);
          }}
        >
          <RotateCcw className="h-4 w-4" />
          Revert
        </Button>
        <Button
          type="button"
          disabled={!hasChanges || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          <Save className="h-4 w-4" />
          {saveMutation.isPending ? "Saving..." : "Save shortcuts"}
        </Button>
      </div>
    </div>
  );
}
