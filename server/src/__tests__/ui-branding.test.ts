import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
} from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
    <!-- RUDDER_RUNTIME_BRANDING_START -->
    <!-- RUDDER_RUNTIME_BRANDING_END -->
    <!-- RUDDER_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- RUDDER_FAVICON_END -->
</head>`;

describe("ui branding", () => {
  it("detects worktree mode from RUDDER_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ RUDDER_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ RUDDER_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ RUDDER_IN_WORKTREE: "false" })).toBe(false);
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      RUDDER_IN_WORKTREE: "true",
      RUDDER_WORKTREE_NAME: "rudder-pr-432",
      RUDDER_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("rudder-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        RUDDER_IN_WORKTREE: "true",
        RUDDER_WORKTREE_NAME: "rudder-pr-432",
        RUDDER_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        RUDDER_IN_WORKTREE: "true",
        RUDDER_WORKTREE_NAME: "rudder-pr-432",
        RUDDER_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="rudder-worktree-name"');
    expect(meta).toContain('content="rudder-pr-432"');
    expect(meta).toContain('name="rudder-worktree-color"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      RUDDER_IN_WORKTREE: "true",
      RUDDER_WORKTREE_NAME: "rudder-pr-432",
      RUDDER_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="rudder-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="rudder-worktree-name"');
  });

  it("uses the dev favicon set for the local dev profile", () => {
    const branded = applyUiBranding(TEMPLATE, {
      RUDDER_LOCAL_ENV: "dev",
    });

    expect(branded).toContain('href="/favicon-dev.ico"');
    expect(branded).toContain('href="/favicon-dev-32x32.png"');
    expect(branded).toContain('href="/favicon-dev-16x16.png"');
    expect(branded).not.toContain('href="/favicon.svg"');
    expect(branded).not.toContain('name="rudder-worktree-name"');
  });

  it("keeps worktree branding ahead of the local dev favicon override", () => {
    const branded = applyUiBranding(TEMPLATE, {
      RUDDER_IN_WORKTREE: "true",
      RUDDER_WORKTREE_NAME: "rudder-pr-432",
      RUDDER_WORKTREE_COLOR: "#4f86f7",
      RUDDER_LOCAL_ENV: "dev",
    });

    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).not.toContain('href="/favicon-dev.ico"');
  });
});
