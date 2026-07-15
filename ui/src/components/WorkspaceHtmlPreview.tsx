import type {
  OrganizationWorkspaceWebPreviewSession,
  WorkspaceWebPreviewNetworkMode,
} from "@rudderhq/shared";
import { Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { organizationsApi } from "../api/orgs";
import { buildWorkspaceHtmlStaticFallbackSrcDoc } from "../lib/workspace-html-preview";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface WorkspaceHtmlPreviewProps {
  organizationId: string;
  filePath: string;
  htmlContent?: string;
  testIdPrefix?: string;
  className?: string;
}

type PreviewState =
  | { status: "loading"; session: null; error: null }
  | { status: "ready"; session: OrganizationWorkspaceWebPreviewSession; error: null }
  | { status: "error"; session: null; error: string };

const inFlightPreviewSessions = new Map<string, Promise<OrganizationWorkspaceWebPreviewSession>>();
const DEFAULT_NETWORK_MODE: WorkspaceWebPreviewNetworkMode = "connected";

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
  const networkMode = modeSelection.identity === identity ? modeSelection.mode : DEFAULT_NETWORK_MODE;

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
    setModeSelection({ identity, mode });
  };

  const retryPreview = () => {
    setModeSelection({ identity, mode: DEFAULT_NETWORK_MODE });
    setReloadVersion((current) => current + 1);
  };

  return (
    <div
      className={cn("flex min-h-[420px] flex-1 flex-col bg-white", className)}
      data-testid={`${testIdPrefix}-html-preview-frame`}
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-[color:var(--surface-elevated)] px-2">
        <TooltipProvider delayDuration={120}>
          {previewState.status === "error" ? (
            <div className="flex" role="group" aria-label="Website preview network mode" aria-disabled="true">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-[6.5rem] rounded-r-none bg-secondary text-secondary-foreground disabled:opacity-100"
                role="radio"
                aria-checked="true"
                aria-pressed="true"
                disabled
              >
                <WifiOff data-icon="inline-start" />
                Offline
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="-ml-px min-w-[6.5rem] rounded-l-none"
                role="radio"
                aria-checked="false"
                aria-pressed="false"
                aria-label="Connected preview is unavailable while using the static Offline fallback."
                disabled
              >
                <Wifi data-icon="inline-start" />
                Connected
              </Button>
            </div>
          ) : (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={networkMode}
              onValueChange={(value) => {
                if (value === "offline" || value === "connected") selectMode(value);
              }}
              aria-label="Website preview network mode"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value="offline"
                    className="min-w-[6.5rem]"
                    aria-pressed={networkMode === "offline"}
                  >
                    <WifiOff data-icon="inline-start" />
                    Offline
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent>Local assets only. Scripts and external requests are blocked.</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value="connected"
                    className="min-w-[6.5rem]"
                    aria-pressed={networkMode === "connected"}
                    aria-label="Connected. Runs artifact scripts and may send preview content to external HTTPS sites."
                  >
                    <Wifi data-icon="inline-start" />
                    Connected
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent>
                  Runs artifact scripts. Preview content may be sent to external HTTPS sites.
                </TooltipContent>
              </Tooltip>
            </ToggleGroup>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Reload website preview"
                onClick={() => setReloadVersion((current) => current + 1)}
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload preview</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

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
