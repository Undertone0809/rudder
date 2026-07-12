import { instanceSettingsApi } from "@/api/instanceSettings";
import { useSidePanel } from "@/context/SidePanelContext";
import { routeDesktopWebLink } from "@/lib/desktop-browser-link-router";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function DesktopBrowserLinkBridge() {
  const queryClient = useQueryClient();
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
        openBuiltIn: openTarget,
        forceOpenExternal: (url) => (
          desktopShell.forceOpenExternal?.(url) ?? desktopShell.openExternal(url)
        ),
      }).catch((error) => {
        console.warn("[rudder-ui] failed to route Desktop web link", error);
      });
    });
  }, [openTarget, queryClient]);

  return null;
}
