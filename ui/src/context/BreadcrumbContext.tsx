import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface Breadcrumb {
  label: string;
  href?: string;
  /** Secondary line in single-crumb header (e.g. linked issue); use with `subhref` for a link */
  sublabel?: string;
  subhref?: string;
}

interface BreadcrumbContextValue {
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
  headerActions: ReactNode | null;
  setHeaderActions: (actions: ReactNode | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);
  const [headerActions, setHeaderActionsState] = useState<ReactNode | null>(null);

  const setBreadcrumbs = useCallback((crumbs: Breadcrumb[]) => {
    setBreadcrumbsState(crumbs);
  }, []);

  const setHeaderActions = useCallback((actions: ReactNode | null) => {
    setHeaderActionsState(actions);
  }, []);

  useEffect(() => {
    if (breadcrumbs.length === 0) {
      document.title = "Rudder";
    } else {
      const parts = [...breadcrumbs].reverse().flatMap((b) => {
        const chunk = [b.label];
        if (b.sublabel) chunk.push(b.sublabel);
        return chunk;
      });
      document.title = `${parts.join(" · ")} · Rudder`;
    }
  }, [breadcrumbs]);

  return (
    <BreadcrumbContext.Provider value={{ breadcrumbs, setBreadcrumbs, headerActions, setHeaderActions }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumbs() {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) {
    throw new Error("useBreadcrumbs must be used within BreadcrumbProvider");
  }
  return ctx;
}
