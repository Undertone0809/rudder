import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BROWSER_SIDE_PANEL_BLANK_URL,
  browserSidePanelErrorContent,
  browserSidePanelLabel,
  createBrowserSidePanelTarget,
  isBrowserSidePanelCloseShortcutInput,
  normalizeBrowserSidePanelUrl,
  type BrowserLoadError,
  type BrowserWebviewInputEvent,
} from "@/lib/browser-side-panel";
import { readDesktopShell } from "@/lib/desktop-shell";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import {
  resolveBrowserShortcutInput,
  type BrowserShortcutAction,
} from "@rudderhq/shared";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileWarning,
  Globe2,
  Loader2,
  Plus,
  RotateCw,
} from "lucide-react";
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

const BROWSER_LIVE_SURFACE_ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  getWebContentsId?: () => number;
  getURL?: () => string;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  reloadIgnoringCache?: () => void;
  setZoomFactor?: (factor: number) => void;
};

function acceptedBrowserFavicon(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8_192) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

export type BrowserLiveSurfaceProps = {
  active: boolean;
  canOpenNewTab: boolean;
  target: Extract<SidePanelTarget, { kind: "browser" }>;
  targetKey: string;
  onOpenTarget: (target: SidePanelTarget) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
  onCloseTarget: (target: SidePanelTarget) => void;
  onCycleTab?: (direction: -1 | 1) => void;
  onWebContentsIdChange?: (webContentsId: number | null) => void;
  onRegisterShortcutController: (
    key: string,
    controller: ((action: BrowserShortcutAction) => void) | null,
  ) => void;
};

export function BrowserLiveSurface({
  active,
  canOpenNewTab,
  target,
  targetKey,
  onOpenTarget,
  onReplaceTarget,
  onCloseTarget,
  onCycleTab,
  onWebContentsIdChange,
  onRegisterShortcutController,
}: BrowserLiveSurfaceProps) {
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const webviewReadyRef = useRef(false);
  const targetUrlRef = useRef(target.url);
  const currentUrlRef = useRef(target.url);
  const targetRef = useRef(target);
  const onReplaceTargetRef = useRef(onReplaceTarget);
  const onCloseTargetRef = useRef(onCloseTarget);
  const onCycleTabRef = useRef(onCycleTab);
  const onWebContentsIdChangeRef = useRef(onWebContentsIdChange);
  const activeRef = useRef(active);
  const executeBrowserShortcutRef = useRef<((action: BrowserShortcutAction) => void) | null>(null);
  const [webviewNode, setWebviewNode] = useState<BrowserWebviewElement | null>(null);
  const zoomFactorRef = useRef(1);
  const [addressValue, setAddressValue] = useState(
    target.url === BROWSER_SIDE_PANEL_BLANK_URL ? "" : target.url,
  );
  const [currentUrl, setCurrentUrl] = useState(target.url);
  const [webviewSrc, setWebviewSrc] = useState(target.url);
  const [title, setTitle] = useState(target.label);
  const [loading, setLoading] = useState(false);
  const [navigationState, setNavigationState] = useState({
    canGoBack: false,
    canGoForward: false,
  });
  const [loadError, setLoadError] = useState<BrowserLoadError | null>(null);
  const [loadErrorDetailsOpen, setLoadErrorDetailsOpen] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1);
  const isBlank = currentUrl === BROWSER_SIDE_PANEL_BLANK_URL;
  const loadErrorContent = loadError ? browserSidePanelErrorContent(loadError) : null;
  currentUrlRef.current = currentUrl;
  targetRef.current = target;
  onReplaceTargetRef.current = onReplaceTarget;
  onCloseTargetRef.current = onCloseTarget;
  onCycleTabRef.current = onCycleTab;
  onWebContentsIdChangeRef.current = onWebContentsIdChange;
  activeRef.current = active;

  const safeWebviewCall = useCallback(<T,>(
    callback: (webview: BrowserWebviewElement) => T,
    fallback: T,
  ): T => {
    const webview = webviewRef.current;
    if (
      !webviewReadyRef.current
      || !webview
      || webview.tagName.toLowerCase() !== "webview"
    ) return fallback;
    try {
      return callback(webview);
    } catch {
      return fallback;
    }
  }, []);

  const safeCurrentWebviewUrl = useCallback((fallback: string) => (
    safeWebviewCall((webview) => webview.getURL?.() ?? fallback, fallback)
  ), [safeWebviewCall]);

  const updateNavigationState = useCallback(() => {
    setNavigationState({
      canGoBack: safeWebviewCall((webview) => Boolean(webview.canGoBack?.()), false),
      canGoForward: safeWebviewCall((webview) => Boolean(webview.canGoForward?.()), false),
    });
  }, [safeWebviewCall]);

  const applyZoomFactor = useCallback((factor: number) => {
    const applied = safeWebviewCall((webview) => {
      if (!webview.setZoomFactor) return false;
      webview.setZoomFactor(factor);
      return true;
    }, false);
    if (!applied) return;
    zoomFactorRef.current = factor;
    setZoomFactor(factor);
  }, [safeWebviewCall]);

  const stepZoomFactor = useCallback((direction: -1 | 1) => {
    const current = zoomFactorRef.current;
    let currentIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    BROWSER_LIVE_SURFACE_ZOOM_FACTORS.forEach((factor, index) => {
      const distance = Math.abs(factor - current);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        currentIndex = index;
      }
    });
    const nextIndex = Math.max(
      0,
      Math.min(BROWSER_LIVE_SURFACE_ZOOM_FACTORS.length - 1, currentIndex + direction),
    );
    applyZoomFactor(BROWSER_LIVE_SURFACE_ZOOM_FACTORS[nextIndex] ?? 1);
  }, [applyZoomFactor]);

  const executeBrowserShortcut = useCallback((action: BrowserShortcutAction) => {
    if (!active) return;
    switch (action) {
      case "new_tab":
        if (canOpenNewTab) onOpenTarget(createBrowserSidePanelTarget());
        return;
      case "focus_location":
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      case "reload":
        if (!isBlank) safeWebviewCall((webview) => webview.reload?.(), undefined);
        return;
      case "reload_ignoring_cache":
        if (!isBlank) {
          safeWebviewCall((webview) => webview.reloadIgnoringCache?.(), undefined);
        }
        return;
      case "go_back":
        if (!isBlank) {
          safeWebviewCall((webview) => {
            if (webview.canGoBack?.()) webview.goBack?.();
          }, undefined);
        }
        return;
      case "go_forward":
        if (!isBlank) {
          safeWebviewCall((webview) => {
            if (webview.canGoForward?.()) webview.goForward?.();
          }, undefined);
        }
        return;
      case "zoom_in":
        if (!isBlank) stepZoomFactor(1);
        return;
      case "zoom_out":
        if (!isBlank) stepZoomFactor(-1);
        return;
      case "zoom_reset":
        if (!isBlank) applyZoomFactor(1);
    }
  }, [
    active,
    applyZoomFactor,
    canOpenNewTab,
    isBlank,
    onOpenTarget,
    safeWebviewCall,
    stepZoomFactor,
  ]);
  executeBrowserShortcutRef.current = executeBrowserShortcut;

  useEffect(() => {
    onRegisterShortcutController(targetKey, executeBrowserShortcut);
    return () => onRegisterShortcutController(targetKey, null);
  }, [executeBrowserShortcut, onRegisterShortcutController, targetKey]);

  const replaceBrowserTarget = useCallback((
    nextUrl: string,
    nextTitle = browserSidePanelLabel(nextUrl),
  ) => {
    const urlChanged = targetRef.current.url !== nextUrl;
    const nextTarget: Extract<SidePanelTarget, { kind: "browser" }> = {
      ...targetRef.current,
      url: nextUrl,
      label: nextTitle,
      favicon: urlChanged ? undefined : targetRef.current.favicon,
    };
    currentUrlRef.current = nextUrl;
    targetRef.current = nextTarget;
    setCurrentUrl(nextUrl);
    setTitle(nextTitle);
    setAddressValue(nextUrl === BROWSER_SIDE_PANEL_BLANK_URL ? "" : nextUrl);
    targetUrlRef.current = nextUrl;
    onReplaceTargetRef.current(targetKey, nextTarget);
  }, [targetKey]);

  useEffect(() => {
    const externallyChangedUrl = targetUrlRef.current !== target.url;
    targetUrlRef.current = target.url;
    currentUrlRef.current = target.url;
    targetRef.current = target;
    setCurrentUrl(target.url);
    setTitle(target.label);
    setAddressValue(target.url === BROWSER_SIDE_PANEL_BLANK_URL ? "" : target.url);
    if (externallyChangedUrl) {
      setWebviewSrc(target.url);
      setLoadError(null);
      setLoadErrorDetailsOpen(false);
    }
    if (webviewReadyRef.current) updateNavigationState();
    else setNavigationState({ canGoBack: false, canGoForward: false });
  }, [target.label, target.url, updateNavigationState]);

  useEffect(() => {
    const webview = webviewNode;
    if (!webview || webview.tagName.toLowerCase() !== "webview") return undefined;

    const handleStart = () => {
      setLoading(true);
      setLoadError(null);
      setLoadErrorDetailsOpen(false);
    };
    const handleStartNavigation = (event: Event) => {
      const isMainFrame = !("isMainFrame" in event) || event.isMainFrame !== false;
      const nextUrl = "url" in event && typeof event.url === "string" ? event.url : "";
      if (isMainFrame && nextUrl && nextUrl !== currentUrlRef.current) {
        replaceBrowserTarget(nextUrl, browserSidePanelLabel(nextUrl));
      }
    };
    const handleStop = () => {
      setLoading(false);
      const nextUrl = safeCurrentWebviewUrl("");
      if (nextUrl && nextUrl !== currentUrlRef.current) {
        replaceBrowserTarget(nextUrl, browserSidePanelLabel(nextUrl));
      }
      updateNavigationState();
    };
    const handleNavigate = (event: Event) => {
      const nextUrl = "url" in event && typeof event.url === "string"
        ? event.url
        : safeCurrentWebviewUrl("");
      if (nextUrl) {
        replaceBrowserTarget(nextUrl, browserSidePanelLabel(nextUrl));
      }
      updateNavigationState();
    };
    const handleTitle = (event: Event) => {
      const nextUrl = safeCurrentWebviewUrl(currentUrlRef.current);
      const nextTitle = "title" in event && typeof event.title === "string" && event.title.trim()
        ? event.title.trim()
        : browserSidePanelLabel(nextUrl);
      setTitle(nextTitle);
      const nextTarget = { ...targetRef.current, url: nextUrl, label: nextTitle };
      targetRef.current = nextTarget;
      onReplaceTargetRef.current(targetKey, nextTarget);
    };
    const handleFavicon = (event: Event) => {
      const favicons = "favicons" in event && Array.isArray(event.favicons)
        ? event.favicons
        : [];
      const favicon = favicons
        .map(acceptedBrowserFavicon)
        .find((value): value is string => Boolean(value));
      if (!favicon || favicon === targetRef.current.favicon) return;
      const nextTarget = { ...targetRef.current, favicon };
      targetRef.current = nextTarget;
      onReplaceTargetRef.current(targetKey, nextTarget);
    };
    const handleFail = (event: Event) => {
      const errorDescription = "errorDescription" in event
        && typeof event.errorDescription === "string"
        ? event.errorDescription
        : "Could not load this page.";
      const failedUrl = "validatedURL" in event
        && typeof event.validatedURL === "string"
        && event.validatedURL
        ? event.validatedURL
        : currentUrlRef.current;
      const isMainFrame = !("isMainFrame" in event) || event.isMainFrame !== false;
      if (isMainFrame && errorDescription !== "ERR_ABORTED") {
        setLoading(false);
        setLoadError({ code: errorDescription, url: failedUrl });
        setLoadErrorDetailsOpen(false);
      }
      updateNavigationState();
    };
    const handleDomReady = () => {
      webviewReadyRef.current = true;
      const webContentsId = webview.getWebContentsId?.();
      if (typeof webContentsId === "number" && Number.isFinite(webContentsId)) {
        onWebContentsIdChangeRef.current?.(webContentsId);
      }
      if (zoomFactorRef.current !== 1) {
        safeWebviewCall(
          (readyWebview) => readyWebview.setZoomFactor?.(zoomFactorRef.current),
          undefined,
        );
      }
      updateNavigationState();
    };
    const handleBeforeInput = (event: Event) => {
      const inputEvent = event as BrowserWebviewInputEvent;
      const input = inputEvent.input;
      const isCycleTab = input
        && input.type !== "keyUp"
        && (input.key === "Tab" || input.code === "Tab")
        && Boolean(input.control)
        && !input.meta
        && !input.alt;
      if (isCycleTab && activeRef.current && onCycleTabRef.current) {
        event.preventDefault();
        onCycleTabRef.current(input.shift ? -1 : 1);
        return;
      }
      if (readDesktopShell()?.onBrowserShortcut) return;
      if (isBrowserSidePanelCloseShortcutInput(inputEvent.input)) {
        event.preventDefault();
        onCloseTargetRef.current(targetRef.current);
        return;
      }
      if (
        !inputEvent.input
        || !activeRef.current
      ) return;
      const action = resolveBrowserShortcutInput(inputEvent.input, {
        isMac: navigator.platform.toLowerCase().includes("mac"),
      });
      if (!action) return;
      event.preventDefault();
      executeBrowserShortcutRef.current?.(action);
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("before-input-event", handleBeforeInput);
    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-start-navigation", handleStartNavigation);
    webview.addEventListener("did-stop-loading", handleStop);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("page-favicon-updated", handleFavicon);
    webview.addEventListener("did-fail-load", handleFail);
    updateNavigationState();

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("before-input-event", handleBeforeInput);
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-start-navigation", handleStartNavigation);
      webview.removeEventListener("did-stop-loading", handleStop);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("page-favicon-updated", handleFavicon);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [
    replaceBrowserTarget,
    safeCurrentWebviewUrl,
    safeWebviewCall,
    targetKey,
    updateNavigationState,
    webviewNode,
  ]);

  const handleWebviewRef = useCallback((node: BrowserWebviewElement | null) => {
    webviewRef.current = node;
    webviewReadyRef.current = false;
    setWebviewNode(node);
    if (!node) setNavigationState({ canGoBack: false, canGoForward: false });
  }, []);

  useEffect(() => () => {
    onWebContentsIdChangeRef.current?.(null);
  }, []);

  const navigateTo = useCallback((nextValue: string) => {
    const nextUrl = normalizeBrowserSidePanelUrl(nextValue);
    setLoadError(null);
    setLoadErrorDetailsOpen(false);
    setWebviewSrc(nextUrl);
    replaceBrowserTarget(nextUrl, browserSidePanelLabel(nextUrl));
  }, [replaceBrowserTarget]);

  const reloadCurrentPage = useCallback(() => {
    setLoadErrorDetailsOpen(false);
    safeWebviewCall((webview) => {
      webview.reload?.();
    }, undefined);
  }, [safeWebviewCall]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedAddress = formData.get("browser-url");
    navigateTo(typeof submittedAddress === "string" ? submittedAddress : addressValue);
  };

  const openExternal = () => {
    if (isBlank) return;
    const desktopShell = readDesktopShell();
    if (desktopShell) {
      void (
        desktopShell.forceOpenExternal?.(currentUrl)
        ?? desktopShell.openExternal(currentUrl)
      );
      return;
    }
    window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      className="flex min-h-full flex-col bg-[color:var(--surface-elevated)]"
      data-testid={active ? "chat-side-panel-browser-view" : "chat-side-panel-browser-view-hidden"}
      data-browser-tab-id={target.tabId}
      data-active={active ? "true" : "false"}
    >
      <div
        className="flex shrink-0 items-center gap-1 border-b border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2 py-2"
        data-testid="chat-side-panel-browser-toolbar"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          disabled={!navigationState.canGoBack}
          onClick={() => safeWebviewCall((webview) => {
            webview.goBack?.();
          }, undefined)}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Forward"
          disabled={!navigationState.canGoForward}
          onClick={() => safeWebviewCall((webview) => {
            webview.goForward?.();
          }, undefined)}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Reload"
          disabled={isBlank}
          onClick={reloadCurrentPage}
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
          <Input
            ref={addressInputRef}
            aria-label="Browser URL"
            name="browser-url"
            value={addressValue}
            onChange={(event) => setAddressValue(event.currentTarget.value)}
            placeholder="Enter a URL"
            className="h-8 rounded-[var(--radius-md)] bg-[color:var(--surface-inset)] font-mono text-xs"
          />
        </form>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Open new browser tab"
          title={canOpenNewTab ? "Open new browser tab" : "Browser tab limit reached"}
          disabled={!canOpenNewTab}
          onClick={() => onOpenTarget(createBrowserSidePanelTarget())}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Open browser page externally"
          disabled={isBlank}
          onClick={openExternal}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-[color:var(--surface-inset)]">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[color:var(--border-soft)] px-3 text-xs text-muted-foreground">
          {loading
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Globe2 className="h-3.5 w-3.5" />}
          <span className="min-w-0 flex-1 truncate">{isBlank ? "New tab" : title}</span>
          {zoomFactor !== 1 ? (
            <span
              className="shrink-0 tabular-nums"
              data-testid="chat-side-panel-browser-zoom"
            >
              {Math.round(zoomFactor * 100)}%
            </span>
          ) : null}
        </div>
        {isBlank ? (
          <div
            className="flex min-h-[44vh] flex-1 items-center justify-center px-6 text-center"
            data-testid="chat-side-panel-browser-start"
          >
            <div className="max-w-[18rem]">
              <Globe2 className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-base font-semibold text-foreground">Start browsing</h3>
              <p className="mt-2 text-sm text-muted-foreground">Enter a URL to open a page.</p>
            </div>
          </div>
        ) : (
          <div className="relative flex min-h-[52vh] flex-1">
            {createElement("webview", {
              ref: handleWebviewRef,
              src: webviewSrc,
              className: cn(
                "min-h-[52vh] flex-1 bg-[color:var(--surface-elevated)]",
                loadError && "invisible",
              ),
              "data-testid": active
                ? "chat-side-panel-browser-webview"
                : "chat-side-panel-browser-webview-hidden",
              "data-browser-tab-id": target.tabId,
              "data-active": active ? "true" : "false",
              // Lets Electron surface requests to the main-process handler, which
              // always denies native windows before routing approved URLs.
              allowpopups: "true",
            })}
            {loadError ? (
              <div
                role="alert"
                data-testid="chat-side-panel-browser-error"
                className="absolute inset-0 flex overflow-y-auto bg-[color:var(--surface-elevated)] px-8 py-10"
              >
                <div className="m-auto w-full max-w-[32rem]">
                  <FileWarning
                    className="h-12 w-12 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h3 className="mt-6 text-xl font-semibold text-foreground">
                    This site can&apos;t be reached
                  </h3>
                  <p className="mt-4 text-sm text-muted-foreground">
                    {loadErrorContent?.summary}
                  </p>
                  <div className="mt-5 text-sm text-muted-foreground">
                    <p>Try:</p>
                    <ul className="mt-2 list-disc space-y-1 pl-6">
                      {loadErrorContent?.suggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="mt-5 font-mono text-xs text-muted-foreground">
                    {loadError.code}
                  </p>
                  {loadErrorDetailsOpen ? (
                    <p className="mt-4 break-all rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-3 py-2 font-mono text-xs text-muted-foreground">
                      {loadError.url}
                    </p>
                  ) : null}
                  <div className="mt-7 flex items-center justify-between gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={loadErrorDetailsOpen}
                      onClick={() => setLoadErrorDetailsOpen((open) => !open)}
                    >
                      Details
                    </Button>
                    <Button type="button" size="sm" onClick={reloadCurrentPage}>
                      <RotateCw className="h-3.5 w-3.5" />
                      Reload
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
