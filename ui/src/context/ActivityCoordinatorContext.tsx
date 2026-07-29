import {
  ActivityCoordinator,
  fallbackActivityCoordinator,
  type ActivityKey,
  type ActivitySummarySnapshot,
} from "@/runtime/activity-coordinator";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useOrganization } from "./OrganizationContext";

const ActivityCoordinatorContext = createContext<ActivityCoordinator>(fallbackActivityCoordinator);

declare global {
  interface Window {
    __RUDDER_ACTIVITY_COORDINATOR__?: ActivityCoordinator;
  }
}

export function ActivityCoordinatorProvider({ children }: { children: ReactNode }) {
  const { selectedOrganizationId } = useOrganization();
  const coordinator = useMemo(
    () => new ActivityCoordinator(selectedOrganizationId ?? null),
    [selectedOrganizationId],
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    window.__RUDDER_ACTIVITY_COORDINATOR__ = coordinator;
    return () => {
      if (window.__RUDDER_ACTIVITY_COORDINATOR__ === coordinator) {
        delete window.__RUDDER_ACTIVITY_COORDINATOR__;
      }
    };
  }, [coordinator]);

  return <ActivityCoordinatorScope coordinator={coordinator}>{children}</ActivityCoordinatorScope>;
}

export function ActivityCoordinatorScope({
  children,
  coordinator,
}: {
  children: ReactNode;
  coordinator: ActivityCoordinator;
}) {
  return (
    <ActivityCoordinatorContext.Provider value={coordinator}>
      {children}
    </ActivityCoordinatorContext.Provider>
  );
}

export function useActivityCoordinator() {
  return useContext(ActivityCoordinatorContext);
}

export function useActivitySummary(key: ActivityKey | null): ActivitySummarySnapshot | null {
  const coordinator = useActivityCoordinator();
  return useSyncExternalStore(
    (listener) => key ? coordinator.subscribeSummary(key, listener) : () => undefined,
    () => key ? coordinator.getSummary(key) : null,
    () => key ? coordinator.getSummary(key) : null,
  );
}

export function useActivityDetailLease(key: ActivityKey | null) {
  const coordinator = useActivityCoordinator();
  useEffect(() => {
    if (!key) return undefined;
    const lease = coordinator.acquireDetail(key);
    return () => lease.release();
  }, [coordinator, key]);
}
