import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleRingBuffer } from "@/lib/console-ring-buffer";
import { BrowserRouter } from "@/lib/router";
import "@mdxeditor/editor/style.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { ChatGenerationProvider } from "./context/ChatGenerationContext";
import { DesktopUpdateProgressProvider } from "./context/DesktopUpdateProgressContext";
import { DialogProvider } from "./context/DialogContext";
import { I18nProvider } from "./context/I18nContext";
import { LiveUpdatesProvider } from "./context/LiveUpdatesProvider";
import { OrganizationProvider } from "./context/OrganizationContext";
import { PanelProvider } from "./context/PanelContext";
import { SidebarProvider } from "./context/SidebarContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import "./index.css";
import "./motion.css";
import { initPluginBridge } from "./plugins/bridge-init";
import { PluginLauncherProvider } from "./plugins/launchers";

const E2E_CHILDREN_ONLY_ERROR_MESSAGE = "React.Children.only expected to receive a single React element child.";

declare global {
  interface ImportMeta {
    readonly env: {
      readonly DEV: boolean;
    };
  }

  interface Window {
    __RUDDER_E2E_THROW_APP_RENDER_ERROR__?: "children-only";
  }
}

ConsoleRingBuffer.install();

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

function AppRoot() {
  if (import.meta.env.DEV && window.__RUDDER_E2E_THROW_APP_RENDER_ERROR__ === "children-only") {
    throw new Error(E2E_CHILDREN_ONLY_ERROR_MESSAGE);
  }

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        <I18nProvider>
          <ThemeProvider>
            <BrowserRouter>
              <OrganizationProvider>
                <ToastProvider>
                  <DesktopUpdateProgressProvider>
                    <LiveUpdatesProvider>
                      <TooltipProvider>
                        <BreadcrumbProvider>
                          <SidebarProvider>
                            <PanelProvider>
                              <PluginLauncherProvider>
                                <DialogProvider>
                                  <ChatGenerationProvider>
                                    <AppRoot />
                                  </ChatGenerationProvider>
                                </DialogProvider>
                              </PluginLauncherProvider>
                            </PanelProvider>
                          </SidebarProvider>
                        </BreadcrumbProvider>
                      </TooltipProvider>
                    </LiveUpdatesProvider>
                  </DesktopUpdateProgressProvider>
                </ToastProvider>
              </OrganizationProvider>
            </BrowserRouter>
          </ThemeProvider>
        </I18nProvider>
      </AppErrorBoundary>
    </QueryClientProvider>
  </StrictMode>
);
