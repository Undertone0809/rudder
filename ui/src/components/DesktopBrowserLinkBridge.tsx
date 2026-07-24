import { instanceSettingsApi } from "@/api/instanceSettings";
import { useOptionalLiveSurfaceRuntime } from "@/context/LiveSurfaceRuntimeContext";
import { useOptionalOrganization } from "@/context/OrganizationContext";
import { useSidePanel } from "@/context/SidePanelContext";
import { useOptionalToast } from "@/context/ToastContext";
import { routeDesktopWebLink } from "@/lib/desktop-browser-link-router";
import { readDesktopShell } from "@/lib/desktop-shell";
import { MAIN_WORKBENCH_BROWSER_CAPACITY } from "@/lib/main-workbench-state";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

function focusedLiveRuntime() {
  const host = document.activeElement
    ?.closest<HTMLElement>("[data-runtime-id]");
  if (
    !host
    || host.hidden
    || host.hasAttribute("inert")
    || host.getAttribute("aria-hidden") === "true"
  ) return null;
  const runtimeId = host.dataset.runtimeId;
  if (!runtimeId) return null;
  return {
    runtimeId,
    owner: host.dataset.ownerId?.startsWith("main:")
      ? "main_workbench" as const
      : "side_panel" as const,
  };
}

function focusedLiveRuntimeId() {
  return focusedLiveRuntime()?.runtimeId ?? null;
}

export function DesktopBrowserLinkBridge() {
  const queryClient = useQueryClient();
  const liveSurfaceRuntime = useOptionalLiveSurfaceRuntime();
  const organization = useOptionalOrganization();
  const { openTarget } = useSidePanel();
  const toast = useOptionalToast();

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onOpenWebLink) return undefined;

    return desktopShell.onOpenWebLink((request) => {
      void routeDesktopWebLink({
        request,
        getSettings: () => queryClient.fetchQuery({
          queryKey: queryKeys.instance.browserSettings,
          queryFn: () => instanceSettingsApi.getBrowser(),
          staleTime: 0,
        }),
        openBuiltIn: (target) => {
          if (
            request.sourceWebContentsId
          ) {
            const openedForGuest = liveSurfaceRuntime?.openTargetForGuest(
              request.sourceWebContentsId,
              target,
            ) ?? false;
            if (!openedForGuest) {
              console.warn(
                "[rudder-ui] ignored Browser popup without a live guest owner",
                request.sourceWebContentsId,
              );
            }
            return;
          }
          const organizationId =
            organization?.selectedOrganizationId?.trim() ?? "";
          const allowNewBrowserGuest = !liveSurfaceRuntime
            || !organizationId
            || liveSurfaceRuntime.getLiveBrowserCount(organizationId)
              < MAIN_WORKBENCH_BROWSER_CAPACITY;
          const opened = openTarget(target, { allowNewBrowserGuest });
          if (!opened.admitted) {
            toast?.pushToast({
              title: "Browser tab limit reached",
              body: `Close a Browser tab to open another. Side Panel and Main share ${MAIN_WORKBENCH_BROWSER_CAPACITY} live tabs.`,
              tone: "error",
            });
          }
        },
        forceOpenExternal: (url) => (
          desktopShell.forceOpenExternal?.(url) ?? desktopShell.openExternal(url)
        ),
      }).catch((error) => {
        console.warn("[rudder-ui] failed to route Desktop web link", error);
      });
    });
  }, [
    liveSurfaceRuntime,
    openTarget,
    organization?.selectedOrganizationId,
    queryClient,
    toast,
  ]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onBrowserShortcut) return undefined;
    return desktopShell.onBrowserShortcut((request) => {
      if (!liveSurfaceRuntime) return;
      const activeRuntimeId = request.sourceWebContentsId
        ? null
        : focusedLiveRuntimeId();
      if (request.action === "close_tab") {
        if (request.sourceWebContentsId) {
          liveSurfaceRuntime.closeTargetForGuest(request.sourceWebContentsId);
        } else if (activeRuntimeId) {
          liveSurfaceRuntime.closeTargetForRuntime(activeRuntimeId);
        }
        return;
      }
      if (request.sourceWebContentsId) {
        liveSurfaceRuntime.dispatchBrowserShortcutForGuest(
          request.sourceWebContentsId,
          request.action,
        );
      } else if (activeRuntimeId) {
        liveSurfaceRuntime.dispatchBrowserShortcutForRuntime(
          activeRuntimeId,
          request.action,
        );
      }
    });
  }, [liveSurfaceRuntime]);

  useEffect(() => {
    const setBrowserSurfaceShortcutActive =
      readDesktopShell()?.setBrowserSurfaceShortcutActive;
    if (!setBrowserSurfaceShortcutActive || !liveSurfaceRuntime) return undefined;
    let disposed = false;
    let active = false;
    let lastOwner: "main_workbench" | "side_panel" | undefined;
    const syncScope = () => {
      if (disposed) return;
      const focusedRuntime = focusedLiveRuntime();
      const runtimeId = focusedRuntime?.runtimeId ?? null;
      const nextActive = runtimeId
        ? liveSurfaceRuntime.getRuntimeTarget(runtimeId)?.kind === "browser"
        : false;
      const owner = focusedRuntime?.owner;
      if (active === nextActive && owner === lastOwner) return;
      active = nextActive;
      lastOwner = owner;
      void setBrowserSurfaceShortcutActive(nextActive, owner).catch(() => undefined);
    };
    const queueScopeSync = () => queueMicrotask(syncScope);
    document.addEventListener("focusin", queueScopeSync, true);
    document.addEventListener("focusout", queueScopeSync, true);
    syncScope();
    return () => {
      disposed = true;
      document.removeEventListener("focusin", queueScopeSync, true);
      document.removeEventListener("focusout", queueScopeSync, true);
      void setBrowserSurfaceShortcutActive(false).catch(() => undefined);
    };
  }, [liveSurfaceRuntime]);

  return null;
}
