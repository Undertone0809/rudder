import { messengerApi } from "@/api/messenger";
import { Button } from "@/components/ui/button";
import { MessengerMainWorkbench } from "@/components/workbench/MessengerMainWorkbench";
import {
  createMainWorkbenchRuntimeId,
  useOrganizationMainWorkbench,
  type MainWorkbenchAdmission,
} from "@/context/MainWorkbenchContext";
import type { MainWorkbenchTarget } from "@/lib/main-workbench-state";
import { sidePanelTargetFromSavedView } from "@/lib/messenger-saved-views";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export function MessengerSavedViewWorkspace({
  organizationId,
  routeMode = "messenger",
  savedViewId,
}: {
  organizationId: string;
  routeMode?: "messenger" | "local_app";
  savedViewId: string;
}) {
  const workbench = useOrganizationMainWorkbench(organizationId);
  const savedViewQuery = useQuery({
    queryKey: queryKeys.messenger.savedView(organizationId, savedViewId),
    queryFn: () => messengerApi.getSavedView(organizationId, savedViewId),
    enabled: Boolean(organizationId && savedViewId),
    retry: false,
  });
  const target = useMemo(() => {
    const rawTarget = savedViewQuery.data
      ? sidePanelTargetFromSavedView(savedViewQuery.data)
      : null;
    if (
      !rawTarget
      || (
        rawTarget.kind !== "automation"
        && rawTarget.kind !== "browser"
        && rawTarget.kind !== "library_directory"
        && rawTarget.kind !== "library_document"
        && rawTarget.kind !== "library_entry"
        && rawTarget.kind !== "library_file"
        && rawTarget.kind !== "local_app"
      )
    ) return null;
    const viewInstanceId = rawTarget.viewInstanceId
      ?? (rawTarget.kind === "browser" ? rawTarget.tabId : null);
    return viewInstanceId
      ? { ...rawTarget, viewInstanceId } as MainWorkbenchTarget
      : null;
  }, [savedViewQuery.data]);
  const retainedPromotion = useMemo(
    () => Object.values(workbench.promotionsById).find((promotion) => (
      promotion.source.savedViewId === savedViewId
      || ("savedViewId" in promotion && promotion.savedViewId === savedViewId)
      || (
        promotion.source.target.kind === target?.kind
        && promotion.source.viewInstanceId === target.viewInstanceId
      )
    )) ?? null,
    [savedViewId, target?.viewInstanceId, workbench.promotionsById],
  );
  const [openAttempt, setOpenAttempt] = useState<{
    savedViewId: string;
    result: MainWorkbenchAdmission;
  } | null>(null);
  const requestedOpenKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target || retainedPromotion) return;
    const openKey = `${savedViewId}:${target.kind}:${target.viewInstanceId}`;
    if (requestedOpenKeyRef.current === openKey) return;
    requestedOpenKeyRef.current = openKey;
    const runtimeId = createMainWorkbenchRuntimeId(organizationId, target);
    const result = workbench.openSavedTab(savedViewId, {
      viewInstanceId: target.viewInstanceId,
      runtimeId,
      target,
      originContextKey: `messenger:saved:${savedViewId}`,
    });
    setOpenAttempt({ savedViewId, result });
  }, [
    organizationId,
    savedViewId,
    target,
    retainedPromotion,
    workbench.openSavedTab,
  ]);

  const openError = savedViewQuery.error;
  const capacityError = openAttempt?.savedViewId === savedViewId
    && !openAttempt.result.admitted
    && openAttempt.result.reason === "browser_capacity";

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      {openError ? (
        <div
          className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
          data-testid="messenger-saved-view-error"
          role="alert"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {openError instanceof Error
              ? openError.message
              : "Could not open this Saved View."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void savedViewQuery.refetch()}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
      {capacityError ? (
        <div
          className="shrink-0 border-b border-border/70 bg-[color:var(--surface-active)] px-4 py-2 text-sm text-muted-foreground"
          data-testid="messenger-saved-view-capacity-error"
          role="alert"
        >
          Browser tabs are limited to eight live guests. Close a Browser tab,
          then select this Saved View again.
        </div>
      ) : null}
      {savedViewQuery.isPending ? (
        <p className="sr-only" role="status" aria-live="polite">
          Opening Saved View…
        </p>
      ) : null}
      {retainedPromotion ? (
        <p className="sr-only" role="status" aria-live="polite">
          This Saved View move is retained in Side for recovery.
        </p>
      ) : null}
      <MessengerMainWorkbench
        className="min-h-0 flex-1"
        organizationId={organizationId}
        routeMode={routeMode}
      />
    </div>
  );
}
