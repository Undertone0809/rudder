import { readDesktopShell } from "@/lib/desktop-shell";
import { Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

function syncMaximizedClass(maximized: boolean) {
  document.documentElement.classList.toggle("desktop-shell-window-maximized", maximized);
  document.body?.classList.toggle("desktop-shell-window-maximized", maximized);
}

export function DesktopWindowControls() {
  const [visible, setVisible] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    const shouldShow = desktopShell?.platform === "win32"
      && typeof desktopShell.minimizeWindow === "function"
      && typeof desktopShell.toggleMaximizeWindow === "function"
      && typeof desktopShell.closeWindow === "function";

    setVisible(shouldShow);
    if (!shouldShow || typeof desktopShell?.isWindowMaximized !== "function") {
      syncMaximizedClass(false);
      return;
    }

    let canceled = false;
    const updateMaximized = (value: boolean) => {
      if (canceled) return;
      setMaximized(value);
      syncMaximizedClass(value);
    };

    void desktopShell.isWindowMaximized()
      .then(updateMaximized)
      .catch(() => updateMaximized(false));

    const syncOnResize = () => {
      void desktopShell.isWindowMaximized?.()
        .then(updateMaximized)
        .catch(() => updateMaximized(false));
    };
    window.addEventListener("resize", syncOnResize);
    return () => {
      canceled = true;
      window.removeEventListener("resize", syncOnResize);
      syncMaximizedClass(false);
    };
  }, []);

  if (!visible) return null;

  const desktopShell = readDesktopShell();

  return createPortal(
    <div className="desktop-caption-controls desktop-window-no-drag" aria-label="Window controls">
      <button
        type="button"
        className="desktop-caption-control"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => {
          void desktopShell?.minimizeWindow?.();
        }}
      >
        <Minus aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="desktop-caption-control"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => {
          void desktopShell?.toggleMaximizeWindow?.()
            .then((value) => {
              setMaximized(value);
              syncMaximizedClass(value);
            })
            .catch(() => {
              setMaximized(false);
              syncMaximizedClass(false);
            });
        }}
      >
        <Square aria-hidden="true" size={12} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="desktop-caption-control desktop-caption-control--close"
        aria-label="Close"
        title="Close"
        onClick={() => {
          void desktopShell?.closeWindow?.();
        }}
      >
        <X aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>
    </div>,
    document.body,
  );
}
