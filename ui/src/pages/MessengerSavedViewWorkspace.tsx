import { messengerApi } from "@/api/messenger";
import { Button } from "@/components/ui/button";
import { useSidePanel, type SidePanelOpenResult } from "@/context/SidePanelContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import { localAppIdentityMatches } from "@/lib/local-apps";
import { sidePanelTargetFromSavedView } from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, MonitorOff, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export function MessengerSavedViewWorkspace({
  organizationId,
  savedViewId,
}: {
  organizationId: string;
  savedViewId: string;
}) {
  const sidePanel = useSidePanel();
  const savedViewQuery = useQuery({
    queryKey: queryKeys.messenger.savedView(organizationId, savedViewId),
    queryFn: () => messengerApi.getSavedView(organizationId, savedViewId),
    enabled: Boolean(organizationId && savedViewId),
  });
  const savedView = savedViewQuery.data ?? null;
  const rawTarget = useMemo(
    () => savedView ? sidePanelTargetFromSavedView(savedView) : null,
    [savedView],
  );
  const localTarget = rawTarget?.kind === "local_app" ? rawTarget : null;
  const localApps = readDesktopShell()?.localApps;
  const localAppsSupported = Boolean(localApps?.supported);
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    enabled: Boolean(localTarget) && localAppsSupported,
    retry: false,
  });
  const localDefinition = useMemo(() => (
    localTarget
      ? definitionsQuery.data?.find((definition) => localAppIdentityMatches(definition, localTarget)) ?? null
      : null
  ), [definitionsQuery.data, localTarget]);
  const localStatusQuery = useQuery({
    queryKey: queryKeys.localApps.status(localTarget?.localBindingId ?? "__none__"),
    queryFn: () => localApps!.status(localDefinition!.id),
    enabled: Boolean(localTarget && localDefinition && localAppsSupported),
    retry: false,
  });
  const target = localTarget
    ? localDefinition && localStatusQuery.isSuccess ? localTarget : null
    : rawTarget;
  const [openAttempt, setOpenAttempt] = useState<{
    savedViewId: string;
    result: SidePanelOpenResult;
  } | null>(null);
  const tryOpenSavedView = useCallback(() => {
    if (!target) return;
    setOpenAttempt({
      savedViewId,
      result: sidePanel.openTarget(target),
    });
  }, [savedViewId, sidePanel.openTarget, target]);

  useEffect(() => {
    tryOpenSavedView();
  }, [tryOpenSavedView]);

  const localChecking = Boolean(localTarget && localAppsSupported && (
    definitionsQuery.isPending || (localDefinition && localStatusQuery.isPending)
  ));
  if (savedViewQuery.isPending || localChecking) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Opening saved view…</div>;
  }
  const error = savedViewQuery.error ?? definitionsQuery.error ?? localStatusQuery.error;
  if (error) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center" data-testid="messenger-saved-view-error" role="alert">
        <h1 className="text-lg font-semibold text-foreground">Could not open saved view</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-destructive">{error.message}</p>
        <Button
          type="button"
          variant="outline"
          className="mt-5"
          onClick={() => {
            if (savedViewQuery.error) void savedViewQuery.refetch();
            if (definitionsQuery.error) void definitionsQuery.refetch();
            if (localStatusQuery.error) void localStatusQuery.refetch();
          }}
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </Button>
      </div>
    );
  }
  if (!savedView) return null;

  if (!target) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center" data-testid="messenger-saved-view-unavailable">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--surface-active)] text-muted-foreground">
          <MonitorOff className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-foreground">{savedView.title}</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          This local app is not available on this device yet. Open it from a configured Rudder Desktop installation.
        </p>
      </div>
    );
  }

  if (!openAttempt || openAttempt.savedViewId !== savedViewId) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Opening saved view…</div>;
  }

  if (!openAttempt.result.admitted) {
    return (
      <div
        className="mx-auto flex max-w-xl flex-col items-center py-16 text-center"
        data-testid="messenger-saved-view-capacity-error"
        role="alert"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--surface-active)] text-muted-foreground">
          <MonitorOff className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-foreground">Could not open saved view</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          Browser tabs are limited to eight in this workspace. Close a Browser tab, then retry opening this Saved View.
        </p>
        <Button type="button" variant="outline" className="mt-5" onClick={tryOpenSavedView}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          Retry opening
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center py-16 text-center" data-testid="messenger-saved-view-workspace">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--surface-active)] text-[color:var(--accent-strong)]">
        <Bookmark className="h-4 w-4" aria-hidden />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-foreground">{savedView.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {savedView.subtitle ?? "Opened in the Side Panel."}
      </p>
    </div>
  );
}
