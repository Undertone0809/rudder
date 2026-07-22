import { messengerApi } from "@/api/messenger";
import { useSidePanel } from "@/context/SidePanelContext";
import { sidePanelTargetFromSavedView } from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, MonitorOff } from "lucide-react";
import { useEffect, useMemo } from "react";

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
  const target = useMemo(
    () => savedView ? sidePanelTargetFromSavedView(savedView) : null,
    [savedView],
  );

  useEffect(() => {
    if (!target) return;
    sidePanel.openTarget(target);
  }, [sidePanel.openTarget, target]);

  if (savedViewQuery.isPending) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Opening saved view…</div>;
  }
  if (savedViewQuery.error) {
    return (
      <div className="mx-auto max-w-3xl py-10 text-sm text-destructive" role="alert">
        {savedViewQuery.error.message}
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
