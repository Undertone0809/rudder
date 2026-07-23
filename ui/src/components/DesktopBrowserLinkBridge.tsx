import { instanceSettingsApi } from "@/api/instanceSettings";
import { useOptionalLiveSurfaceRuntime } from "@/context/LiveSurfaceRuntimeContext";
import { useSidePanel } from "@/context/SidePanelContext";
import { routeDesktopWebLink } from "@/lib/desktop-browser-link-router";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function DesktopBrowserLinkBridge() {
  const queryClient = useQueryClient();
  const liveSurfaceRuntime = useOptionalLiveSurfaceRuntime();
  const { openTarget } = useSidePanel();

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
          openTarget(target);
        },
        forceOpenExternal: (url) => (
          desktopShell.forceOpenExternal?.(url) ?? desktopShell.openExternal(url)
        ),
      }).catch((error) => {
        console.warn("[rudder-ui] failed to route Desktop web link", error);
      });
    });
  }, [liveSurfaceRuntime, openTarget, queryClient]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onBrowserShortcut) return undefined;
    return desktopShell.onBrowserShortcut((request) => {
      if (!liveSurfaceRuntime) return;
      const activeRuntimeId = request.sourceWebContentsId
        ? null
        : document.activeElement
          ?.closest<HTMLElement>("[data-runtime-id]")
          ?.dataset.runtimeId ?? null;
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

  return null;
}
