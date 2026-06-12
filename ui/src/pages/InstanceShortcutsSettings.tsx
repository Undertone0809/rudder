import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KeyboardShortcutActionId, KeyboardShortcutSettings } from "@rudderhq/shared";
import { Keyboard, Pencil, RotateCcw, Save, X } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useI18n } from "@/context/I18nContext";
import { useToast } from "@/context/ToastContext";
import {
  findShortcutConflict,
  formatShortcutBinding,
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

const EMPTY_SHORTCUT_SETTINGS: KeyboardShortcutSettings = { shortcuts: [] };

function isConfigurableActionId(actionId: string): actionId is KeyboardShortcutActionId {
  return actionId !== "system.escapeBack";
}

function shortcutSettingsEqual(a: KeyboardShortcutSettings, b: KeyboardShortcutSettings) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ShortcutChips({ bindings, muted = false }: { bindings: readonly { key: string }[]; muted?: boolean }) {
  if (bindings.length === 0) {
    return <span className="text-[12px] text-muted-foreground">Disabled</span>;
  }

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {bindings.map((binding) => (
        <kbd
          key={formatShortcutBinding(binding)}
          className={cn(
            "rounded-[calc(var(--radius-md)-4px)] border px-2 py-1 font-mono text-[11px] leading-none",
            muted
              ? "border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] bg-transparent text-muted-foreground"
              : "border-[color:color-mix(in_oklab,var(--border-soft)_92%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)] text-foreground",
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
        <div className="divide-y divide-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)]">
          {KEYBOARD_SHORTCUT_REGISTRY.map((entry) => {
            const actionId = entry.configurable && isConfigurableActionId(entry.actionId) ? entry.actionId : null;
            const configurable = actionId !== null;
            const preference = actionId
              ? draft.shortcuts.find((shortcut) => shortcut.actionId === actionId)
              : null;
            const disabled = preference?.disabled === true;
            const bindings = actionId ? resolvedBindings[actionId] ?? [] : entry.defaultBindings;
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
              <div key={entry.actionId} className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] font-medium text-foreground">{entry.label}</h3>
                    <span className="rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_74%,transparent)] px-2 py-0.5 text-[11px] text-muted-foreground">
                      {entry.scope}
                    </span>
                    {!configurable ? (
                      <span className="rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_74%,transparent)] px-2 py-0.5 text-[11px] text-muted-foreground">
                        Read-only
                      </span>
                    ) : null}
                  </div>
                  <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">{entry.description}</p>
                  {editing ? (
                    <p className={cn("text-[12px] leading-5", captureError ? "text-destructive" : "text-muted-foreground")}>
                      {captureError ?? "Press a shortcut. Escape cancels capture."}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <ShortcutChips bindings={bindings} muted={disabled || !configurable} />
                  {actionId ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setEditingActionId(editing ? null : actionId);
                          setCaptureError(null);
                        }}
                        aria-label={editing ? "Cancel shortcut capture" : `Edit ${entry.label}`}
                        title={editing ? "Cancel capture" : "Edit shortcut"}
                      >
                        {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setDraft((current) => setShortcutPreference(current, actionId, null));
                          if (editingActionId === actionId) setEditingActionId(null);
                          setCaptureError(null);
                        }}
                        aria-label={`Reset ${entry.label}`}
                        title="Restore default"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                      {hasSingleKeyCreateIssueBinding ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
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
                          Disable C
                        </Button>
                      ) : null}
                      <SettingsToggle
                        checked={!disabled}
                        aria-label={disabled ? `Enable ${entry.label}` : `Disable ${entry.label}`}
                        title={disabled ? "Enable shortcut" : "Disable shortcut"}
                        onClick={() => {
                          setDraft((current) =>
                            disabled
                              ? setShortcutPreference(current, actionId, null)
                              : setShortcutPreference(current, actionId, { disabled: true }),
                          );
                          if (editingActionId === actionId) setEditingActionId(null);
                          setCaptureError(null);
                        }}
                      />
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
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
