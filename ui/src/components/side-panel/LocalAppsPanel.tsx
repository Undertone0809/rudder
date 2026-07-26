import { CopyText } from "@/components/CopyText";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import {
  readDesktopShell,
  type DesktopLocalAppDefinition,
  type DesktopLocalAppDefinitionDraft,
  type DesktopPreparedLocalAppDefinition,
} from "@/lib/desktop-shell";
import {
  localAppDefinitionFromForm,
  localAppDefinitionToForm,
  localAppStatusRefetchInterval,
  type LocalAppDefinitionForm,
} from "@/lib/local-apps";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ChevronDown,
  CircleAlert,
  Copy,
  FolderSearch,
  Loader2,
  Pencil,
  RotateCw,
  ShieldAlert,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

function safeTestId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function message(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function shellCommandToken(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

const readableExecutableNames = new Set([
  "bash",
  "bun",
  "cargo",
  "deno",
  "fish",
  "go",
  "next",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "ruby",
  "sh",
  "uv",
  "vite",
  "yarn",
  "zsh",
]);

function localAppStartCommand(form: LocalAppDefinitionForm) {
  const executableParts = form.executable.trim().split(/[\\/]/).filter(Boolean);
  const executableName = executableParts.at(-1);
  const isNpmCli = executableName === "npm-cli.js" && executableParts.at(-2) === "bin" && executableParts.at(-3) === "npm";
  const executable = isNpmCli || readableExecutableNames.has(executableName ?? "")
    ? executableName === "npm-cli.js" ? "npm" : executableName
    : form.executable.trim();
  const argumentsList = form.argvText.split(/\r?\n/).filter((value) => value.length > 0);
  const tokens = [executable, ...argumentsList].filter((value): value is string => Boolean(value));
  return tokens.length ? tokens.map(shellCommandToken).join(" ") : "No start command";
}

export function LocalAppDefinitionReviewDialog({
  definition,
  edit,
  error,
  editable = true,
  open,
  pending,
  requestEditPending = false,
  title,
  onCancel,
  onRequestEdit,
  onSubmit,
}: {
  definition: DesktopPreparedLocalAppDefinition | DesktopLocalAppDefinition | null;
  edit: boolean;
  error: unknown;
  editable?: boolean;
  open: boolean;
  pending: boolean;
  requestEditPending?: boolean;
  title?: string;
  onCancel: () => void;
  onRequestEdit?: () => void;
  onSubmit: (definition: DesktopLocalAppDefinitionDraft) => void;
}) {
  const [form, setForm] = useState<LocalAppDefinitionForm | null>(() => (
    definition ? localAppDefinitionToForm(definition) : null
  ));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const formScrollRef = useScrollbarActivityRef();
  useEffect(() => {
    if (!definition) return;
    setForm(localAppDefinitionToForm(definition));
    setValidationError(null);
    setAdvancedOpen(false);
  }, [definition]);
  useEffect(() => {
    if (open) setAdvancedOpen(false);
  }, [open]);
  if (!form) return null;

  const update = (key: keyof LocalAppDefinitionForm, value: string) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };
  const startCommand = localAppStartCommand(form);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = localAppDefinitionFromForm(form);
    if (!parsed.ok) {
      setValidationError(parsed.error);
      return;
    }
    setValidationError(null);
    onSubmit(parsed.definition);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !pending) onCancel(); }}>
      <DialogContent className="flex max-h-[min(90vh,52rem)] flex-col overflow-hidden sm:max-w-2xl" data-testid="local-app-definition-review">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <DialogHeader className="shrink-0">
            <DialogTitle>{title ?? (edit ? "Edit local app" : "Add local app")}</DialogTitle>
            <DialogDescription>
              Rudder will use the command below to start this project on your device.
            </DialogDescription>
          </DialogHeader>
          <div
            ref={formScrollRef}
            aria-label="Local App launch details"
            className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
            data-testid="local-app-definition-review-scroll"
            role="region"
            tabIndex={0}
          >
            <div className="mt-5 space-y-4">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[color:var(--surface-active)] text-muted-foreground">
                    <TerminalSquare className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Start command</p>
                    <code className="mt-2 block break-words font-mono text-sm font-medium text-foreground" data-testid="local-app-start-command">
                      {startCommand}
                    </code>
                  </div>
                  <CopyText
                    text={startCommand}
                    ariaLabel="Copy start command"
                    title="Copy start command"
                    copiedLabel="Copied"
                    className="rounded-[var(--control-radius)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] p-2 text-muted-foreground hover:bg-[color:var(--surface-active)]"
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                  </CopyText>
                </div>
                <div className="mt-4 grid gap-3 border-t border-[color:var(--border-soft)] pt-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">Project folder</p>
                    <p className="mt-1 truncate font-mono text-xs text-foreground" data-testid="local-app-project-folder" title={form.cwd}>{form.cwd}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Open after it is ready</p>
                    <p className="mt-1 font-mono text-xs text-foreground">{form.openPath}</p>
                  </div>
                </div>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                Rudder runs this command in the project folder, waits for it to be ready, then opens the local app.
              </p>
              {!editable ? (
                <p className="text-sm text-muted-foreground">
                  Stop this Local App to edit its launch settings.
                </p>
              ) : null}
              <div className="rounded-[var(--radius-md)] border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-sm text-foreground">
                <div className="flex gap-3">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                  <p>This runs project code on your device. Only continue if you recognize this folder and command.</p>
                </div>
              </div>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-[var(--radius-md)] border border-[color:var(--border-soft)] px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-[color:var(--surface-active)]"
                aria-controls="local-app-advanced-settings"
                aria-expanded={advancedOpen}
                data-testid="local-app-advanced-toggle"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <span>{advancedOpen ? "Hide advanced settings" : "View advanced settings"}</span>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {advancedOpen ? (
                <div id="local-app-advanced-settings" className="grid gap-4 rounded-[var(--radius-md)] border border-[color:var(--border-soft)] p-4 sm:grid-cols-2" data-testid="local-app-advanced-settings">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="local-app-name">Name</Label>
                    <Input id="local-app-name" disabled={!editable} value={form.title} onChange={(event) => update("title", event.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="local-app-cwd">Working directory</Label>
                    <Input id="local-app-cwd" disabled={!editable} value={form.cwd} onChange={(event) => update("cwd", event.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="local-app-executable">Resolved executable</Label>
                    <Input id="local-app-executable" disabled={!editable} value={form.executable} onChange={(event) => update("executable", event.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="local-app-argv">Arguments · one literal argument per line</Label>
                    <Textarea id="local-app-argv" disabled={!editable} className="font-mono text-xs" value={form.argvText} onChange={(event) => update("argvText", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="local-app-readiness">Readiness path</Label>
                    <Input id="local-app-readiness" disabled={!editable} value={form.readinessPath} onChange={(event) => update("readinessPath", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="local-app-timeout">Timeout (milliseconds)</Label>
                    <Input id="local-app-timeout" disabled={!editable} inputMode="numeric" value={form.timeoutMs} onChange={(event) => update("timeoutMs", event.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="local-app-open-path">Page to open after readiness</Label>
                    <Input id="local-app-open-path" disabled={!editable} value={form.openPath} onChange={(event) => update("openPath", event.target.value)} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="local-app-environment">Inherited environment names · one per line</Label>
                    <Textarea id="local-app-environment" disabled={!editable} className="font-mono text-xs" value={form.environmentNamesText} onChange={(event) => update("environmentNamesText", event.target.value)} />
                    <p className="text-xs leading-5 text-muted-foreground">Rudder supplies a safe PATH automatically. PATH entered here is ignored.</p>
                  </div>
                </div>
              ) : null}
            </div>
            {validationError || error ? (
              <p className="mt-4 text-sm text-destructive" data-testid="local-app-error" role="alert">
                {validationError ?? message(error, "Desktop could not save this Local App.")}
              </p>
            ) : null}
          </div>
          <DialogFooter className="mt-6 shrink-0">
            <Button type="button" variant="outline" disabled={pending || requestEditPending} onClick={onCancel}>Cancel</Button>
            {editable ? (
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {edit ? "Review & save" : "Review & add"}
              </Button>
            ) : (
              <Button type="button" disabled={!onRequestEdit || requestEditPending} onClick={onRequestEdit}>
                {requestEditPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Square className="h-3.5 w-3.5" aria-hidden />}
                Stop & edit
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LocalAppCatalogRow({
  definition,
  onEdit,
  onDelete,
  onOpenTarget,
}: {
  definition: DesktopLocalAppDefinition;
  onEdit: (definition: DesktopLocalAppDefinition) => void;
  onDelete: (definition: DesktopLocalAppDefinition) => void;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const localApps = readDesktopShell()!.localApps!;
  const [logsOpen, setLogsOpen] = useState(false);
  const statusQuery = useQuery({
    queryKey: queryKeys.localApps.status(definition.localBindingId),
    queryFn: () => localApps.status(definition.id),
    retry: false,
    refetchInterval: (query) => localAppStatusRefetchInterval(query.state.data?.status),
  });
  const status = statusQuery.data?.status ?? null;
  const active = status !== null && ["starting", "running", "stopping", "orphaned_unverified"].includes(status);
  const canChangeDefinition = !statusQuery.isError && (status === "stopped" || status === "failed");
  const stopMutation = useMutation({
    mutationFn: () => localApps.stop(definition.id),
    onSuccess: (nextStatus) => {
      queryClient.setQueryData(queryKeys.localApps.status(definition.localBindingId), nextStatus);
    },
  });
  const logsQuery = useQuery({
    queryKey: queryKeys.localApps.logs(definition.localBindingId),
    queryFn: () => localApps.logs(definition.id),
    enabled: logsOpen,
    retry: false,
  });
  const bindingTestId = safeTestId(definition.localBindingId);
  const statusLabel = status === "orphaned_unverified"
    ? "Needs attention"
    : status?.replaceAll("_", " ") ?? "Status unavailable";

  return (
    <article
      className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-4"
      data-testid={`local-apps-app-${bindingTestId}`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[color:var(--surface-active)] text-muted-foreground">
          <LocalAppIdentityIcon className="h-4 w-4" iconDataUrl={definition.iconDataUrl} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{definition.title}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{definition.cwd}</p>
          <p className="mt-1 text-xs capitalize text-muted-foreground">
            {statusQuery.isPending ? "checking…" : statusQuery.isError ? "status unavailable" : statusLabel}
          </p>
        </div>
      </div>
      {statusQuery.error ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-destructive/25 bg-destructive/5 p-3" role="alert">
          <p className="min-w-0 text-xs text-destructive">{message(statusQuery.error, "Could not read runtime status.")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void statusQuery.refetch()}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Retry status
          </Button>
        </div>
      ) : null}
      {status === "orphaned_unverified" ? (
        <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">Ownership is unverified. Restart Rudder Desktop before changing this definition.</p>
      ) : null}
      {active && status !== "orphaned_unverified" ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Stop this Local App before editing or deleting it.</p>
      ) : null}
      {!statusQuery.isPending && statusQuery.isError ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Confirm runtime status before editing or deleting this definition.</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          data-testid={`local-apps-open-${bindingTestId}`}
          onClick={() => onOpenTarget({
            kind: "local_app",
            desktopInstallationId: definition.desktopInstallationId,
            appPublicId: definition.appPublicId,
            localBindingId: definition.localBindingId,
            label: definition.title,
          })}
        >
          <AppWindow className="h-3.5 w-3.5" aria-hidden />
          Open
        </Button>
        {(status === "running" || status === "starting" || status === "stopping") ? (
          <Button type="button" size="sm" variant="outline" disabled={stopMutation.isPending || status === "stopping"} onClick={() => stopMutation.mutate()}>
            {stopMutation.isPending || status === "stopping"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              : <Square className="h-3.5 w-3.5" aria-hidden />}
            Stop
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canChangeDefinition}
          title={!canChangeDefinition ? "Confirm this Local App is stopped before editing it." : undefined}
          onClick={() => onEdit(definition)}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canChangeDefinition}
          title={!canChangeDefinition ? "Confirm this Local App is stopped before deleting it." : undefined}
          onClick={() => onDelete(definition)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setLogsOpen((open) => !open)}>
          <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
          Logs
        </Button>
      </div>
      {stopMutation.error ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-destructive/25 bg-destructive/5 p-3" role="alert">
          <p className="min-w-0 text-xs text-destructive">{message(stopMutation.error, "Could not stop this Local App.")}</p>
          <Button type="button" size="sm" variant="outline" disabled={stopMutation.isPending} onClick={() => stopMutation.mutate()}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Retry stop
          </Button>
        </div>
      ) : null}
      {logsOpen ? (
        logsQuery.error ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-destructive/25 bg-destructive/5 p-3" role="alert">
            <p className="min-w-0 text-xs text-destructive">{message(logsQuery.error, "Could not load runtime logs.")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void logsQuery.refetch()}>
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
              Retry logs
            </Button>
          </div>
        ) : (
          <pre
            className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[color:var(--surface-inset)] p-3 font-mono text-[11px] leading-5 text-muted-foreground"
            data-testid="local-app-logs"
            tabIndex={0}
            aria-label={`${definition.title} runtime logs`}
          >
            {logsQuery.isPending ? "Loading logs…" : logsQuery.data?.join("\n") || "No runtime logs yet."}
          </pre>
        )
      ) : null}
    </article>
  );
}

export function LocalAppsPanel({
  onOpenTarget,
}: {
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const localApps = readDesktopShell()?.localApps;
  const queryClient = useQueryClient();
  const [review, setReview] = useState<{
    definition: DesktopPreparedLocalAppDefinition | DesktopLocalAppDefinition;
    editId: string | null;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DesktopLocalAppDefinition | null>(null);
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    enabled: Boolean(localApps?.supported),
  });
  const discoverMutation = useMutation({
    mutationFn: () => localApps!.discover(),
    onSuccess: (result) => {
      if (!result.canceled) setReview({ definition: result.draft, editId: null });
    },
  });
  const saveMutation = useMutation({
    mutationFn: ({ definition, editId }: { definition: DesktopLocalAppDefinitionDraft; editId: string | null }) => (
      editId ? localApps!.update(editId, definition) : localApps!.create(definition)
    ),
    onSuccess: (saved) => {
      queryClient.setQueryData<DesktopLocalAppDefinition[]>(queryKeys.localApps.definitions, (current) => {
        if (!current) return [saved];
        const exists = current.some((candidate) => candidate.id === saved.id);
        return exists ? current.map((candidate) => candidate.id === saved.id ? saved : candidate) : [...current, saved];
      });
      setReview(null);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (definition: DesktopLocalAppDefinition) => localApps!.delete(definition.id),
    onSuccess: (_, deleted) => {
      queryClient.setQueryData<DesktopLocalAppDefinition[]>(queryKeys.localApps.definitions, (current) => (
        current?.filter((candidate) => candidate.id !== deleted.id) ?? []
      ));
      queryClient.removeQueries({ queryKey: queryKeys.localApps.status(deleted.localBindingId) });
      queryClient.removeQueries({ queryKey: queryKeys.localApps.logs(deleted.localBindingId) });
      setDeleteTarget(null);
    },
  });
  const topLevelError = definitionsQuery.error ?? discoverMutation.error;
  const closeDeleteDialog = () => {
    deleteMutation.reset();
    setDeleteTarget(null);
  };

  if (!localApps?.supported) {
    return (
      <div className="m-auto max-w-sm px-6 py-10 text-center" data-testid="local-app-error">
        <CircleAlert className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
        <h3 className="mt-4 text-base font-semibold text-foreground">Local Apps require Rudder Desktop on macOS</h3>
      </div>
    );
  }

  return (
    <section className="scrollbar-auto-hide min-h-full overflow-y-auto px-4 py-4" data-testid="local-apps-catalog">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Local apps</h2>
            <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">
              Run explicitly reviewed project services beside your work. Restoring a tab never starts a service.
            </p>
          </div>
          <Button type="button" size="sm" data-testid="local-apps-add" disabled={discoverMutation.isPending} onClick={() => discoverMutation.mutate()}>
            {discoverMutation.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              : <FolderSearch className="h-3.5 w-3.5" aria-hidden />}
            Add
          </Button>
        </div>
        {topLevelError ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive" data-testid="local-app-error" role="alert">
            <span>{message(topLevelError, "Could not load Local Apps.")}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (definitionsQuery.error) void definitionsQuery.refetch();
                if (discoverMutation.error) {
                  discoverMutation.reset();
                  discoverMutation.mutate();
                }
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {definitionsQuery.isPending ? (
          <div className="mt-8 flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Loading Local Apps…
          </div>
        ) : definitionsQuery.data?.length ? (
          <div className="mt-5 grid gap-3">
            {definitionsQuery.data.map((definition) => (
              <LocalAppCatalogRow
                key={definition.id}
                definition={definition}
                onEdit={(selected) => {
                  saveMutation.reset();
                  setReview({ definition: selected, editId: selected.id });
                }}
                onDelete={setDeleteTarget}
                onOpenTarget={onOpenTarget}
              />
            ))}
          </div>
        ) : (
          <div className="mt-8 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--border-base)] px-5 py-10 text-center">
            <AppWindow className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
            <h3 className="mt-4 text-sm font-semibold text-foreground">No Local Apps yet</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Choose a supported project folder to review its launch definition. Rudder never installs dependencies, builds, or runs migrations for you.</p>
          </div>
        )}
      </div>

      {review ? (
        <LocalAppDefinitionReviewDialog
          definition={review.definition}
          edit={Boolean(review.editId)}
          error={saveMutation.error}
          open
          pending={saveMutation.isPending}
          onCancel={() => {
            saveMutation.reset();
            setReview(null);
          }}
          onSubmit={(definition) => {
            saveMutation.mutate({ definition, editId: review.editId });
          }}
        />
      ) : null}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) closeDeleteDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Local App?</DialogTitle>
            <DialogDescription>
              This removes the trusted launch definition from this device. Messenger entries remain unavailable until configured again.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.error ? <p className="text-sm text-destructive" data-testid="local-app-error" role="alert">{message(deleteMutation.error, "Could not delete Local App.")}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deleteMutation.isPending} onClick={closeDeleteDialog}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={deleteMutation.isPending} onClick={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); }}>
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
