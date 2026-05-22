import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readDesktopShell, type DesktopUpdateProgressEvent } from "@/lib/desktop-shell";

type DesktopUpdateProgressContextValue = {
  progress: DesktopUpdateProgressEvent | null;
  dismissProgress: () => void;
};

const DesktopUpdateProgressContext = createContext<DesktopUpdateProgressContextValue | null>(null);
const EMPTY_DESKTOP_UPDATE_PROGRESS_CONTEXT: DesktopUpdateProgressContextValue = {
  progress: null,
  dismissProgress: () => undefined,
};

export function DesktopUpdateProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<DesktopUpdateProgressEvent | null>(null);
  const [dismissedUpdateId, setDismissedUpdateId] = useState<string | null>(null);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return undefined;

    void desktopShell.getUpdateProgress?.()
      .then((event) => {
        if (event) setProgress(event);
      })
      .catch(() => undefined);

    return desktopShell.onUpdateProgress?.((event) => {
      setProgress(event);
      setDismissedUpdateId((current) => current === event.updateId && event.phase !== "failed" ? current : null);
    });
  }, []);

  const visibleProgress = progress?.updateId === dismissedUpdateId ? null : progress;

  const value = useMemo<DesktopUpdateProgressContextValue>(
    () => ({
      progress: visibleProgress,
      dismissProgress: () => {
        if (progress) setDismissedUpdateId(progress.updateId);
      },
    }),
    [progress, visibleProgress],
  );

  return (
    <DesktopUpdateProgressContext.Provider value={value}>
      {children}
    </DesktopUpdateProgressContext.Provider>
  );
}

export function useDesktopUpdateProgress() {
  const context = useContext(DesktopUpdateProgressContext);
  return context ?? EMPTY_DESKTOP_UPDATE_PROGRESS_CONTEXT;
}
