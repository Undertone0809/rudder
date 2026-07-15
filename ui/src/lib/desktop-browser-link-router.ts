import type { InstanceBrowserSettings } from "@rudderhq/shared";
import { createBrowserSidePanelTarget } from "./browser-side-panel";
import type { DesktopWebLinkRequest } from "./desktop-shell";
import type { SidePanelTarget } from "./side-panel-targets";

function browserRoutableProtocol(value: string): "web" | "file" | null {
  try {
    const protocol = new URL(value).protocol;
    if (protocol === "http:" || protocol === "https:") return "web";
    if (protocol === "file:") return "file";
    return null;
  } catch {
    return null;
  }
}

export async function routeDesktopWebLink(options: {
  request: DesktopWebLinkRequest;
  getSettings(): Promise<InstanceBrowserSettings>;
  openBuiltIn(target: SidePanelTarget): void;
  forceOpenExternal(url: string): void | Promise<void>;
}): Promise<"built_in" | "default_browser" | "ignored"> {
  const { request } = options;
  const protocol = browserRoutableProtocol(request.url);
  if (!protocol) return "ignored";

  if (request.source === "browser_popup") {
    options.openBuiltIn(createBrowserSidePanelTarget(request.url, { newTab: true }));
    return "built_in";
  }

  let settings: InstanceBrowserSettings;
  try {
    settings = await options.getSettings();
  } catch {
    if (protocol === "file") return "ignored";
    await options.forceOpenExternal(request.url);
    return "default_browser";
  }

  if (settings.openLinksIn === "built_in" || protocol === "file") {
    options.openBuiltIn(createBrowserSidePanelTarget(request.url, {
      newTab: false,
    }));
    return "built_in";
  }

  await options.forceOpenExternal(request.url);
  return "default_browser";
}
