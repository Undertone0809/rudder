import * as React from "react";
import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { OrganizationProvider } from "./context/OrganizationContext";
import { LiveUpdatesProvider } from "./context/LiveUpdatesProvider";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { PanelProvider } from "./context/PanelContext";
import { SidebarProvider } from "./context/SidebarContext";
import { DialogProvider } from "./context/DialogContext";
import { ToastProvider } from "./context/ToastContext";
import { ThemeProvider } from "./context/ThemeContext";
import { I18nProvider } from "./context/I18nContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initPluginBridge } from "./plugins/bridge-init";
import { PluginLauncherProvider } from "./plugins/launchers";
import "@mdxeditor/editor/style.css";
import "./index.css";
import "./motion.css";

initPluginBridge(React, ReactDOM);

function isDesktopShellWindow() {
  return typeof window !== "undefined"
    && "desktopShell" in window
    && Boolean((window as typeof window & { desktopShell?: unknown }).desktopShell);
}

function syncDesktopShellClass() {
  const isMacDesktopShell =
    isDesktopShellWindow()
    && /Mac/i.test(window.navigator.userAgent);

  document.documentElement.classList.toggle("desktop-shell-macos", isMacDesktopShell);
  if (document.body) {
    document.body.classList.toggle("desktop-shell-macos", isMacDesktopShell);
  }
}

async function disableDesktopServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  } catch (error) {
    console.warn("[rudder-ui] failed to unregister desktop service workers", error);
  }

  if (!("caches" in window)) return;

  try {
    const keys = await caches.keys();
    await Promise.allSettled(keys.map((key) => caches.delete(key)));
  } catch (error) {
    console.warn("[rudder-ui] failed to clear desktop service worker caches", error);
  }
}

syncDesktopShellClass();

if (typeof document !== "undefined") {
  const root = document.documentElement;
  root.style.backgroundColor = root.classList.contains("desktop-shell-macos")
    ? "transparent"
    : "";
}

if (isDesktopShellWindow()) {
  void disableDesktopServiceWorker();
} else if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <BrowserRouter>
            <OrganizationProvider>
              <ToastProvider>
                <LiveUpdatesProvider>
                  <TooltipProvider>
                    <BreadcrumbProvider>
                      <SidebarProvider>
                        <PanelProvider>
                          <PluginLauncherProvider>
                            <DialogProvider>
                              <App />
                            </DialogProvider>
                          </PluginLauncherProvider>
                        </PanelProvider>
                      </SidebarProvider>
                    </BreadcrumbProvider>
                  </TooltipProvider>
                </LiveUpdatesProvider>
              </ToastProvider>
            </OrganizationProvider>
          </BrowserRouter>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>
);
