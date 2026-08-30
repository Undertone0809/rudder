import { agentsApi } from "@/api/agents";
import { rudderPluginsApi } from "@/api/rudderPlugins";
import { PluginIcon, themedPluginIconUrl } from "@/components/PluginIcon";
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
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useTheme } from "@/context/ThemeContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import type {
  Agent,
  RudderPluginDetail as PluginDetailData,
  RudderInstalledPlugin,
  RudderPluginCapabilitySnapshot,
  RudderPluginCompatibilityComponent,
  RudderPluginComponentLink,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowLeft,
  Bot,
  Check,
  CircleAlert,
  ExternalLink,
  FileCode2,
  Loader2,
  Package,
  PlugZap,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

function componentIcon(type: RudderPluginCompatibilityComponent["type"]) {
  if (type === "skill") return FileCode2;
  if (type === "mcp") return Unplug;
  if (type === "app") return AppWindow;
  return CircleAlert;
}

function componentStatus(component: RudderPluginCompatibilityComponent) {
  if (component.status === "setup_required") return "Setup after install";
  if (component.status === "unsupported") return "Unsupported";
  if (component.status === "disabled") return "Disabled";
  return "Included";
}

function ComponentSection({
  title,
  components,
  total,
}: {
  title: string;
  components: RudderPluginCompatibilityComponent[];
  total?: number;
}) {
  if (components.length === 0) return null;
  return (
    <section aria-labelledby={`plugin-${title.toLowerCase()}-heading`}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 id={`plugin-${title.toLowerCase()}-heading`} className="text-[15px] font-semibold">
          {title} <span className="font-normal text-muted-foreground">
            {total !== undefined && total !== components.length ? `${components.length} / ${total}` : components.length}
          </span>
        </h2>
      </div>
      <div className="divide-y border-y border-[color:var(--border-soft)]">
        {components.map((component) => {
          const Icon = componentIcon(component.type);
          const unsupported = component.status === "unsupported";
          return (
            <div key={component.key} className="flex min-h-[68px] items-start gap-3 py-3.5">
              <div className={cn(
                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[color:var(--border-soft)]",
                unsupported ? "bg-amber-500/5 text-amber-700 dark:text-amber-400" : "bg-[color:var(--surface-inset)] text-muted-foreground",
              )}>
                <Icon className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="break-words text-sm font-medium">{component.name}</h3>
                  <span className={cn(
                    "shrink-0 text-xs",
                    unsupported ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                  )}>
                    {componentStatus(component)}
                  </span>
                </div>
                {component.detail ? (
                  <p className="mt-1 max-w-3xl break-words text-[13px] leading-5 text-muted-foreground">
                    {component.detail}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CapabilityChanges({ detail }: { detail: PluginDetailData }) {
  const changes = detail.capabilityDiff?.changes ?? [];
  if (detail.action !== "update" || changes.length === 0) return null;
  const groups = ["added", "removed", "changed"] as const;
  return (
    <section aria-labelledby="plugin-capability-changes-heading">
      <h2 id="plugin-capability-changes-heading" className="text-[15px] font-semibold">Capability changes</h2>
      <p className="mt-1 text-xs text-muted-foreground">See what this immutable update changes before replacing the installed version.</p>
      <div className="mt-3 divide-y border-y border-[color:var(--border-soft)]">
        {groups.flatMap((kind) => changes.filter((change) => change.kind === kind)).map((change) => (
          <div key={`${change.kind}:${change.key}`} className="flex items-start gap-3 py-3.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="break-words text-sm font-medium">{change.name}</div>
                <span className={cn(
                  "text-xs font-medium capitalize",
                  change.kind === "added" && "text-emerald-700 dark:text-emerald-400",
                  change.kind === "removed" && "text-destructive",
                  change.kind === "changed" && "text-amber-700 dark:text-amber-400",
                )}>{change.kind}</span>
              </div>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{change.detail}</p>
              <div className="mt-1 text-xs text-muted-foreground">
                {change.type.toUpperCase()} · Access {change.accessImpact}
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <CapabilitySurface label="Before" snapshot={change.before} />
                <CapabilitySurface label="After" snapshot={change.after} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function surfaceLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function surfaceValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    const visible = value.slice(0, 4).map((entry) => (
      typeof entry === "string" ? entry : JSON.stringify(entry)
    ));
    return `${visible.join(", ")}${value.length > visible.length ? ` +${value.length - visible.length} more` : ""}`;
  }
  return JSON.stringify(value);
}

function CapabilitySurface({
  label,
  snapshot,
}: {
  label: "Before" | "After";
  snapshot: RudderPluginCapabilitySnapshot | null;
}) {
  return (
    <div className="min-w-0 border-l-2 border-[color:var(--border-soft)] pl-3" data-testid={`capability-surface-${label.toLowerCase()}`}>
      <div className="text-xs font-medium">{label} execution surface</div>
      {snapshot ? (
        <dl className="mt-1.5 space-y-1 text-xs text-muted-foreground">
          <div className="flex min-w-0 gap-2">
            <dt className="shrink-0">Status</dt>
            <dd className="min-w-0 break-all text-foreground/80">{snapshot.status}</dd>
          </div>
          {Object.entries(snapshot.executionSurface).map(([key, value]) => (
            <div key={key} className="flex min-w-0 gap-2">
              <dt className="shrink-0">{surfaceLabel(key)}</dt>
              <dd className="min-w-0 break-all text-foreground/80">{surfaceValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="mt-1.5 text-xs text-muted-foreground">Not present</div>
      )}
    </div>
  );
}

function InstalledActions({
  plugin,
  onAssign,
  onConfigureMcp,
}: {
  plugin: RudderInstalledPlugin | null;
  onAssign: () => void;
  onConfigureMcp: (component: RudderPluginComponentLink) => void;
}) {
  if (!plugin) return null;
  const hasSkills = plugin.components.some((component) => component.type === "skill");
  const mcpComponents = plugin.components.filter((component) => component.type === "mcp");
  if (!hasSkills && mcpComponents.length === 0) return null;
  return (
    <section aria-labelledby="plugin-next-steps-heading">
      <h2 id="plugin-next-steps-heading" className="mb-2.5 text-[15px] font-semibold">Set up</h2>
      <div className="divide-y border-y border-[color:var(--border-soft)]">
        {hasSkills ? (
          <div className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Agent access</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Choose which Agents can use the installed Skills.</div>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={onAssign}><Bot className="h-3.5 w-3.5" />Add to Agent</Button>
          </div>
        ) : null}
        {mcpComponents.map((component) => (
          <div key={component.id} className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">{component.displayName}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {component.targetId ? "Continue in Managed MCP settings." : "Create a disabled Managed MCP draft."}
                </div>
              </div>
            </div>
            {component.targetId ? (
              <Button asChild size="sm" variant="outline">
                <Link to="/organization/settings?view=integrations">Open settings<ExternalLink className="h-3.5 w-3.5" /></Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => onConfigureMcp(component)}>Set up</Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Information({ detail }: { detail: PluginDetailData }) {
  const items = [
    ["Capabilities", detail.capabilities.length > 0 ? detail.capabilities.join(", ") : "Not declared"],
    ["Developer", detail.developer],
    ["Category", detail.category],
    ["Version", detail.resolution.version],
    ["Source", detail.resolution.source],
    ["Commit", detail.resolution.commitSha],
    ["License", detail.license.spdx],
  ] as const;
  const links = [
    ["Website", detail.websiteUrl],
    ["Privacy Policy", detail.privacyPolicyUrl],
    ["Terms of Service", detail.termsOfServiceUrl],
    ["Source license", detail.license.sourceUrl],
  ] as const;
  return (
    <section aria-labelledby="plugin-information-heading">
      <h2 id="plugin-information-heading" className="mb-2.5 text-[15px] font-semibold">Information</h2>
      <dl className="border-y border-[color:var(--border-soft)] py-3 text-sm">
        {items.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5 sm:grid-cols-[140px_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("min-w-0 break-words", label === "Commit" && "font-mono text-xs leading-5")}>{value}</dd>
          </div>
        ))}
        {links.map(([label, url]) => (
          <div key={label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5 sm:grid-cols-[140px_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>
              <a className="inline-flex max-w-full items-center gap-1.5 break-all hover:underline" href={url} target="_blank" rel="noreferrer">
                {url.replace(/^https:\/\//, "").replace(/\/$/, "")}<ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PluginDetail() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const previewId = searchParams.get("preview");
  const { selectedOrganizationId } = useOrganization();
  const { resolvedTheme } = useTheme();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [accessExpansionConfirmed, setAccessExpansionConfirmed] = useState(false);
  const [skillConflictStrategy, setSkillConflictStrategy] = useState<"keep" | "replace" | "rename" | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [componentSearch, setComponentSearch] = useState("");

  const detailQuery = useQuery({
    queryKey: previewId
      ? queryKeys.rudderPlugins.previewDetail(selectedOrganizationId ?? "__none__", previewId)
      : queryKeys.rudderPlugins.catalogDetail(selectedOrganizationId ?? "__none__", slug),
    queryFn: () => previewId
      ? rudderPluginsApi.getPreview(selectedOrganizationId!, previewId)
      : rudderPluginsApi.previewCatalog(selectedOrganizationId!, slug),
    enabled: Boolean(selectedOrganizationId && slug),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const detail = detailQuery.data ?? null;
  const themedIconUrl = themedPluginIconUrl(detail?.iconUrl, resolvedTheme);

  useEffect(() => {
    if (!selectedOrganizationId || !detail?.previewId || previewId === detail.previewId) return;
    queryClient.setQueryData(
      queryKeys.rudderPlugins.previewDetail(selectedOrganizationId, detail.previewId),
      detail,
    );
    navigate(`/hub/plugins/${encodeURIComponent(detail.slug)}?preview=${encodeURIComponent(detail.previewId)}`, { replace: true });
  }, [detail, navigate, previewId, queryClient, selectedOrganizationId]);
  const installedQuery = useQuery({
    queryKey: queryKeys.rudderPlugins.installed(selectedOrganizationId ?? "__none__", detail?.installedPluginId ?? "__none__"),
    queryFn: () => rudderPluginsApi.get(selectedOrganizationId!, detail!.installedPluginId!),
    enabled: Boolean(selectedOrganizationId && detail?.installedPluginId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId && assignOpen),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Plugins", href: "/hub?tab=plugins" },
      { label: detail?.displayName ?? "Plugin" },
    ]);
    setHeaderActions(null);
    return () => setHeaderActions(null);
  }, [detail?.displayName, setBreadcrumbs, setHeaderActions]);

  const refresh = async () => {
    if (!selectedOrganizationId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.catalog(selectedOrganizationId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.directory(selectedOrganizationId) });
    if (detail?.previewId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.previewDetail(selectedOrganizationId, detail.previewId) });
    } else {
      await queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.catalogDetail(selectedOrganizationId, slug) });
    }
  };
  const onError = (value: unknown) => setError(value instanceof Error ? value.message : "Plugin action failed.");
  const installMutation = useMutation({
    mutationFn: () => rudderPluginsApi.install(
      selectedOrganizationId!,
      detail!.previewId!,
      accessExpansionConfirmed,
      skillConflictStrategy ?? undefined,
    ),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });
  const assignMutation = useMutation({
    mutationFn: () => rudderPluginsApi.configureSkills(selectedOrganizationId!, detail!.installedPluginId!, selectedAgentIds),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setAssignOpen(false);
      await installedQuery.refetch();
    },
    onError,
  });
  const mcpMutation = useMutation({
    mutationFn: (component: RudderPluginComponentLink) => rudderPluginsApi.configureMcp(selectedOrganizationId!, detail!.installedPluginId!, component.id),
    onMutate: () => setError(null),
    onSuccess: () => installedQuery.refetch(),
    onError,
  });
  const uninstallMutation = useMutation({
    mutationFn: () => rudderPluginsApi.uninstall(selectedOrganizationId!, detail!.installedPluginId!),
    onMutate: () => setError(null),
    onSuccess: async () => {
      const installedPluginId = detail!.installedPluginId!;
      const installedKey = queryKeys.rudderPlugins.installed(selectedOrganizationId!, installedPluginId);
      await queryClient.cancelQueries({ queryKey: installedKey });
      queryClient.removeQueries({ queryKey: installedKey, exact: true });
      navigate("/hub?tab=plugins");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.catalog(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.directory(selectedOrganizationId!) }),
      ]);
    },
    onError,
  });

  const installed = installedQuery.data ?? null;
  const isActionable = detail?.action === "install" || detail?.action === "update";
  const requiredConflictChoice = Boolean(isActionable && detail?.skillConflicts.length && !skillConflictStrategy);
  const requiredAccessConfirmation = Boolean(
    detail?.action === "update"
    && detail.capabilityDiff?.accessExpansion
    && !accessExpansionConfirmed,
  );
  const canInstall = Boolean(detail?.previewId && !requiredConflictChoice && !requiredAccessConfirmation);
  const normalizedComponentSearch = componentSearch.trim().toLocaleLowerCase("en-US");
  const filteredGroups = useMemo(() => {
    if (!detail || !normalizedComponentSearch) return detail?.groups ?? null;
    const matches = (component: RudderPluginCompatibilityComponent) => (
      `${component.name} ${component.detail ?? ""} ${component.type}`
        .toLocaleLowerCase("en-US")
        .includes(normalizedComponentSearch)
    );
    return {
      skills: detail.groups.skills.filter(matches),
      mcps: detail.groups.mcps.filter(matches),
      apps: detail.groups.apps.filter(matches),
      unsupported: detail.groups.unsupported.filter(matches),
    };
  }, [detail, normalizedComponentSearch]);
  const filteredComponentCount = filteredGroups
    ? Object.values(filteredGroups).reduce((total, components) => total + components.length, 0)
    : 0;
  const activeAgentIds = useMemo(() => installed?.components
    .filter((component) => component.type === "skill")
    .flatMap((component) => Array.isArray(component.metadata.enabledAgentIds)
      ? component.metadata.enabledAgentIds.filter((value): value is string => typeof value === "string")
      : [])
    .filter((id, index, values) => values.indexOf(id) === index) ?? [], [installed?.components]);

  if (!selectedOrganizationId) return <div className="p-6 text-sm text-muted-foreground">Select an Organization.</div>;
  if (detailQuery.isLoading) {
    return (
      <main className="h-full overflow-y-auto px-4 py-6 md:px-8 md:py-8" data-testid="plugin-detail-loading">
        <div className="mx-auto max-w-[860px] animate-pulse">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate("/hub?tab=plugins")}>
            <ArrowLeft className="h-4 w-4" />Plugins
          </Button>
          <div className="mt-8 flex gap-5"><div className="h-16 w-16 rounded-md bg-muted" /><div className="flex-1"><div className="h-7 w-52 rounded bg-muted" /><div className="mt-3 h-4 w-80 max-w-full rounded bg-muted" /></div></div>
          <div className="mt-12 h-px bg-border" />
        </div>
      </main>
    );
  }
  if (detailQuery.error || !detail) {
    return (
      <main className="flex h-full items-center justify-center p-6" data-testid="plugin-detail-error">
        <div className="max-w-md text-center">
          <CircleAlert className="mx-auto h-6 w-6 text-destructive" />
          <h1 className="mt-3 text-base font-semibold">Plugin unavailable</h1>
          <p className="mt-1 text-sm text-muted-foreground">{detailQuery.error instanceof Error ? detailQuery.error.message : "The Plugin could not be loaded."}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" onClick={() => navigate("/hub?tab=plugins")}><ArrowLeft className="h-4 w-4" />Back to Plugins</Button>
            <Button onClick={() => detailQuery.refetch()}>Retry</Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto px-4 py-5 md:px-8 md:py-7" data-testid="plugin-detail-page">
      <div className="mx-auto max-w-[860px] pb-16">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate("/hub?tab=plugins")}>
          <ArrowLeft className="h-4 w-4" />Plugins
        </Button>

        <header className="mt-8 flex flex-col gap-5 border-b border-[color:var(--border-soft)] pb-8 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-4 sm:gap-5">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-sm">
              <PluginIcon
                src={themedIconUrl}
                fallback={Package}
                className="h-full w-full p-1"
                fallbackClassName="h-7 w-7 text-muted-foreground"
                testId="plugin-detail-icon"
              />
            </div>
            <div className="min-w-0 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="break-words text-2xl font-semibold leading-tight">{detail.displayName}</h1>
                {detail.action === "update" ? <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Update available</span> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{detail.developer}</p>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{detail.shortDescription}</p>
            </div>
          </div>
          <Button
            className="w-full shrink-0 sm:mt-2 sm:w-auto"
            disabled={detail.action === "installed" || installMutation.isPending || !canInstall}
            onClick={() => installMutation.mutate()}
          >
            {installMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : detail.action === "installed" ? <Check className="h-4 w-4" /> : detail.action === "update" ? <RotateCcw className="h-4 w-4" /> : <Package className="h-4 w-4" />}
            {installMutation.isPending ? (detail.action === "update" ? "Updating..." : "Installing...") : detail.action === "installed" ? "Installed" : detail.action === "update" ? "Update" : "Install"}
          </Button>
        </header>

        <div className="space-y-10 pt-8">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{detail.longDescription}</p>

          {detail.warnings.length > 0 ? (
            <div className="flex items-start gap-2.5 border-y border-amber-600/25 bg-amber-500/5 px-1 py-3 text-sm text-amber-800 dark:text-amber-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div>{detail.warnings.join(" ")}</div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4" />Inspected without executing package code
            </div>
          )}

          {isActionable && detail.skillConflicts.length > 0 ? (
            <section>
              <h2 className="text-[15px] font-semibold">Skill conflicts</h2>
              <p className="mt-1 text-xs text-muted-foreground">Choose how to handle {detail.skillConflicts.length} existing Organization Skill{detail.skillConflicts.length === 1 ? "" : "s"}.</p>
              <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Skill conflict strategy">
                {([['keep', 'Keep'], ['replace', 'Replace'], ['rename', 'Install both']] as const).map(([value, label]) => (
                  <Button key={value} type="button" size="sm" variant={skillConflictStrategy === value ? "default" : "outline"} onClick={() => setSkillConflictStrategy(value)}>{label}</Button>
                ))}
              </div>
            </section>
          ) : null}

          {detail.action === "update" && detail.capabilityDiff?.accessExpansion ? (
            <label className="flex cursor-pointer items-start gap-3 border-y border-amber-600/25 py-3 text-sm">
              <input className="mt-0.5" type="checkbox" checked={accessExpansionConfirmed} onChange={(event) => setAccessExpansionConfirmed(event.target.checked)} />
              <span><span className="font-medium">Approve expanded access</span><span className="mt-0.5 block text-xs text-muted-foreground">This update adds or changes a Skill or MCP execution surface.</span></span>
            </label>
          ) : null}

          <CapabilityChanges detail={detail} />

          {error ? <div className="border-y border-destructive/30 bg-destructive/5 py-3 text-sm text-destructive" role="alert">{error}</div> : null}

          {detail.components.length > 12 ? (
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={componentSearch}
                onChange={(event) => setComponentSearch(event.target.value)}
                placeholder={`Search ${detail.components.length} components`}
                aria-label="Search Plugin components"
                className="pl-8"
              />
            </div>
          ) : null}

          {filteredGroups && filteredComponentCount > 0 ? (
            <>
              <ComponentSection title="Skills" components={filteredGroups.skills} total={detail.groups.skills.length} />
              <ComponentSection title="MCPs" components={filteredGroups.mcps} total={detail.groups.mcps.length} />
              <ComponentSection title="Apps" components={filteredGroups.apps} total={detail.groups.apps.length} />
              <ComponentSection title="Unsupported" components={filteredGroups.unsupported} total={detail.groups.unsupported.length} />
            </>
          ) : (
            <div className="border-y border-[color:var(--border-soft)] py-6 text-sm text-muted-foreground">No components match this search.</div>
          )}

          <InstalledActions
            plugin={installed}
            onAssign={() => { setSelectedAgentIds(activeAgentIds); setAssignOpen(true); }}
            onConfigureMcp={(component) => mcpMutation.mutate(component)}
          />
          <Information detail={detail} />

          {detail.installedPluginId ? (
            <div className="flex justify-end border-t border-[color:var(--border-soft)] pt-5">
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setUninstallOpen(true)}>Uninstall</Button>
            </div>
          ) : null}
        </div>
      </div>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Skills to Agents</DialogTitle><DialogDescription>{detail.displayName}</DialogDescription></DialogHeader>
          <div className="max-h-72 divide-y overflow-y-auto border-y">
            {(agentsQuery.data ?? []).map((agent: Agent) => (
              <label key={agent.id} className="flex min-h-12 cursor-pointer items-center gap-3 px-1 py-2 hover:bg-muted/35">
                <input type="checkbox" checked={selectedAgentIds.includes(agent.id)} onChange={(event) => setSelectedAgentIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))} />
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{agent.name}</span>
              </label>
            ))}
          </div>
          {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
          <DialogFooter showCloseButton><Button disabled={assignMutation.isPending} onClick={() => assignMutation.mutate()}>{assignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={uninstallOpen} onOpenChange={setUninstallOpen}>
        <DialogContent showCloseButton={false} onEscapeKeyDown={() => setUninstallOpen(false)}>
          <DialogHeader><DialogTitle>Uninstall {detail.displayName}?</DialogTitle><DialogDescription>Plugin-managed Skills are removed. Customized Skills, Managed MCP connections, and user data remain.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={uninstallMutation.isPending} onClick={() => setUninstallOpen(false)}>Close</Button>
            <Button variant="destructive" disabled={uninstallMutation.isPending} onClick={() => uninstallMutation.mutate()}>{uninstallMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Uninstall</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
