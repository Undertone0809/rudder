import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DesktopWorkspaceLaunchTarget } from "@/lib/desktop-shell";
import { cn } from "@/lib/utils";
import {
  isWorkspaceFileOpenTarget,
  type WorkspaceFileOpenTarget,
  type WorkspaceOpenTargetId,
  type WorkspaceUnsupportedFileLaunchTarget,
} from "@/lib/workspace-preferences";
import { ChevronDown, Code2, ExternalLink, FolderOpen, Loader2, Terminal } from "lucide-react";
import { useState } from "react";

const WORKSPACE_LAUNCH_TARGET_BRAND_FALLBACKS: Partial<Record<DesktopWorkspaceLaunchTarget["id"], {
  src: string;
}>> = {
  cursor: { src: "/brands/cursor-app-icon.svg" },
};
const WORKSPACE_LAUNCH_TARGET_FALLBACKS: Partial<Record<DesktopWorkspaceLaunchTarget["id"], {
  label: string;
  className: string;
}>> = {
  vscode: { label: "VS", className: "bg-[#0078d4] text-white" },
  windsurf: { label: "W", className: "bg-[#14b8a6] text-white" },
  zed: { label: "Z", className: "bg-[#171717] text-white" },
  webstorm: { label: "WS", className: "bg-[#ec4899] text-white" },
  intellij: { label: "IJ", className: "bg-[#f97316] text-white" },
  xcode: { label: "XC", className: "bg-[#147efb] text-white" },
  commandPrompt: { label: "CMD", className: "bg-[#111827] text-white" },
  powershell: { label: "PS", className: "bg-[#2563eb] text-white" },
};

export function WorkspaceLaunchTargetIcon({
  target,
  className,
}: {
  target: DesktopWorkspaceLaunchTarget | WorkspaceFileOpenTarget;
  className?: string;
}) {
  const [nativeImageFailed, setNativeImageFailed] = useState(false);
  const [brandImageFailed, setBrandImageFailed] = useState(false);
  const workspaceTarget = isWorkspaceFileOpenTarget(target) ? target.workspaceTarget : target;
  const slotClassName = cn(
    "inline-flex h-5 w-5 shrink-0 items-center justify-center",
    className,
  );

  if (workspaceTarget?.iconDataUrl && !nativeImageFailed) {
    return (
      <span
        aria-hidden="true"
        className={slotClassName}
        data-workspace-launch-target-icon={target.id}
      >
        <img
          src={workspaceTarget.iconDataUrl}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setNativeImageFailed(true)}
        />
      </span>
    );
  }

  const brandFallback = workspaceTarget ? WORKSPACE_LAUNCH_TARGET_BRAND_FALLBACKS[workspaceTarget.id] : null;
  if (brandFallback && !brandImageFailed) {
    return (
      <span
        aria-hidden="true"
        className={slotClassName}
        data-workspace-launch-target-icon={target.id}
        data-fallback-icon="true"
        data-brand-fallback="true"
      >
        <img
          src={brandFallback.src}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setBrandImageFailed(true)}
        />
      </span>
    );
  }

  const appSpecificFallback = workspaceTarget ? WORKSPACE_LAUNCH_TARGET_FALLBACKS[workspaceTarget.id] : null;
  if (appSpecificFallback) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-[color:var(--border-base)] text-[9px] font-semibold leading-none",
          appSpecificFallback.className,
          className,
        )}
        data-workspace-launch-target-icon={target.id}
        data-fallback-icon="true"
        data-app-specific-fallback="true"
      >
        {appSpecificFallback.label}
      </span>
    );
  }

  const Icon = target.kind === "terminal" ? Terminal : target.kind === "folder" ? FolderOpen : target.kind === "app" ? ExternalLink : Code2;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-[color:var(--border-base)] bg-[color:var(--surface-page)] text-foreground",
        className,
      )}
      data-workspace-launch-target-icon={target.id}
      data-fallback-icon="true"
    >
      <Icon className="h-[72%] w-[72%]" />
    </span>
  );
}

export function WorkspaceLaunchMenu({
  rootPath,
  targets,
  openingTargetId,
  onOpenTarget,
  className,
  contentAlign = "end",
  testId = "org-workspaces-launcher",
  targetTestIdPrefix = "org-workspaces-launch-target",
}: {
  rootPath: string;
  targets: DesktopWorkspaceLaunchTarget[];
  openingTargetId: DesktopWorkspaceLaunchTarget["id"] | null;
  onOpenTarget: (rootPath: string, target: DesktopWorkspaceLaunchTarget, toastLabel?: string) => void;
  className?: string;
  contentAlign?: "start" | "center" | "end";
  testId?: string;
  targetTestIdPrefix?: string;
}) {
  if (targets.length === 0) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "h-7 w-7 rounded-md text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground",
                className,
              )}
              aria-label="Open Library menu"
              disabled={openingTargetId !== null}
              data-testid={testId}
            >
              {openingTargetId ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Open Library</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={contentAlign}
        sideOffset={8}
        className="w-60 whitespace-nowrap p-1"
      >
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.id}
            className="h-9 gap-2 rounded-[6px]"
            disabled={openingTargetId !== null}
            data-testid={`${targetTestIdPrefix}-${target.id}`}
            onSelect={() => {
              onOpenTarget(rootPath, target, "workspace");
            }}
          >
            {openingTargetId === target.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <WorkspaceLaunchTargetIcon target={target} />
            )}
            <span className="min-w-0 flex-1 truncate">{target.label}</span>
            <span className="text-[11px] capitalize text-muted-foreground">{target.kind}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UnsupportedWorkspaceFileLauncher({
  targets,
  currentTarget,
  openingTargetId,
  onOpenTarget,
}: {
  targets: WorkspaceUnsupportedFileLaunchTarget[];
  currentTarget: WorkspaceUnsupportedFileLaunchTarget | null;
  openingTargetId: WorkspaceOpenTargetId | null;
  onOpenTarget: (target: WorkspaceUnsupportedFileLaunchTarget) => void;
}) {
  const pending = openingTargetId !== null;

  return (
    <div className="flex h-full min-h-[360px] items-center justify-center px-6 py-10">
      <div className="flex max-w-md flex-col items-center text-center">
        <p className="text-sm leading-6 text-muted-foreground">
          This file can’t be previewed or edited in Rudder.
        </p>
        {currentTarget && targets.length > 0 ? (
          <div className="mt-4 inline-flex h-9 items-stretch rounded-md border border-[color:var(--border-base)] bg-[color:var(--surface-page)]">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-10 rounded-r-none border-r border-[color:var(--border-base)]"
                  aria-label={`Open file with ${currentTarget.label}`}
                  disabled={pending}
                  data-testid="org-workspaces-unsupported-file-open-current"
                  onClick={() => onOpenTarget(currentTarget)}
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <WorkspaceLaunchTargetIcon target={currentTarget} />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="pointer-events-none">{`Open with ${currentTarget.label}`}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-8 rounded-l-none"
                      aria-label="Choose how to open file"
                      disabled={pending}
                      data-testid="org-workspaces-unsupported-file-launcher"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent className="pointer-events-none">Choose how to open file</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="center" sideOffset={8} className="w-60 whitespace-nowrap p-1">
                {targets.map((target) => (
                  <DropdownMenuItem
                    key={target.id}
                    className="h-9 gap-2 rounded-[6px]"
                    disabled={pending}
                    data-testid={`org-workspaces-unsupported-file-target-${target.id}`}
                    onSelect={() => onOpenTarget(target)}
                  >
                    {openingTargetId === target.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <WorkspaceLaunchTargetIcon target={target} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{target.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceFileOpenMenu({
  targets,
  openingTargetId,
  onOpenTarget,
  testId = "workspace-file-open-menu",
}: {
  targets: WorkspaceUnsupportedFileLaunchTarget[];
  openingTargetId: WorkspaceOpenTargetId | null;
  onOpenTarget: (target: WorkspaceUnsupportedFileLaunchTarget) => void;
  testId?: string;
}) {
  if (targets.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1 px-2"
          aria-label="Open file options"
          disabled={openingTargetId !== null}
          data-testid={testId}
        >
          {openingTargetId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
          <span>Open</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" sideOffset={8} className="w-60 whitespace-nowrap p-1">
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.id}
            className="h-9 gap-2 rounded-[6px]"
            disabled={openingTargetId !== null}
            data-testid={`${testId}-target-${target.id}`}
            onSelect={() => onOpenTarget(target)}
          >
            <WorkspaceLaunchTargetIcon target={target} />
            <span className="min-w-0 flex-1 truncate">{target.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
