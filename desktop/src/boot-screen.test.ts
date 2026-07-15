import { describe, expect, it } from "vitest";
import { createBootScreenHtml, createRendererRecoveryScreenHtml } from "./boot-screen.js";

const BRAND_ICON = "data:image/png;base64,c2FmZS1icmFuZC1pY29u";

describe("desktop boot screen", () => {
  it("renders healthy startup as icon-only motion with failure UI hidden", () => {
    const html = createBootScreenHtml("Rudder", BRAND_ICON, {
      view: "loading",
      stage: "database",
      runtime: { profile: "prod_local", instance: "default", version: "0.4.6" },
      instanceRoot: "/Users/alice/.rudder/instances/default",
    });

    expect(html).toContain('data-boot-view="loading"');
    expect(html).toContain('id="boot-shell" aria-busy="true"');
    expect(html).toContain('id="loading-view" aria-hidden="true">');
    expect(html).toContain('id="failure-sheet" role="alert" aria-labelledby="failure-title" hidden');
    expect(html).toContain("Rudder is opening.");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("correct-course");
    expect(html).not.toContain("Starting local Rudder services");
    expect(html).not.toContain("phase-label");
    expect(html).not.toContain("configPath");
    expect(html).not.toContain("envPath");
    expect(html).not.toContain("window.desktopShell");
  });

  it("server-renders startup failure without flashing the healthy state", () => {
    const html = createBootScreenHtml("Rudder", BRAND_ICON, {
      view: "failed",
      stage: "database",
      failure: {
        id: "failure-123",
        occurredAt: "2026-07-15T10:00:00.000Z",
        attempt: 2,
        category: "migration",
        summary: "The local database could not finish its migration.",
      },
      runtime: { profile: "prod_local", instance: "default", version: "0.4.6" },
      instanceRoot: "/Users/alice/.rudder/instances/default",
    });

    expect(html).toContain('data-boot-view="failed"');
    expect(html).toContain('id="boot-shell" aria-busy="false"');
    expect(html).toContain('id="loading-view" aria-hidden="true" hidden');
    expect(html).toContain('id="failure-sheet" role="alert" aria-labelledby="failure-title">');
    expect(html).toContain("Try again");
    expect(html).toContain("Email support");
    expect(html).toContain("What you were trying to do.");
    expect(html).toContain("Do not attach .env, config.json, databases");
    expect(html).toContain("Technical details");
    expect(html).toContain("window.rudderBoot.retryStartup()");
    expect(html).toContain("window.rudderBoot.openSupportDraft()");
    expect(html).not.toContain("secret-token");
  });
});

describe("renderer recovery screen", () => {
  it("renders recovery actions and escapes diagnostic text", () => {
    const html = createRendererRecoveryScreenHtml("Rudder", {
      title: "Renderer exited",
      message: "Rudder's UI process exited unexpectedly.",
      detail: "<script>alert('x')</script>",
    });

    expect(html).toContain("Reload UI");
    expect(html).toContain("Restart Rudder");
    expect(html).toContain("Copy diagnostic");
    expect(html).toContain("window.desktopShell.reloadApp()");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('x')</script>");
  });
});
