import type {
  OrganizationWorkspaceWebPreviewSession,
  WorkspaceWebPreviewNetworkMode,
} from "@rudderhq/shared";
import { ChevronDown, Code2, Globe2, Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { organizationsApi } from "../api/orgs";
import { cn } from "../lib/utils";
import { buildWorkspaceHtmlStaticFallbackSrcDoc } from "../lib/workspace-html-preview";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export type WorkspaceHtmlViewMode = "preview" | "source";

interface WorkspaceHtmlPreviewProps {
  organizationId: string;
  filePath: string;
  htmlContent?: string;
  testIdPrefix?: string;
  className?: string;
  viewMode?: WorkspaceHtmlViewMode;
  onViewModeChange?: (mode: WorkspaceHtmlViewMode) => void;
  networkMode?: WorkspaceWebPreviewNetworkMode;
  onNetworkModeChange?: (mode: WorkspaceWebPreviewNetworkMode) => void;
  openAction?: ReactNode;
}

interface WorkspaceHtmlPreviewToolbarProps {
  viewMode: WorkspaceHtmlViewMode;
  onViewModeChange: (mode: WorkspaceHtmlViewMode) => void;
  networkMode?: WorkspaceWebPreviewNetworkMode;
  onNetworkModeChange?: (mode: WorkspaceWebPreviewNetworkMode) => void;
  networkUnavailable?: boolean;
  onReload?: () => void;
  openAction?: ReactNode;
  testIdPrefix?: string;
  className?: string;
}

type PreviewState =
  | { status: "loading"; session: null; error: null }
  | { status: "ready"; session: OrganizationWorkspaceWebPreviewSession; error: null }
  | { status: "error"; session: null; error: string };

const inFlightPreviewSessions = new Map<string, Promise<OrganizationWorkspaceWebPreviewSession>>();
const DEFAULT_NETWORK_MODE: WorkspaceWebPreviewNetworkMode = "connected";

export function WorkspaceHtmlPreviewToolbar({
  viewMode,
  onViewModeChange,
  networkMode,
  onNetworkModeChange,
  networkUnavailable = false,
  onReload,
  openAction,
  testIdPrefix = "workspace-file",
  className,
}: WorkspaceHtmlPreviewToolbarProps) {
  const displayedNetworkMode = networkUnavailable ? "offline" : networkMode;
  const networkLabel = displayedNetworkMode === "connected" ? "Connected" : "Offline";
  const NetworkIcon = displayedNetworkMode === "connected" ? Wifi : WifiOff;
  const networkAriaLabel = networkUnavailable
    ? "Network mode: Offline. Connected preview is unavailable while using the static Offline fallback."
    : displayedNetworkMode === "connected"
      ? "Network mode: Connected. Runs artifact scripts and may send preview content to external HTTPS sites."
      : "Network mode: Offline. Local assets only; scripts and external requests are blocked.";

  return (
    <div
      className={cn(
        "workspace-html-preview-toolbar scrollbar-auto-hide flex min-h-10 shrink-0 items-center overflow-x-auto border-b border-border bg-[color:var(--surface-elevated)] px-1",
        className,
      )}
      data-testid={`${testIdPrefix}-html-preview-toolbar`}
    >
      <div className="workspace-html-preview-toolbar-controls ml-auto flex min-w-max items-center gap-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={viewMode}
          onValueChange={(value) => {
            if (value === "preview" || value === "source") onViewModeChange(value);
          }}
          aria-label="HTML file mode"
        >
          <ToggleGroupItem value="preview" className="px-2" aria-label="Preview" title="Preview">
            <Globe2 data-icon="inline-start" />
            <span className="workspace-html-preview-mode-label">Preview</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="source" className="px-2" aria-label="Source" title="Source">
            <Code2 data-icon="inline-start" />
            <span className="workspace-html-preview-mode-label">Source</span>
          </ToggleGroupItem>
        </ToggleGroup>

        {viewMode === "preview" && displayedNetworkMode && onNetworkModeChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={networkUnavailable}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-[6.5rem] justify-between"
                aria-label={networkAriaLabel}
                data-testid={`${testIdPrefix}-html-preview-network-menu`}
              >
                <NetworkIcon data-icon="inline-start" />
                <span>{networkLabel}</span>
                <ChevronDown className="workspace-html-preview-network-chevron" data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Network access</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={displayedNetworkMode}
                  onValueChange={(value) => {
                    if (value === "connected" || value === "offline") onNetworkModeChange(value);
                  }}
                >
                  <DropdownMenuRadioItem value="connected">
                    <Wifi />
                    <span className="flex min-w-0 flex-col">
                      <span>Connected</span>
                      <span className="text-xs font-normal text-muted-foreground">Run scripts and allow HTTPS resources</span>
                    </span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="offline">
                    <WifiOff />
                    <span className="flex min-w-0 flex-col">
                      <span>Offline</span>
                      <span className="text-xs font-normal text-muted-foreground">Local assets only; block scripts</span>
                    </span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {openAction ? <div className="workspace-html-preview-open-action shrink-0">{openAction}</div> : null}

        {viewMode === "preview" && onReload ? (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reload website preview"
                  onClick={onReload}
                >
                  <RefreshCw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reload preview</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}

function createPreviewSession(
  organizationId: string,
  filePath: string,
  networkMode: WorkspaceWebPreviewNetworkMode,
  htmlContent: string | undefined,
  reloadVersion: number,
) {
  const requestKey = [organizationId, filePath, networkMode, reloadVersion, htmlContent ?? ""].join("\0");
  const existing = inFlightPreviewSessions.get(requestKey);
  if (existing) return existing;

  const request = organizationsApi.createWorkspaceWebPreviewSession(organizationId, {
    entryPath: filePath,
    networkMode,
    ...(htmlContent === undefined ? {} : { htmlContent }),
  });
  inFlightPreviewSessions.set(requestKey, request);
  const removeCompletedRequest = () => {
    if (inFlightPreviewSessions.get(requestKey) === request) {
      inFlightPreviewSessions.delete(requestKey);
    }
  };
  void request.then(removeCompletedRequest, removeCompletedRequest);
  return request;
}

export function WorkspaceHtmlPreview({
  organizationId,
  filePath,
  htmlContent,
  testIdPrefix = "workspace-file",
  className,
  viewMode = "preview",
  onViewModeChange = () => {},
  networkMode: controlledNetworkMode,
  onNetworkModeChange,
  openAction,
}: WorkspaceHtmlPreviewProps) {
  const identity = `${organizationId}:${filePath}`;
  const [modeSelection, setModeSelection] = useState<{
    identity: string;
    mode: WorkspaceWebPreviewNetworkMode;
  }>({ identity, mode: DEFAULT_NETWORK_MODE });
  const [reloadVersion, setReloadVersion] = useState(0);
  const [previewState, setPreviewState] = useState<PreviewState>({
    status: "loading",
    session: null,
    error: null,
  });
  const uncontrolledNetworkMode = modeSelection.identity === identity
    ? modeSelection.mode
    : DEFAULT_NETWORK_MODE;
  const networkMode = controlledNetworkMode ?? uncontrolledNetworkMode;

  useEffect(() => {
    if (modeSelection.identity !== identity) {
      setModeSelection({ identity, mode: DEFAULT_NETWORK_MODE });
    }
  }, [identity, modeSelection.identity]);

  useEffect(() => {
    let cancelled = false;
    setPreviewState({ status: "loading", session: null, error: null });
    void createPreviewSession(
      organizationId,
      filePath,
      networkMode,
      htmlContent,
      reloadVersion,
    ).then((session) => {
      if (!cancelled) setPreviewState({ status: "ready", session, error: null });
    }).catch((error: unknown) => {
      if (!cancelled) {
        setPreviewState({
          status: "error",
          session: null,
          error: error instanceof Error ? error.message : "Website preview could not be started.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, htmlContent, networkMode, organizationId, reloadVersion]);

  const selectMode = (mode: WorkspaceWebPreviewNetworkMode) => {
    if (previewState.status === "error" || mode === networkMode) return;
    if (controlledNetworkMode === undefined) setModeSelection({ identity, mode });
    onNetworkModeChange?.(mode);
  };

  const retryPreview = () => {
    if (controlledNetworkMode === undefined) {
      setModeSelection({ identity, mode: DEFAULT_NETWORK_MODE });
    }
    onNetworkModeChange?.(DEFAULT_NETWORK_MODE);
    setReloadVersion((current) => current + 1);
  };

  return (
    <div
      className={cn("flex min-h-[420px] flex-1 flex-col bg-white", className)}
      data-testid={`${testIdPrefix}-html-preview-frame`}
    >
      <WorkspaceHtmlPreviewToolbar
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        networkMode={networkMode}
        onNetworkModeChange={selectMode}
        networkUnavailable={previewState.status === "error"}
        onReload={() => setReloadVersion((current) => current + 1)}
        openAction={openAction}
        testIdPrefix={testIdPrefix}
      />

      {previewState.status === "loading" ? (
        <div
          className="flex min-h-[384px] flex-1 items-center justify-center text-muted-foreground"
          data-testid={`${testIdPrefix}-html-preview-loading`}
          role="status"
        >
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="sr-only">Loading website preview</span>
        </div>
      ) : previewState.status === "error" ? (
        <div
          className="flex min-h-[384px] flex-1 flex-col"
          data-testid={`${testIdPrefix}-html-preview-error`}
        >
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2"
            role="alert"
          >
            <p className="min-w-0 text-xs leading-5 text-muted-foreground">
              Multi-file preview is unavailable. Showing a static Offline document. {previewState.error}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retryPreview}>
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </div>
          <iframe
            data-testid={`${testIdPrefix}-html-preview`}
            data-preview-fallback="static"
            title={filePath || "Library static HTML preview"}
            srcDoc={buildWorkspaceHtmlStaticFallbackSrcDoc(htmlContent ?? "")}
            sandbox=""
            referrerPolicy="no-referrer"
            className="block min-h-[336px] w-full flex-1 border-0 bg-white"
          />
        </div>
      ) : (
        <iframe
          key={previewState.session.previewUrl}
          data-testid={`${testIdPrefix}-html-preview`}
          title={filePath || "Library website preview"}
          src={previewState.session.previewUrl}
          sandbox={networkMode === "connected" ? "allow-scripts" : ""}
          referrerPolicy="no-referrer"
          className="block min-h-[384px] w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
