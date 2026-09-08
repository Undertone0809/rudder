// @vitest-environment jsdom

import {
  acknowledgeAppDirectOpen,
  readAppDirectOpenIntent,
  type AppEntry,
} from "@/lib/apps-workspace";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_UI_CSP,
  appEntryStatus,
  appEntryTitle,
  filterAppEntries,
  openAppEntry,
  resolveHubTab,
  sandboxedMcpHtml,
} from "./Plugins";

const managedPreparing = {
  kind: "managed",
  key: "managed:app-preparing",
  app: {
    name: "Operations console",
    sourceRoot: "apps/operations-console",
    buildStatus: "preparing",
  },
  definition: null,
} as unknown as AppEntry;

const localRegistered = {
  kind: "local",
  key: "local:app-local",
  definition: {
    title: "Local review board",
    iconDataUrl: "data:image/svg+xml;base64,AAAA",
  },
} as unknown as AppEntry;

describe("Plugin MCP UI sandbox", () => {
  it("structurally installs the host policy before hostile document content", () => {
    const srcDoc = sandboxedMcpHtml([
      "<!-- <head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"> -->",
      "<html><head><base href=\"https://evil.invalid/\"><script>fetch('/leak')</script></head>",
      "<body><img src=\"https://evil.invalid/pixel\"></body></html>",
    ].join(""));
    const parsed = new DOMParser().parseFromString(srcDoc, "text/html");
    const policies = parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]');

    expect(policies).toHaveLength(1);
    expect(parsed.head.firstElementChild).toBe(policies[0]);
    expect(policies[0]?.getAttribute("content")).toBe(MCP_UI_CSP);
    expect(MCP_UI_CSP).toContain("connect-src 'none'");
    expect(MCP_UI_CSP).toContain("frame-src 'none'");
    expect(MCP_UI_CSP).toContain("form-action 'none'");
    expect(srcDoc).not.toContain("default-src *");
  });
});

describe("Hub Apps catalog helpers", () => {
  it("maps the legacy Showcase tab to the Apps catalog", () => {
    expect(resolveHubTab("showcase")).toBe("apps");
    expect(resolveHubTab("apps")).toBe("apps");
    expect(resolveHubTab("plugins")).toBe("plugins");
    expect(resolveHubTab("unknown")).toBeNull();
  });

  it("filters registered Apps by title, status, and source kind", () => {
    expect(appEntryTitle(managedPreparing)).toBe("Operations console");
    expect(appEntryStatus(managedPreparing)).toBe("Preparing");
    expect(appEntryStatus(localRegistered)).toBe("On this device");
    expect(filterAppEntries([managedPreparing, localRegistered], "preparing")).toEqual([managedPreparing]);
    expect(filterAppEntries([managedPreparing, localRegistered], "local app")).toEqual([localRegistered]);
  });

  it("requests a direct local open before navigating to the registered App route", () => {
    const navigate = vi.fn();
    openAppEntry(localRegistered, "org-1", navigate);

    expect(navigate).toHaveBeenCalledWith("/apps/view/local%3Aapp-local");
    expect(readAppDirectOpenIntent("org-1", localRegistered.key)).toBeGreaterThan(0);

    acknowledgeAppDirectOpen(
      "org-1",
      localRegistered.key,
      readAppDirectOpenIntent("org-1", localRegistered.key),
    );
  });
});
