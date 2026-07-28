import type { InstanceBrowserSettings } from "@rudderhq/shared";
import { createBrowserSidePanelTarget } from "./browser-side-panel";
import type { DesktopWebLinkRequest } from "./desktop-shell";
import type { SidePanelTarget } from "./side-panel-targets";

function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function routeDesktopWebLink(options: {
  request: DesktopWebLinkRequest;
  getSettings(): Promise<InstanceBrowserSettings>;
  openBuiltIn(target: SidePanelTarget): void;
  forceOpenExternal(url: string): void | Promise<void>;
  resolveFavicon?(url: string): string | null;
}): Promise<"built_in" | "default_browser" | "ignored"> {
  const { request } = options;
  if (!isWebUrl(request.url)) return "ignored";

  let settings: InstanceBrowserSettings;
  try {
    settings = await options.getSettings();
  } catch {
    await options.forceOpenExternal(request.url);
    return "default_browser";
  }

  if (settings.openLinksIn === "built_in" || request.source === "browser_popup") {
    options.openBuiltIn(createBrowserSidePanelTarget(request.url, {
      favicon: options.resolveFavicon?.(request.url),
      newTab: request.source === "browser_popup",
    }));
    return "built_in";
  }

  await options.forceOpenExternal(request.url);
  return "default_browser";
}
