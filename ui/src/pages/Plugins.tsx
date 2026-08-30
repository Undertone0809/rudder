import { agentsApi } from "@/api/agents";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { rudderPluginsApi } from "@/api/rudderPlugins";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { PluginIcon, PluginIconFrame, themedPluginIconUrl } from "@/components/PluginIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useTheme } from "@/context/ThemeContext";
import { appRoute } from "@/lib/apps-workspace";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { buildLibrarySkillHref } from "@/lib/skill-library-routes";
import { cn } from "@/lib/utils";
import type {
  Agent,
  RudderInstalledPlugin,
  RudderMcpUiResourceContent,
  RudderPluginCatalogEntry,
  RudderPluginComponentLink,
  RudderPluginDiscoverEntry,
  RudderPluginImportReport,
  RudderPluginPackageFileInput,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Blocks,
  BookOpen,
  Bot,
  Box,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Loader2,
  MessageCircle,
  PackageOpen,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Unplug,
  Upload,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type HubTab = "plugins" | "skills" | "showcase";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

async function selectedFolderFiles(files: readonly File[]): Promise<RudderPluginPackageFileInput[]> {
  return Promise.all(files.map(async (file) => ({
    path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name,
    content: await fileToBase64(file),
    encoding: "base64" as const,
  })));
}

async function selectedSkillFiles(files: readonly File[]) {
  return Promise.all(files.map(async (file) => ({
    path: file.webkitRelativePath || file.name,
    content: await file.text(),
  })));
}

export const MCP_UI_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "media-src data: blob:",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export function sandboxedMcpHtml(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove());
  const policy = parsed.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = MCP_UI_CSP;
  parsed.head.prepend(policy);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function componentIcon(type: RudderPluginComponentLink["type"]) {
  if (type === "skill") return FileCode2;
  if (type === "mcp") return Unplug;
  if (type === "app") return AppWindow;
  return CircleAlert;
}

function stateLabel(plugin: RudderInstalledPlugin) {
  if (!plugin.enabled) return "Disabled";
  if (plugin.setupState === "setup_required") return "Setup required";
  if (plugin.setupState === "blocked") return "Unavailable";
  if (plugin.healthState === "degraded") return "Degraded";
  return "Ready";
}

function localAppIdentity(component: RudderPluginComponentLink | null): {
  desktopInstallationId: string;
  appPublicId: string;
  localBindingId: string;
} | null {
  if (component?.type !== "app") return null;
  const { desktopInstallationId, appPublicId, localBindingId } = component.metadata;
  if (
    typeof desktopInstallationId !== "string"
    || typeof appPublicId !== "string"
    || typeof localBindingId !== "string"
    || !desktopInstallationId
    || !appPublicId
    || !localBindingId
  ) return null;
  return { desktopInstallationId, appPublicId, localBindingId };
}

function configuredPluginIconUrl(
  plugin: RudderPluginDiscoverEntry,
  entries: readonly RudderPluginCatalogEntry[],
  resolvedTheme: "light" | "dark",
) {
  return themedPluginIconUrl(
    entries.find((entry) => entry.slug === plugin.catalogSlug)?.iconUrl,
    resolvedTheme,
  );
}

function InstalledPluginIcon({
  plugin,
  iconUrl,
  testId,
}: {
  plugin: RudderInstalledPlugin;
  iconUrl?: string | null;
  testId?: string;
}) {
  const appComponent = plugin.components.length === 1 && plugin.components[0]?.type === "app"
    ? plugin.components[0]
    : null;
  const identity = localAppIdentity(appComponent);
  if (identity) {
    return (
      <LocalAppIdentityIcon
        className="h-full w-full rounded-[inherit]"
        identity={identity}
        testId={testId}
      />
    );
  }
  return (
    <PluginIcon
      src={iconUrl}
      fallback={appComponent ? AppWindow : Blocks}
      fallbackClassName="h-4.5 w-4.5"
      className="h-full w-full p-1"
      testId={testId}
    />
  );
}

function PluginDetailDialog({
  plugin,
  iconUrl,
  open,
  onOpenChange,
  onAssignSkills,
  onConfigureMcp,
  onOpenMcpUi,
  openingMcpComponentId,
  onCustomizeSkill,
  onOpenApp,
  onTryChat,
  onRollback,
  onApplyUpdate,
  onToggle,
  onUninstall,
  error,
}: {
  plugin: RudderInstalledPlugin | null;
  iconUrl?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssignSkills: () => void;
  onConfigureMcp: (component: RudderPluginComponentLink) => void;
  onOpenMcpUi: (component: RudderPluginComponentLink) => void;
  openingMcpComponentId: string | null;
  onCustomizeSkill: (component: RudderPluginComponentLink) => void;
  onOpenApp: (component: RudderPluginComponentLink) => void;
  onTryChat: () => void;
  onRollback: () => void;
  onApplyUpdate: () => void;
  onToggle: () => void;
  onUninstall: () => void;
  error: string | null;
}) {
  if (!plugin) return null;
  const canTryInChat = plugin.enabled
    && plugin.setupState === "ready"
    && plugin.components.some((component) => (
      (component.type === "skill" || component.type === "mcp") && component.status === "ready"
    ));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3 pr-8">
            <PluginIconFrame className="h-10 w-10 bg-muted/45">
              <InstalledPluginIcon plugin={plugin} iconUrl={iconUrl} testId="installed-plugin-dialog-icon" />
            </PluginIconFrame>
            <div className="min-w-0">
              <DialogTitle>{plugin.displayName}</DialogTitle>
              <DialogDescription className="mt-1">{plugin.description ?? "No description provided."}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-y py-4 text-sm sm:grid-cols-4">
          <div><div className="text-xs text-muted-foreground">Status</div><div className="mt-0.5 font-medium">{stateLabel(plugin)}</div></div>
          <div className="min-w-0"><div className="text-xs text-muted-foreground">Version</div><div className="mt-0.5 break-all font-medium">{plugin.version}</div></div>
          <div><div className="text-xs text-muted-foreground">Publisher</div><div className="mt-0.5 truncate font-medium">{plugin.publisher ?? "Unknown"}</div></div>
          <div><div className="text-xs text-muted-foreground">Source</div><div className="mt-0.5 truncate font-medium">{plugin.sourceLabel}</div></div>
        </div>

        <section>
          <h3 className="text-sm font-semibold">Included capabilities</h3>
          <div className="mt-2 divide-y rounded-md border">
            {plugin.components.map((component) => {
              const Icon = componentIcon(component.type);
              return (
                <div key={component.id} className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{component.displayName}</div>
                    <div className="text-xs capitalize text-muted-foreground">{component.type} · {component.status.replace("_", " ")}</div>
                  </div>
                  {component.type === "mcp" && !component.targetId ? (
                    <Button size="sm" variant="outline" onClick={() => onConfigureMcp(component)}>Set up</Button>
                  ) : null}
                  {component.type === "mcp" && component.targetId && component.status !== "ready" ? (
                    <Button asChild size="sm" variant="outline">
                      <Link to="/organization/settings?view=integrations">
                        Continue setup<ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  ) : null}
                  {component.type === "mcp" && component.targetId && component.status === "ready" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={openingMcpComponentId === component.id}
                      onClick={() => onOpenMcpUi(component)}
                    >
                      {openingMcpComponentId === component.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      {openingMcpComponentId === component.id ? "Opening..." : "Open UI"}
                      {openingMcpComponentId === component.id ? null : <ExternalLink className="h-3.5 w-3.5" />}
                    </Button>
                  ) : null}
                  {component.type === "skill" && component.targetId ? (
                    <Button size="sm" variant="outline" onClick={() => onCustomizeSkill(component)}>Customize</Button>
                  ) : null}
                  {component.type === "app" && component.metadata.appKey ? (
                    <Button size="sm" variant="outline" onClick={() => onOpenApp(component)}>
                      Open App<ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <details className="rounded-md border px-3 py-2.5 text-xs">
          <summary className="cursor-pointer font-medium">Package provenance</summary>
          <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-2 text-muted-foreground">
            <dt>Digest</dt><dd className="break-all font-mono">{plugin.digest}</dd>
            <dt>Package</dt><dd className="break-all">{plugin.name}</dd>
          </dl>
        </details>

        {plugin.pendingUpdate ? (
          <section className="rounded-md border border-amber-600/30 bg-amber-500/5 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Local App update ready</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {plugin.version} → {plugin.pendingUpdate.version} · {plugin.pendingUpdate.digest.slice(0, 12)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">The current revision stays active until you apply this immutable App Builder revision.</p>
              </div>
              <Button size="sm" onClick={onApplyUpdate}>Apply update</Button>
            </div>
          </section>
        ) : null}

        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}

        <DialogFooter className="justify-between sm:justify-between">
          <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onUninstall}>Uninstall</Button>
          <div className="flex flex-wrap justify-end gap-2">
            {plugin.previousPackageId ? <Button variant="outline" onClick={onRollback}>Roll back</Button> : null}
            <Button variant="outline" onClick={onToggle}>{plugin.enabled ? "Disable" : "Enable"}</Button>
            {canTryInChat ? <Button onClick={onTryChat}><Bot className="h-4 w-4" />Try in Chat</Button> : null}
            {plugin.components.some((component) => component.type === "skill") ? (
              <Button onClick={onAssignSkills}><Bot className="h-4 w-4" />Add to Agent</Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportPreviewDialog({
  report,
  open,
  busy,
  onOpenChange,
  onInstall,
  skillConflictStrategy,
  onSkillConflictStrategyChange,
  accessExpansionConfirmed,
  onAccessExpansionConfirmedChange,
  error,
}: {
  report: RudderPluginImportReport | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
  skillConflictStrategy: "keep" | "replace" | "rename" | null;
  onSkillConflictStrategyChange: (strategy: "keep" | "replace" | "rename") => void;
  accessExpansionConfirmed: boolean;
  onAccessExpansionConfirmedChange: (confirmed: boolean) => void;
  error: string | null;
}) {
  if (!report) return null;
  const manifest = report.manifest ?? {};
  const displayName = typeof manifest.name === "string" ? manifest.name : "Plugin package";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{report.operation === "update" ? "Preview update" : "Preview"} {displayName}</DialogTitle>
          <DialogDescription>{report.sourceLabel} · {report.limits.fileCount} files · {Math.ceil(report.limits.totalBytes / 1024)} KB</DialogDescription>
        </DialogHeader>
        {report.errors.length > 0 ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {report.errors.map((error) => <div key={error}>{error}</div>)}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-emerald-600/25 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" />Package inspection complete. Nothing has been executed.
          </div>
        )}
        <div className="divide-y rounded-md border">
          {report.components.map((component) => {
            const Icon = component.type === "skill" ? FileCode2 : component.type === "mcp" ? Unplug : component.type === "app" ? AppWindow : CircleAlert;
            return (
              <div key={component.key} className="flex items-start gap-3 px-3 py-3">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{component.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{component.detail ?? component.type}</div>
                  {component.type === "mcp" ? (
                    <dl className="mt-2 grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <dt>Transport</dt><dd>{String(component.metadata.transport ?? "unknown").replace("streamable_http", "HTTP")}</dd>
                      <dt>Target</dt><dd className="break-all font-mono">{(() => {
                        const definition = component.metadata.definition;
                        if (!definition || typeof definition !== "object" || Array.isArray(definition)) return "Not declared";
                        const record = definition as Record<string, unknown>;
                        return typeof record.url === "string"
                          ? record.url
                          : [record.command, ...(Array.isArray(record.args) ? record.args : [])].filter((value) => typeof value === "string").join(" ") || "Not declared";
                      })()}</dd>
                      <dt>Access</dt><dd>Provider default; configured in Managed MCP setup</dd>
                      <dt>Side effects</dt><dd>Connected tools may read or change data in the declared external service</dd>
                      <dt>Results</dt><dd>Returned to the invoking Rudder Agent Run or Chat</dd>
                    </dl>
                  ) : null}
                </div>
                <span className={cn("text-xs", component.status === "unsupported" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{component.status.replace("_", " ")}</span>
              </div>
            );
          })}
        </div>
        {report.operation === "update" && report.capabilityDiff ? (
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Capability changes</h3>
              <span className={cn(
                "text-xs font-medium",
                report.capabilityDiff.accessExpansion
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-muted-foreground",
              )}>
                {report.capabilityDiff.accessExpansion ? "Access expansion" : "No access expansion"}
              </span>
            </div>
            {report.capabilityDiff.changes.length === 0 ? (
              <div className="rounded-md border px-3 py-2.5 text-sm text-muted-foreground">No capability or execution-surface changes.</div>
            ) : (
              <div className="divide-y rounded-md border">
                {report.capabilityDiff.changes.map((change) => (
                  <div key={`${change.kind}:${change.key}`} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{change.name}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{change.detail}</div>
                      </div>
                      <span className={cn(
                        "shrink-0 text-xs capitalize",
                        change.accessImpact === "expanded"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-muted-foreground",
                      )}>{change.kind} · {change.accessImpact}</span>
                    </div>
                    <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                      <div className="min-w-0 rounded-sm bg-muted/45 px-2.5 py-2">
                        <div className="mb-1 font-medium text-muted-foreground">Before</div>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-4">{change.before ? JSON.stringify(change.before, null, 2) : "Not present"}</pre>
                      </div>
                      <div className="min-w-0 rounded-sm bg-muted/45 px-2.5 py-2">
                        <div className="mb-1 font-medium text-muted-foreground">After</div>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-4">{change.after ? JSON.stringify(change.after, null, 2) : "Not present"}</pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
        {report.operation === "update" && report.capabilityDiff?.accessExpansion ? (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-amber-600/30 bg-amber-500/5 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={accessExpansionConfirmed}
              onChange={(event) => onAccessExpansionConfirmedChange(event.target.checked)}
            />
            <span>I understand and approve the expanded execution and external-access surface.</span>
          </label>
        ) : null}
        {report.skillConflicts.length > 0 ? (
          <section>
            <h3 className="text-sm font-semibold">Skill conflicts</h3>
            <p className="mt-1 text-xs text-muted-foreground">Choose one explicit policy for the {report.skillConflicts.length} existing Skill conflict{report.skillConflicts.length === 1 ? "" : "s"}.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Skill conflict strategy">
              {([
                ["keep", "Keep existing", "Skip the Plugin copy."],
                ["replace", "Replace", "Use the Plugin copy."],
                ["rename", "Install both", "Rename the Plugin copy."],
              ] as const).map(([value, label, detail]) => (
                <label key={value} className={cn("cursor-pointer rounded-md border px-3 py-2", skillConflictStrategy === value && "border-foreground bg-muted/45")}>
                  <input className="sr-only" type="radio" name="skill-conflict" value={value} checked={skillConflictStrategy === value} onChange={() => onSkillConflictStrategyChange(value)} />
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              {report.skillConflicts.map((conflict) => <div key={conflict.componentKey}>{conflict.skillName} conflicts with {conflict.existingSkillName}</div>)}
            </div>
          </section>
        ) : null}
        {report.warnings.length > 0 ? (
          <div className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
            {report.warnings.map((warning) => <div key={warning}>{warning}</div>)}
          </div>
        ) : null}
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}
        <DialogFooter showCloseButton>
          <Button disabled={busy || report.status !== "preview" || report.errors.length > 0 || (Boolean(report.capabilityDiff?.accessExpansion) && !accessExpansionConfirmed) || (report.skillConflicts.length > 0 && !skillConflictStrategy)} onClick={onInstall}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {report.operation === "update" ? "Apply update" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Plugins() {
  const { selectedOrganizationId } = useOrganization();
  const { resolvedTheme } = useTheme();
  const { setHeaderActions } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as HubTab | null;
  const requestedPluginId = searchParams.get("plugin");
  const explicitTab = requestedTab && ["plugins", "skills", "showcase"].includes(requestedTab) ? requestedTab : null;
  const [search, setSearch] = useState("");
  const [importReport, setImportReport] = useState<RudderPluginImportReport | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<RudderInstalledPlugin | null>(null);
  const [assigningPlugin, setAssigningPlugin] = useState<RudderInstalledPlugin | null>(null);
  const [uninstallingPlugin, setUninstallingPlugin] = useState<RudderInstalledPlugin | null>(null);
  const [mcpUiResource, setMcpUiResource] = useState<RudderMcpUiResourceContent | null>(null);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accessExpansionConfirmed, setAccessExpansionConfirmed] = useState(false);
  const [skillConflictStrategy, setSkillConflictStrategy] = useState<"keep" | "replace" | "rename" | null>(null);
  const [marketplaceDialogOpen, setMarketplaceDialogOpen] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceInput, setSourceInput] = useState("");
  const [marketplaceRepository, setMarketplaceRepository] = useState("");
  const [marketplaceCommit, setMarketplaceCommit] = useState("");
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const marketplaceInputRef = useRef<HTMLInputElement | null>(null);
  const skillFileInputRef = useRef<HTMLInputElement | null>(null);
  const skillFolderInputRef = useRef<HTMLInputElement | null>(null);
  const [skillUploadOpen, setSkillUploadOpen] = useState(searchParams.get("create") === "upload");
  const [uploadedSkills, setUploadedSkills] = useState<string[]>([]);

  const directoryQuery = useQuery({
    queryKey: queryKeys.rudderPlugins.directory(selectedOrganizationId ?? "__none__"),
    queryFn: () => rudderPluginsApi.directory(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.rudderPlugins.catalog(selectedOrganizationId ?? "__none__"),
    queryFn: () => rudderPluginsApi.catalog(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const skillsQuery = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId && assigningPlugin),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.directory(selectedOrganizationId ?? "__none__") });
    await queryClient.invalidateQueries({ queryKey: queryKeys.rudderPlugins.catalog(selectedOrganizationId ?? "__none__") });
    await queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__") });
  };
  const mutationError = (error: unknown) => setActionError(error instanceof Error ? error.message : "Plugin action failed.");
  const uploadSkillMutation = useMutation({
    mutationFn: async (files: readonly File[]) => organizationSkillsApi.upload(
      selectedOrganizationId!,
      { files: await selectedSkillFiles(files) },
    ),
    onMutate: () => {
      setActionError(null);
      setUploadedSkills([]);
    },
    onSuccess: async (result) => {
      setUploadedSkills(result.imported.map((skill) => skill.name));
      await refresh();
      setSearchParams({ tab: "skills" });
    },
    onError: mutationError,
  });
  const inspectMutation = useMutation({
    mutationFn: async (files: readonly File[]) => rudderPluginsApi.inspect(
      selectedOrganizationId!,
      files[0]?.webkitRelativePath.split("/")[0] || "Local folder",
      await selectedFolderFiles(files),
    ),
    onMutate: () => setActionError(null),
    onSuccess: (report) => {
      setAccessExpansionConfirmed(false);
      setSkillConflictStrategy(null);
      setImportReport(report);
    },
    onError: mutationError,
  });
  const installMutation = useMutation({
    mutationFn: () => rudderPluginsApi.install(
      selectedOrganizationId!,
      importReport!.id,
      accessExpansionConfirmed,
      skillConflictStrategy ?? undefined,
    ),
    onMutate: () => setActionError(null),
    onSuccess: async (plugin) => {
      setImportReport(null);
      setDetailPlugin(plugin);
      await refresh();
      setSearchParams({ tab: "plugins" });
    },
    onError: mutationError,
  });
  const archiveMutation = useMutation({
    mutationFn: async (file: File) => rudderPluginsApi.inspectArchive(selectedOrganizationId!, {
      sourceLabel: file.name,
      filename: file.name,
      content: await fileToBase64(file),
      encoding: "base64",
    }),
    onMutate: () => setActionError(null),
    onSuccess: (report) => {
      setAccessExpansionConfirmed(false);
      setSkillConflictStrategy(null);
      setImportReport(report);
    },
    onError: mutationError,
  });
  const marketplaceMutation = useMutation({
    mutationFn: async (input: { files?: readonly File[]; github?: { repository: string; commit: string } }) =>
      rudderPluginsApi.configureMarketplace(selectedOrganizationId!, input.files ? {
        sourceLabel: input.files[0]?.webkitRelativePath.split("/")[0] || "Local marketplace",
        files: await selectedFolderFiles(input.files),
      } : {
        sourceLabel: new URL(input.github!.repository).pathname.split("/").filter(Boolean).slice(-1)[0] || "GitHub marketplace",
        github: input.github,
      }),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      setMarketplaceDialogOpen(false);
      setMarketplaceRepository("");
      setMarketplaceCommit("");
      await refresh();
      setSearchParams({ tab: "plugins" });
    },
    onError: mutationError,
  });
  const sourcePreviewMutation = useMutation({
    mutationFn: () => rudderPluginsApi.previewSource(selectedOrganizationId!, sourceInput),
    onMutate: () => setActionError(null),
    onSuccess: (detail) => {
      queryClient.setQueryData(
        queryKeys.rudderPlugins.previewDetail(selectedOrganizationId!, detail.previewId!),
        detail,
      );
      setSourceDialogOpen(false);
      setSourceInput("");
      navigate(`/hub/plugins/${encodeURIComponent(detail.slug)}?preview=${encodeURIComponent(detail.previewId!)}`);
    },
    onError: mutationError,
  });
  const localAppUpdateMutation = useMutation({
    mutationFn: (plugin: RudderInstalledPlugin) => rudderPluginsApi.applyLocalAppUpdate(selectedOrganizationId!, plugin.id),
    onMutate: () => setActionError(null),
    onSuccess: async (plugin) => { setDetailPlugin(plugin); await refresh(); },
    onError: mutationError,
  });
  const toggleMutation = useMutation({
    mutationFn: async (plugin: RudderInstalledPlugin) => {
      if (plugin.enabled) {
        const app = plugin.components.find((component) => component.type === "app");
        const bindingId = typeof app?.metadata.localBindingId === "string" ? app.metadata.localBindingId : null;
        const localApps = readDesktopShell()?.localApps;
        if (bindingId && localApps?.supported) {
          const status = await localApps.status(bindingId);
          if (["running", "starting", "stopping"].includes(status.status)) await localApps.stop(bindingId);
        }
      }
      return rudderPluginsApi.setEnabled(selectedOrganizationId!, plugin.id, !plugin.enabled);
    },
    onMutate: () => setActionError(null),
    onSuccess: async (plugin) => { setDetailPlugin(plugin); await refresh(); },
    onError: mutationError,
  });
  const uninstallMutation = useMutation({
    mutationFn: (plugin: RudderInstalledPlugin) => rudderPluginsApi.uninstall(selectedOrganizationId!, plugin.id),
    onMutate: () => setActionError(null),
    onSuccess: async () => { setDetailPlugin(null); await refresh(); },
    onError: mutationError,
  });
  const rollbackMutation = useMutation({
    mutationFn: (plugin: RudderInstalledPlugin) => rudderPluginsApi.rollback(selectedOrganizationId!, plugin.id),
    onMutate: () => setActionError(null),
    onSuccess: async (plugin) => { setDetailPlugin(plugin); await refresh(); },
    onError: mutationError,
  });
  const mcpMutation = useMutation({
    mutationFn: ({ plugin, component }: { plugin: RudderInstalledPlugin; component: RudderPluginComponentLink }) =>
      rudderPluginsApi.configureMcp(selectedOrganizationId!, plugin.id, component.id),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      await refresh();
      if (detailPlugin) setDetailPlugin(await rudderPluginsApi.get(selectedOrganizationId!, detailPlugin.id));
    },
    onError: mutationError,
  });
  const mcpUiMutation = useMutation({
    mutationFn: async ({ plugin, component }: { plugin: RudderInstalledPlugin; component: RudderPluginComponentLink }) => {
      const resources = await rudderPluginsApi.listMcpUiResources(selectedOrganizationId!, plugin.id, component.id);
      if (resources.length === 0) throw new Error("This MCP server does not expose a supported HTML UI resource.");
      return rudderPluginsApi.readMcpUiResource(selectedOrganizationId!, plugin.id, component.id, resources[0]!.uri);
    },
    onMutate: () => setActionError(null),
    onSuccess: setMcpUiResource,
    onError: mutationError,
  });
  const customizeMutation = useMutation({
    mutationFn: ({ plugin, component }: { plugin: RudderInstalledPlugin; component: RudderPluginComponentLink }) =>
      rudderPluginsApi.customizeSkill(selectedOrganizationId!, plugin.id, component.id),
    onMutate: () => setActionError(null),
    onSuccess: async () => { await refresh(); },
    onError: mutationError,
  });
  const assignMutation = useMutation({
    mutationFn: () => rudderPluginsApi.configureSkills(selectedOrganizationId!, assigningPlugin!.id, selectedAgentIds),
    onMutate: () => setActionError(null),
    onSuccess: async () => { setAssigningPlugin(null); setSelectedAgentIds([]); await refresh(); },
    onError: mutationError,
  });

  const normalizedSearch = search.trim().toLowerCase();
  const installed = useMemo(() => (directoryQuery.data?.installed ?? []).filter((plugin) =>
    !normalizedSearch || `${plugin.displayName} ${plugin.description ?? ""} ${plugin.publisher ?? ""}`.toLowerCase().includes(normalizedSearch)), [directoryQuery.data?.installed, normalizedSearch]);
  const localApps = useMemo(() => (directoryQuery.data?.localApps ?? []).filter((app) =>
    !normalizedSearch || app.name.toLowerCase().includes(normalizedSearch)), [directoryQuery.data?.localApps, normalizedSearch]);
  const discover = useMemo(() => (catalogQuery.data?.entries ?? []).filter((plugin) =>
    !normalizedSearch || `${plugin.displayName} ${plugin.shortDescription} ${plugin.developer} ${plugin.category}`.toLowerCase().includes(normalizedSearch)), [catalogQuery.data?.entries, normalizedSearch]);
  const configuredDiscover = useMemo(() => (directoryQuery.data?.discover ?? []).filter((plugin) =>
    !normalizedSearch || `${plugin.displayName} ${plugin.description ?? ""} ${plugin.publisher ?? ""}`.toLowerCase().includes(normalizedSearch)), [directoryQuery.data?.discover, normalizedSearch]);
  const skills = useMemo(() => (skillsQuery.data ?? []).filter((skill) =>
    !normalizedSearch || `${skill.name} ${skill.description ?? ""} ${skill.sourceLabel ?? ""}`.toLowerCase().includes(normalizedSearch)), [skillsQuery.data, normalizedSearch]);
  const tab: HubTab = explicitTab ?? "plugins";
  const installedCatalogIcons = useMemo(() => new Map(
    (directoryQuery.data?.installed ?? []).map((plugin) => {
      const catalogEntry = (catalogQuery.data?.entries ?? []).find((entry) => entry.installedPluginId === plugin.id);
      return [plugin.id, themedPluginIconUrl(catalogEntry?.iconUrl, resolvedTheme)] as const;
    }),
  ), [catalogQuery.data?.entries, directoryQuery.data?.installed, resolvedTheme]);
  const createSkillInChat = useCallback(() => navigate(`/messenger/chat?prefill=${encodeURIComponent(
    "Use the skill-creator skill to help me create a reusable Skill. Start by asking what outcome this Skill should reliably produce, then build and validate it with me.",
  )}`), [navigate]);
  const openPluginDetail = (plugin: RudderInstalledPlugin) => {
    setActionError(null);
    setDetailPlugin(plugin);
    setSearchParams({ tab: "plugins", plugin: plugin.id });
  };
  const closePluginDetail = () => {
    setDetailPlugin(null);
    setSearchParams({ tab: "plugins" });
  };
  useEffect(() => {
    if (!requestedPluginId || detailPlugin?.id === requestedPluginId) return;
    const requestedPlugin = directoryQuery.data?.installed.find((plugin) => plugin.id === requestedPluginId);
    if (requestedPlugin) setDetailPlugin(requestedPlugin);
  }, [detailPlugin?.id, directoryQuery.data?.installed, requestedPluginId]);

  useEffect(() => {
    if (!selectedOrganizationId) {
      setHeaderActions(null);
      return;
    }

    setHeaderActions(
      <>
        <div className="relative hidden w-[min(17rem,28vw)] md:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === "plugins" ? "Search plugins" : tab === "skills" ? "Search skills" : "Search showcase"}
            aria-label="Search Hub"
            data-testid="hub-header-search"
            className="h-8 border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] pl-8 text-sm"
          />
        </div>
        {tab === "plugins" ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="Import"
                    disabled={inspectMutation.isPending || archiveMutation.isPending || marketplaceMutation.isPending}
                  >
                    {inspectMutation.isPending || archiveMutation.isPending || marketplaceMutation.isPending
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <PackageOpen className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">Import</span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Import Plugin</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => folderInputRef.current?.click()}>
                <FolderOpen className="h-4 w-4" />Plugin folder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => archiveInputRef.current?.click()}>
                <Download className="h-4 w-4" />Plugin ZIP
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => marketplaceInputRef.current?.click()}>
                <PackageOpen className="h-4 w-4" />Local marketplace
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMarketplaceDialogOpen(true)}>
                <Box className="h-4 w-4" />Pinned GitHub marketplace
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setActionError(null); setSourceDialogOpen(true); }}>
                <Download className="h-4 w-4" />GitHub Skills source
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {tab === "skills" ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" aria-label="Create Skill"><Plus className="h-3.5 w-3.5" /><span className="hidden sm:inline">Create Skill</span></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Create Skill</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={createSkillInChat}>
                <MessageCircle className="h-4 w-4" />Create via Chat
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setActionError(null); setUploadedSkills([]); setSkillUploadOpen(true); }}>
                <Upload className="h-4 w-4" />Upload Skill
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </>,
    );
  }, [
    archiveMutation.isPending,
    createSkillInChat,
    inspectMutation.isPending,
    marketplaceMutation.isPending,
    search,
    selectedOrganizationId,
    setHeaderActions,
    tab,
  ]);

  useEffect(() => () => setHeaderActions(null), [setHeaderActions]);

  if (!selectedOrganizationId) return <div className="p-6 text-sm text-muted-foreground">Select an Organization.</div>;

  return (
    <div data-testid="plugin-hub" className="flex h-full min-h-0 flex-col bg-transparent">
      <div data-testid="plugin-hub-header" className="shrink-0 border-b border-[color:var(--border-soft)] bg-transparent px-4 py-2.5 md:px-6">
        <div className="relative mb-2.5 md:hidden">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === "plugins" ? "Search plugins" : tab === "skills" ? "Search skills" : "Search showcase"}
            aria-label="Search Hub"
            className="h-8 border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] pl-8 text-sm"
          />
        </div>
        <nav className="flex gap-1" aria-label="Hub views">
          {(["plugins", "skills", "showcase"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setSearchParams({ tab: item })}
              className={cn(
                "rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                tab === item
                  ? "bg-[color:var(--surface-active)] text-foreground"
                  : "text-muted-foreground hover:bg-[color:var(--surface-inset)] hover:text-foreground",
              )}
            >
              {item}
            </button>
          ))}
        </nav>
      </div>

      <main className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
        {tab === "plugins" && directoryQuery.error ? <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{directoryQuery.error.message}</div> : null}
        {tab === "plugins" && catalogQuery.error ? <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{catalogQuery.error.message}</div> : null}
        {tab === "skills" && skillsQuery.error ? <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{skillsQuery.error.message}</div> : null}
        {actionError && !detailPlugin && !importReport && !assigningPlugin ? <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{actionError}</div> : null}
        {(tab === "plugins" ? directoryQuery.isLoading : tab === "skills" ? skillsQuery.isLoading : false) ? <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : null}

        {tab === "plugins" && !directoryQuery.isLoading ? (
          <div className="mx-auto max-w-5xl">
            <section>
              <div className="mb-3 flex items-end justify-between gap-3">
                <div><h2 className="text-sm font-semibold">Your plugins</h2><p className="mt-0.5 text-xs text-muted-foreground">Installed packages and private Apps available to this Organization.</p></div>
                <span className="text-xs text-muted-foreground">{installed.length + localApps.length}</span>
              </div>
              {installed.length + localApps.length === 0 ? (
                <div data-testid="hub-empty-installed" className="flex flex-col gap-3 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-4 py-4 sm:flex-row sm:items-center">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)]"><Blocks className="h-4 w-4 text-muted-foreground" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">No plugins yet</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Import a Codex-compatible Plugin or build a private App.</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={() => folderInputRef.current?.click()}><PackageOpen className="h-3.5 w-3.5" />Import Plugin</Button>
                    <Button size="sm" variant="ghost" onClick={() => navigate("/apps")}><Wrench className="h-3.5 w-3.5" />Build App</Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {installed.map((plugin) => (
                    <button key={plugin.id} type="button" className="group flex min-h-[104px] items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/35" onClick={() => {
                      const app = plugin.components.length === 1 && plugin.components[0]?.type === "app" ? plugin.components[0] : null;
                      const appKey = typeof app?.metadata.appKey === "string" ? app.metadata.appKey : null;
                      if (appKey && !plugin.pendingUpdate) navigate(appRoute(appKey));
                      else openPluginDetail(plugin);
                    }}>
                      <PluginIconFrame className="h-9 w-9">
                        <InstalledPluginIcon plugin={plugin} iconUrl={installedCatalogIcons.get(plugin.id)} testId="installed-plugin-icon" />
                      </PluginIconFrame>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{plugin.displayName}</span><span className={cn("text-[11px]", plugin.enabled && plugin.setupState === "ready" && !plugin.pendingUpdate ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>{plugin.pendingUpdate ? "Update available" : stateLabel(plugin)}</span></div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{plugin.description ?? "No description provided."}</p>
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                          {plugin.components.slice(0, 3).map((component) => <span key={component.id} className="capitalize">{component.type}</span>)}
                          <span className="ml-auto">v{plugin.version}</span>
                        </div>
                      </div>
                      {plugin.components.length === 1 && plugin.components[0]?.type === "app" && plugin.components[0]?.metadata.appKey ? <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
                    </button>
                  ))}
                  {localApps.map((app) => (
                    <button key={app.id} type="button" disabled={!app.appKey} onClick={() => app.appKey && navigate(appRoute(app.appKey))} className="group flex min-h-[104px] items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-55">
                      <PluginIconFrame className="h-9 w-9">
                        <AppWindow className="h-4.5 w-4.5" aria-hidden />
                      </PluginIconFrame>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{app.name}</span><span className={cn("text-[11px]", app.appKey ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>{app.appKey ? "Ready" : app.buildStatus.replaceAll("_", " ")}</span></div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">Private interactive capability built in Rudder.</p>
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><span>Local App</span><span className="ml-auto">Rudder</span></div>
                      </div>
                      {app.appKey ? <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" /> : <Wrench className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="mt-8 border-t pt-6">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div><h2 className="text-sm font-semibold">Discover plugins</h2><p className="mt-0.5 text-xs text-muted-foreground">Curated capability bundles. Open a Plugin to preview everything included.</p></div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {catalogQuery.data?.freshness === "stale" ? (
                    <span
                      role="status"
                      data-testid="plugin-catalog-stale"
                      className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                    >
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      Catalog unavailable. Showing cached catalog.
                    </span>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => setSourceDialogOpen(true)}><Download className="h-4 w-4" />URL Import</Button>
                </div>
              </div>
              {catalogQuery.isLoading ? (
                <div className="flex h-32 items-center justify-center border-y border-[color:var(--border-soft)]"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : discover.length === 0 ? (
                <div data-testid="hub-empty-marketplace" className="flex items-start gap-3 rounded-md border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,var(--surface-page))] px-4 py-3.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[color:var(--surface-inset)]"><Box className="h-3.5 w-3.5 text-muted-foreground" /></div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">No plugins match this search</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Clear the search or preview a compatible public GitHub source.</p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {discover.map((plugin) => (
                    <button key={plugin.slug} type="button" className="group flex min-h-[112px] items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/35" onClick={() => navigate(`/hub/plugins/${encodeURIComponent(plugin.slug)}`)}>
                      <PluginIconFrame className="h-10 w-10">
                        <PluginIcon
                          src={themedPluginIconUrl(plugin.iconUrl, resolvedTheme)}
                          className="h-full w-full p-1"
                          fallbackClassName="h-4.5 w-4.5"
                          testId="catalog-plugin-icon"
                        />
                      </PluginIconFrame>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-semibold">{plugin.displayName}</span>{plugin.updateAvailable ? <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">Update available</span> : plugin.installedPluginId ? <span className="text-[11px] text-emerald-700 dark:text-emerald-400">Installed</span> : null}</div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{plugin.shortDescription}</p>
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{plugin.developer}</span><span>{plugin.category}</span><span className="ml-auto">{plugin.sourceKind === "skills_add" ? "Skills source" : "Codex Plugin"}</span></div>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </button>
                  ))}
                </div>
              )}
            </section>

            {configuredDiscover.length > 0 ? (
              <section className="mt-8 border-t pt-6">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div><h2 className="text-sm font-semibold">Configured sources</h2><p className="mt-0.5 text-xs text-muted-foreground">Plugins from local and pinned GitHub marketplaces.</p></div>
                  <span className="text-xs text-muted-foreground">{configuredDiscover.length}</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {configuredDiscover.map((plugin) => (
                    <button
                      key={plugin.reportId}
                      type="button"
                      className="group flex min-h-[104px] items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/35"
                      onClick={async () => {
                        setActionError(null);
                        try {
                          const report = await rudderPluginsApi.getImportReport(selectedOrganizationId, plugin.reportId);
                          setAccessExpansionConfirmed(false);
                          setSkillConflictStrategy(null);
                          setImportReport(report);
                        } catch (error) {
                          mutationError(error);
                        }
                      }}
                    >
                      <PluginIconFrame className="h-9 w-9">
                        <PluginIcon
                          src={configuredPluginIconUrl(plugin, catalogQuery.data?.entries ?? [], resolvedTheme)}
                          className="h-full w-full p-1"
                          fallbackClassName="h-4.5 w-4.5"
                          testId="configured-plugin-icon"
                        />
                      </PluginIconFrame>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{plugin.displayName}</span><span className="text-[11px] text-muted-foreground">{plugin.category ?? "Plugin"}</span></div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{plugin.description ?? "No description provided."}</p>
                        <div className="mt-2 text-[11px] text-muted-foreground">{plugin.sourceType === "git" ? "Pinned GitHub" : "Local marketplace"} · v{plugin.version}</div>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === "skills" && !skillsQuery.isLoading ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div><h2 className="text-sm font-semibold">Organization skills</h2><p className="mt-0.5 text-xs text-muted-foreground">Reusable instructions that can be enabled for one or more Agents.</p></div>
              <span className="text-xs text-muted-foreground">{skills.length}</span>
            </div>
            {skills.length === 0 ? (
              <div data-testid="hub-empty-skills" className="flex flex-col gap-3 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-4 py-4 sm:flex-row sm:items-center">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)]"><BookOpen className="h-4 w-4 text-muted-foreground" /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">No skills match this view</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Create one with Chat or upload an existing Skill package.</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={createSkillInChat}><MessageCircle className="h-3.5 w-3.5" />Create via Chat</Button>
                  <Button size="sm" variant="ghost" onClick={() => setSkillUploadOpen(true)}><Upload className="h-3.5 w-3.5" />Upload Skill</Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {skills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className="group flex min-h-[104px] items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/35"
                    onClick={() => navigate(buildLibrarySkillHref(skill.id))}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/40"><FileCode2 className="h-4.5 w-4.5" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{skill.name}</span><span className="text-[11px] capitalize text-muted-foreground">{skill.sourceBadge}</span></div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description ?? "No description provided."}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{skill.attachedAgentCount} {skill.attachedAgentCount === 1 ? "Agent" : "Agents"}</span><span>{skill.fileInventory.length} files</span><span className="ml-auto">{skill.compatibility}</span></div>
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {tab === "showcase" ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-4"><h2 className="text-sm font-semibold">Showcase</h2><p className="mt-0.5 text-xs text-muted-foreground">Starting points from effective multi-Agent workflows.</p></div>
            <div className="divide-y border-y">
              {[
                { icon: Sparkles, title: "Research brief", copy: "Combine a research Plugin with a verification Agent before the result returns to the team.", action: "Explore plugins", run: () => setSearchParams({ tab: "plugins" }) },
                { icon: BookOpen, title: "Team writing standard", copy: "Turn an existing playbook into a Skill that every writing Agent can share.", action: "Create Skill", run: createSkillInChat },
                { icon: AppWindow, title: "Internal operations console", copy: "Build a private App when the work needs an interactive surface, records, and repeated actions.", action: "Build App", run: () => navigate("/apps") },
              ].filter((item) => !normalizedSearch || `${item.title} ${item.copy}`.toLowerCase().includes(normalizedSearch)).map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex items-center gap-4 py-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40"><Icon className="h-4.5 w-4.5" /></div>
                    <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{item.title}</h3><p className="mt-0.5 text-sm text-muted-foreground">{item.copy}</p></div>
                    <Button variant="outline" size="sm" onClick={item.run}>{item.action}<ChevronRight className="h-3.5 w-3.5" /></Button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </main>

      <input
        ref={(node) => { folderInputRef.current = node; node?.setAttribute("webkitdirectory", ""); }}
        type="file"
        multiple
        className="hidden"
        data-testid="plugin-folder-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length) inspectMutation.mutate(files);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={archiveInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        data-testid="plugin-archive-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) archiveMutation.mutate(file);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={(node) => { marketplaceInputRef.current = node; node?.setAttribute("webkitdirectory", ""); }}
        type="file"
        multiple
        className="hidden"
        data-testid="plugin-marketplace-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length) marketplaceMutation.mutate({ files });
          event.currentTarget.value = "";
        }}
      />

      <input
        ref={skillFileInputRef}
        type="file"
        multiple
        accept=".skill,.md,text/markdown,text/plain"
        className="hidden"
        data-testid="skill-file-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length) uploadSkillMutation.mutate(files);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={(node) => { skillFolderInputRef.current = node; node?.setAttribute("webkitdirectory", ""); }}
        type="file"
        multiple
        className="hidden"
        data-testid="skill-folder-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length) uploadSkillMutation.mutate(files);
          event.currentTarget.value = "";
        }}
      />
      <Dialog open={skillUploadOpen} onOpenChange={(open) => { setSkillUploadOpen(open); if (!open) { setActionError(null); setUploadedSkills([]); setSearchParams({ tab: "skills" }); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Skill</DialogTitle>
            <DialogDescription>Choose a Skill file or a folder containing SKILL.md. Rudder validates the package before adding it to the Organization.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" className="flex min-h-28 flex-col items-start rounded-md border p-4 text-left transition-colors hover:bg-muted/35" onClick={() => skillFileInputRef.current?.click()} disabled={uploadSkillMutation.isPending}>
              <FileCode2 className="h-5 w-5 text-muted-foreground" />
              <span className="mt-3 text-sm font-semibold">Choose files</span>
              <span className="mt-1 text-xs text-muted-foreground">A .skill file, SKILL.md, and optional supporting files.</span>
            </button>
            <button type="button" className="flex min-h-28 flex-col items-start rounded-md border p-4 text-left transition-colors hover:bg-muted/35" onClick={() => skillFolderInputRef.current?.click()} disabled={uploadSkillMutation.isPending}>
              <FolderOpen className="h-5 w-5 text-muted-foreground" />
              <span className="mt-3 text-sm font-semibold">Choose folder</span>
              <span className="mt-1 text-xs text-muted-foreground">Upload a complete Skill directory.</span>
            </button>
          </div>
          {uploadSkillMutation.isPending ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Validating and importing Skill...</div> : null}
          {uploadedSkills.length > 0 ? <div className="rounded-md border border-emerald-600/25 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">Added {uploadedSkills.join(", ")}.</div> : null}
          {actionError ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{actionError}</div> : null}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <ImportPreviewDialog
        report={importReport}
        open={Boolean(importReport)}
        busy={installMutation.isPending}
        error={actionError}
        accessExpansionConfirmed={accessExpansionConfirmed}
        onAccessExpansionConfirmedChange={setAccessExpansionConfirmed}
        skillConflictStrategy={skillConflictStrategy}
        onSkillConflictStrategyChange={setSkillConflictStrategy}
        onOpenChange={(open) => !open && setImportReport(null)}
        onInstall={() => installMutation.mutate()}
      />
      <PluginDetailDialog
        plugin={detailPlugin}
        iconUrl={detailPlugin ? installedCatalogIcons.get(detailPlugin.id) : null}
        open={Boolean(detailPlugin) && !mcpUiResource}
        onOpenChange={(open) => !open && closePluginDetail()}
        onAssignSkills={() => {
          setActionError(null);
          setAssigningPlugin(detailPlugin);
          setSelectedAgentIds(detailPlugin?.components
            .filter((component) => component.type === "skill")
            .flatMap((component) => Array.isArray(component.metadata.enabledAgentIds)
              ? component.metadata.enabledAgentIds.filter((value): value is string => typeof value === "string")
              : [])
            .filter((id, index, values) => values.indexOf(id) === index) ?? []);
        }}
        onConfigureMcp={(component) => detailPlugin && mcpMutation.mutate({ plugin: detailPlugin, component })}
        onOpenMcpUi={(component) => detailPlugin && mcpUiMutation.mutate({ plugin: detailPlugin, component })}
        openingMcpComponentId={mcpUiMutation.isPending ? mcpUiMutation.variables?.component.id ?? null : null}
        onCustomizeSkill={(component) => detailPlugin && customizeMutation.mutate({ plugin: detailPlugin, component })}
        onOpenApp={(component) => {
          const appKey = typeof component.metadata.appKey === "string" ? component.metadata.appKey : null;
          if (appKey) navigate(appRoute(appKey));
        }}
        onTryChat={() => {
          if (!detailPlugin) return;
          const agentId = detailPlugin.components
            .filter((component) => component.type === "skill")
            .flatMap((component) => Array.isArray(component.metadata.enabledAgentIds) ? component.metadata.enabledAgentIds : [])
            .find((value): value is string => typeof value === "string");
          const params = new URLSearchParams({ prefill: `[${detailPlugin.displayName}](plugin://${detailPlugin.id}) ` });
          if (agentId) params.set("agentId", agentId);
          navigate(`/messenger/chat?${params.toString()}`);
        }}
        onRollback={() => detailPlugin && rollbackMutation.mutate(detailPlugin)}
        onApplyUpdate={() => detailPlugin && localAppUpdateMutation.mutate(detailPlugin)}
        onToggle={() => detailPlugin && toggleMutation.mutate(detailPlugin)}
        onUninstall={() => detailPlugin && setUninstallingPlugin(detailPlugin)}
        error={actionError}
      />
      <Dialog open={marketplaceDialogOpen} onOpenChange={setMarketplaceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add pinned GitHub marketplace</DialogTitle>
            <DialogDescription>Rudder fetches one immutable GitHub archive and makes its Plugins available to preview. Nothing installs automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Repository URL</span>
              <Input value={marketplaceRepository} onChange={(event) => setMarketplaceRepository(event.target.value)} placeholder="https://github.com/owner/repository" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Full commit SHA</span>
              <Input value={marketplaceCommit} onChange={(event) => setMarketplaceCommit(event.target.value)} placeholder="40 hexadecimal characters" className="font-mono" />
            </label>
            {actionError ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{actionError}</div> : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={marketplaceMutation.isPending || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(marketplaceRepository) || !/^[0-9a-f]{40}$/i.test(marketplaceCommit)}
              onClick={() => marketplaceMutation.mutate({ github: { repository: marketplaceRepository, commit: marketplaceCommit } })}
            >
              {marketplaceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Add marketplace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={sourceDialogOpen} onOpenChange={(open) => { setSourceDialogOpen(open); if (!open) setActionError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preview GitHub Skills source</DialogTitle>
            <DialogDescription>Enter a public source accepted by the skills CLI. Rudder discovers it without running npx or package scripts.</DialogDescription>
          </DialogHeader>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Source</span>
            <Input value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} placeholder="coreyhaines31/marketingskills" autoFocus />
          </label>
          {actionError ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{actionError}</div> : null}
          <DialogFooter showCloseButton>
            <Button disabled={sourcePreviewMutation.isPending || sourceInput.trim().length < 3} onClick={() => sourcePreviewMutation.mutate()}>
              {sourcePreviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {sourcePreviewMutation.isPending ? "Creating Preview..." : "Preview"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(uninstallingPlugin)} onOpenChange={(open) => !open && setUninstallingPlugin(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {uninstallingPlugin?.displayName}?</DialogTitle>
            <DialogDescription>
              Plugin-managed Skills will be removed. Independent customized Skills, MCP connections, and Local App source and data are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              disabled={uninstallMutation.isPending}
              onClick={() => uninstallingPlugin && uninstallMutation.mutate(uninstallingPlugin, { onSuccess: () => setUninstallingPlugin(null) })}
            >
              {uninstallMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(mcpUiResource)} onOpenChange={(open) => !open && setMcpUiResource(null)}>
        <DialogContent className="h-[min(760px,calc(100vh-2rem))] max-w-5xl overflow-hidden p-0">
          <DialogHeader className="border-b px-4 py-3 pr-12">
            <DialogTitle>{mcpUiResource?.name}</DialogTitle>
            <DialogDescription>{mcpUiResource?.description ?? "MCP UI resource"}</DialogDescription>
          </DialogHeader>
          {mcpUiResource ? (
            <iframe
              title={mcpUiResource.name}
              sandbox="allow-scripts"
              {...({ csp: MCP_UI_CSP, credentialless: "" } as Record<string, string>)}
              referrerPolicy="no-referrer"
              className="h-full min-h-0 w-full border-0 bg-white"
              srcDoc={sandboxedMcpHtml(mcpUiResource.html)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(assigningPlugin)} onOpenChange={(open) => !open && setAssigningPlugin(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Skills to Agents</DialogTitle><DialogDescription>{assigningPlugin?.displayName}</DialogDescription></DialogHeader>
          <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {(agentsQuery.data ?? []).map((agent: Agent) => (
              <label key={agent.id} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/35">
                <input type="checkbox" checked={selectedAgentIds.includes(agent.id)} onChange={(event) => setSelectedAgentIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))} />
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{agent.name}</span>
              </label>
            ))}
          </div>
          {actionError ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{actionError}</div> : null}
          <DialogFooter showCloseButton><Button disabled={assignMutation.isPending} onClick={() => assignMutation.mutate()}>{assignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
