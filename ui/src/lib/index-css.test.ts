import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const organizationWorkspacesSource = readFileSync(new URL("../pages/OrganizationWorkspaces.tsx", import.meta.url), "utf8");

function cssBlock(selector: string) {
  const start = indexCss.indexOf(selector);
  if (start === -1) return "";

  const firstBrace = indexCss.indexOf("{", start);
  if (firstBrace === -1) return "";

  let depth = 0;
  for (let index = firstBrace; index < indexCss.length; index += 1) {
    const char = indexCss[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return indexCss.slice(firstBrace + 1, index);
  }

  return "";
}

describe("index.css motion rules", () => {
  it("keeps editor issue done mentions as a two-layer status icon", () => {
    const doneStatusBlock = cssBlock('.rudder-mention-chip--with-status-icon[data-mention-status="done"]');
    const doneCircleMaskLine =
      doneStatusBlock.split("\n").find((line) => /^\s*--rudder-mention-status-mask:/.test(line)) ?? "";
    const doneCheckBlock =
      indexCss.match(/\.rudder-mdxeditor-content \.rudder-mention-chip--with-status-icon\[data-mention-kind="issue"]\[data-mention-status="done"]::after,[\s\S]*?\n\}/)?.[0] ?? "";

    expect(doneStatusBlock).toContain("--rudder-mention-status-color: #16a34a");
    expect(doneStatusBlock).toContain("--rudder-mention-status-check-color: var(--background)");
    expect(doneCircleMaskLine).toContain("%3Ccircle");
    expect(doneCircleMaskLine).not.toContain("%3Cpath");
    expect(doneStatusBlock).toContain("M4.75 8.25 7 10.5l4.25-5");
    expect(doneCheckBlock).toContain("background: var(--rudder-mention-status-check-color, var(--background))");
    expect(doneCheckBlock).toContain("--rudder-mention-status-check-mask");
    expect(indexCss).toContain('.rudder-markdown a.rudder-mention-chip--with-status-icon[data-mention-kind="issue"][data-mention-status="done"]::after');
  });

  it("keeps command palette visible and avoids duplicate centering transforms", () => {
    const commandPaletteContent = cssBlock(".command-palette-content");
    const commandPaletteOpen = cssBlock('.command-palette-content[data-state="open"]');
    const desktopEnter = cssBlock("@keyframes command-palette-enter");
    const desktopExit = cssBlock("@keyframes command-palette-exit");
    const mobileEnter = cssBlock("@keyframes command-palette-enter-mobile");
    const mobileExit = cssBlock("@keyframes command-palette-exit-mobile");
    const commandPaletteMotion = [
      commandPaletteContent,
      desktopEnter,
      desktopExit,
      mobileEnter,
      mobileExit,
    ].join("\n");

    expect(commandPaletteContent).toContain("will-change: opacity, transform");
    expect(commandPaletteOpen).toContain("opacity: 1 !important");
    expect(commandPaletteOpen).toContain("animation: none !important");
    expect(commandPaletteMotion).not.toContain("filter:");
    expect(commandPaletteMotion).not.toContain("backdrop-filter");
    expect(commandPaletteMotion).not.toContain("scale(");
    expect(commandPaletteMotion).not.toContain("translate(-50%");
  });

  it("positions command palette against the viewport", () => {
    const commandPaletteContent = cssBlock(".command-palette-content");
    const commandPaletteDesktopPositioning =
      indexCss.match(/@media \(min-width: 768px\) \{\s*\[data-slot="dialog-content"\]\.command-palette-content \{[^}]+}/)?.[0] ?? "";

    expect(commandPaletteContent).toContain("left: 50vw !important");
    expect(commandPaletteContent).toContain("position: relative");
    expect(commandPaletteContent).toContain("isolation: isolate");
    expect(commandPaletteDesktopPositioning).toContain("top: 50vh !important");
  });

  it("animates the command palette panel boundary while searching", () => {
    const searchRing = cssBlock(".command-palette-content--searching::before");
    const searchHalo = cssBlock(".command-palette-content--searching::after");
    const keyframes = cssBlock("@keyframes command-palette-search-ring");
    const reducedMotion =
      indexCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.command-palette-content--searching::before[\s\S]*?\n\s*\}/)?.[0] ?? "";

    expect(indexCss).toContain("@property --command-palette-search-angle");
    expect(searchRing).toContain("conic-gradient");
    expect(searchRing).toContain("from var(--command-palette-search-angle)");
    expect(searchRing).toContain("z-index: 0");
    expect(searchRing).toContain("border-radius: inherit");
    expect(searchRing).not.toContain("mask-composite");
    expect(searchRing).not.toContain("border-image:");
    expect(searchRing).toContain("animation: command-palette-search-ring 1.35s linear infinite");
    expect(searchRing).toContain("pointer-events: none");
    expect(searchHalo).toContain("inset: var(--active-surface-ring-width)");
    expect(searchHalo).toContain("border-radius: var(--active-surface-ring-inner-radius)");
    expect(searchHalo).toContain("background: var(--active-surface-ring-cover)");
    expect(indexCss).toContain("--active-surface-ring-inner-radius: calc(var(--radius-md) - var(--active-surface-ring-width))");
    expect(indexCss).toContain("var(--surface-overlay) 96%");
    expect(searchHalo).not.toContain("background: inherit");
    expect(searchHalo).toContain("opacity: 1");
    expect(searchHalo).toContain("box-shadow:");
    expect(keyframes).toContain("--command-palette-search-angle: 360deg");
    expect(reducedMotion).toContain("animation: none");
  });

  it("reuses the rounded boundary animation for active chat and processing surfaces", () => {
    const activeSurface = cssBlock(".active-surface-ring,");
    const sharedRing = cssBlock(".active-surface-ring::before");
    const sharedHalo = cssBlock(".active-surface-ring::after");
    const reducedMotion =
      indexCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.active-surface-ring::before[\s\S]*?\n\s*\}/)?.[0] ?? "";

    expect(activeSurface).toContain("position: relative");
    expect(activeSurface).toContain("isolation: isolate");
    expect(sharedRing).toContain("conic-gradient");
    expect(sharedRing).toContain("from var(--command-palette-search-angle)");
    expect(sharedRing).toContain("z-index: 0");
    expect(sharedRing).toContain("border-radius: inherit");
    expect(sharedRing).not.toContain("mask-composite");
    expect(sharedRing).not.toContain("border-image:");
    expect(sharedRing).toContain("animation: command-palette-search-ring 1.35s linear infinite");
    expect(sharedRing).toContain("pointer-events: none");
    expect(sharedHalo).toContain("inset: var(--active-surface-ring-width)");
    expect(sharedHalo).toContain("border-radius: var(--active-surface-ring-inner-radius)");
    expect(sharedHalo).toContain("background: var(--active-surface-ring-cover)");
    expect(indexCss).toContain("--active-surface-ring-cover:");
    expect(sharedHalo).not.toContain("background: inherit");
    expect(sharedHalo).toContain("opacity: 1");
    expect(sharedHalo).toContain("box-shadow:");
    expect(reducedMotion).toContain("animation: none");
  });

  it("keeps the chat composer streaming ring integrated with the input surface", () => {
    const composerStreaming =
      indexCss.match(/\n\s*\.chat-composer\.chat-composer--streaming \{\s*\n\s*--active-surface-ring-width: 1px;[\s\S]*?\n\s*\}/)?.[0] ?? "";
    const composerRing =
      indexCss.match(/\n\s*\.chat-composer--streaming::before \{\s*\n\s*inset: -1px;[\s\S]*?\n\s*\}/)?.[0] ?? "";

    expect(composerStreaming).toContain("--active-surface-ring-width: 1px");
    expect(composerStreaming).toContain("border-color: color-mix(in oklab, var(--ring) 42%, var(--border-base))");
    expect(composerStreaming).toContain("var(--surface-elevated) 99%");
    expect(composerStreaming).toContain("inset 0 1px 0");
    expect(composerRing).toContain("inset: -1px");
    expect(composerRing).toContain("opacity: 0.74");
    expect(composerRing).toContain("var(--ring) 54%");
    expect(composerRing).not.toContain("var(--ring) 90%");
  });

  it("keeps entity preview metadata labels centered with their value icons", () => {
    const previewRow =
      indexCss.match(/\.rudder-entity-preview-row \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(previewRow).toContain("align-items: center");
    expect(previewRow).not.toContain("align-items: baseline");
  });

  it("keeps issue comment hover previews tall, scrollable, and image-aware", () => {
    const previewCard = cssBlock(".rudder-entity-preview-card");
    const previewArrow = cssBlock(".rudder-entity-preview-card .rudder-tooltip-arrow");
    const commentBody = cssBlock(".rudder-entity-preview-comment-body");
    const commentImage = cssBlock(".rudder-entity-preview-comment-body :where(img)");

    expect(previewCard).toContain("width: min(32rem, calc(100vw - 2rem))");
    expect(previewCard).toContain("max-height: min(32rem, calc(100vh - 3rem))");
    expect(previewArrow).toContain("background:");
    expect(previewArrow).toContain("fill:");
    expect(commentBody).toContain("max-height: min(24rem, calc(100vh - 10rem))");
    expect(commentBody).toContain("overflow-y: auto");
    expect(commentImage).toContain("object-fit: contain");
    expect(commentImage).toContain("max-height: 11rem");
  });

  it("keeps markdown website link icons attached to their labels", () => {
    const websiteLink = cssBlock(".rudder-markdown a.rudder-website-link");
    const websiteLinkIcon = cssBlock(".rudder-website-link-icon");
    const websiteLinkLabel = cssBlock(".rudder-website-link-label");

    expect(websiteLink).toContain("display: inline-flex");
    expect(websiteLink).toContain("align-items: baseline");
    expect(websiteLink).toContain("gap: 0.24em");
    expect(websiteLink).toContain("max-width: 100%");
    expect(websiteLink).toContain("overflow-wrap: normal");
    expect(websiteLinkIcon).toContain("flex: 0 0 auto");
    expect(websiteLinkIcon).not.toContain("margin-right");
    expect(websiteLinkLabel).toContain("min-width: 0");
    expect(websiteLinkLabel).toContain("overflow-wrap: anywhere");
  });

  it("keeps entity and skill hover card text readable instead of single-line clipped", () => {
    const skillHoverCard = cssBlock(".rudder-skill-hover-card");
    const rowValue = cssBlock(".rudder-entity-preview-row-value");
    const rowValueText = cssBlock(".rudder-entity-preview-row-value-text");
    const previewCard = cssBlock(".rudder-entity-preview-card");
    const summary =
      indexCss.match(/\n\.rudder-entity-preview-summary \{[^}]*overflow-y: auto[^}]*\n\}/)?.[0] ?? "";
    const summaryLinks = cssBlock(".rudder-entity-preview-summary :where(a)");

    expect(previewCard).toContain("background: var(--popover)");
    expect(previewCard).toContain("isolation: isolate");
    expect(skillHoverCard).toContain("width: min(24rem, calc(100vw - 2rem))");
    expect(skillHoverCard).toContain("overflow-y: auto");
    expect(skillHoverCard).toContain("overflow-wrap: anywhere");
    expect(rowValue).toContain("white-space: normal");
    expect(rowValueText).toContain("overflow-wrap: anywhere");
    expect(rowValueText).toContain("-webkit-line-clamp: 2");
    expect(summary).toContain("overflow-y: auto");
    expect(summary).toContain("overflow-wrap: anywhere");
    expect(summary).toContain("background:");
    expect(summary).toContain("border:");
    expect(summaryLinks).toContain("color: var(--rudder-doc-link)");
    expect(summary).not.toContain("-webkit-line-clamp");
  });

  it("keeps glass popovers above utility backgrounds", () => {
    const glassPopover = cssBlock(".glass-popover.glass-popover");

    expect(glassPopover).toContain("background:");
    expect(glassPopover).toContain("!important");
    expect(glassPopover).toContain("border-radius: var(--radius-md)");
    expect(glassPopover).toContain("backdrop-filter: blur(34px) saturate(150%)");
  });

  it("uses glass surfaces for modals", () => {
    const glassModal = cssBlock(".glass-modal.glass-modal");

    expect(glassModal).toContain("background:");
    expect(glassModal).toContain("!important");
    expect(glassModal).toContain("border-radius: var(--radius-md)");
    expect(glassModal).toContain("var(--surface-overlay) 78%");
    expect(glassModal).toContain("var(--surface-overlay) 68%");
    expect(glassModal).toContain("backdrop-filter: blur(34px) saturate(150%)");
  });

  it("animates automation trigger menus from the trigger", () => {
    const triggerMenuOpen = cssBlock('.automation-trigger-menu-content[data-state="open"]');
    const triggerMenuEnter = cssBlock("@keyframes automation-trigger-menu-pop");
    const reducedMotion = indexCss.match(/@media \(prefers-reduced-motion: reduce\) \{[^}]+automation-trigger-menu-content\[data-state="closed"\][^}]+}/s)?.[0] ?? "";

    expect(triggerMenuOpen).toContain("automation-trigger-menu-pop 180ms");
    expect(triggerMenuEnter).toContain("translateX(10px)");
    expect(triggerMenuEnter).toContain("scale(0.94)");
    expect(reducedMotion).toContain(".automation-trigger-menu-content[data-state=\"open\"]");
  });

  it("keeps the macOS desktop shell translucent in light mode", () => {
    const lightDesktopBackdrop = cssBlock("html.desktop-shell-macos .app-shell-backdrop");

    expect(lightDesktopBackdrop).toContain("rgb(250 248 245 / 0.34)");
    expect(lightDesktopBackdrop).toContain("rgb(244 240 234 / 0.22)");
    expect(lightDesktopBackdrop).toContain("backdrop-filter: blur(38px) saturate(122%)");
  });

  it("keeps macOS desktop glass on shell layers while workspace cards stay paper-like", () => {
    const lightDesktopBackdrop = cssBlock("html.desktop-shell-macos .app-shell-backdrop");
    const darkDesktopBackdrop = cssBlock("html.dark.desktop-shell-macos .app-shell-backdrop");
    const lightPrimaryRail = cssBlock("html.desktop-shell-macos .primary-rail-shell");
    const lightWorkspaceShell = cssBlock("html.desktop-shell-macos .workspace-shell");
    const lightDesktopWorkspaceCards = cssBlock("html.desktop-shell-macos :is(.workspace-context-card, .workspace-main-card)");
    const darkDesktopWorkspaceCards = cssBlock("html.dark.desktop-shell-macos :is(.workspace-context-card, .workspace-main-card)");
    const lightDesktopWorkspaceHeader = cssBlock("html.desktop-shell-macos :is(.workspace-context-header, .workspace-main-header)");
    const darkDesktopWorkspaceHeader = cssBlock("html.dark.desktop-shell-macos :is(.workspace-context-header, .workspace-main-header)");

    expect(lightDesktopBackdrop).toContain("backdrop-filter: blur(38px) saturate(122%)");
    expect(darkDesktopBackdrop).toContain("backdrop-filter: blur(38px) saturate(138%)");
    expect(lightPrimaryRail).toContain("backdrop-filter: blur(22px) saturate(112%)");
    expect(lightWorkspaceShell).toContain("rgb(249 247 244 / 0.08)");
    expect(lightWorkspaceShell).toContain("rgb(243 239 234 / 0.03)");

    expect(lightDesktopWorkspaceCards).toContain("background: var(--desktop-content-surface-light)");
    expect(darkDesktopWorkspaceCards).toContain("background: var(--desktop-content-surface-dark)");
    expect(lightDesktopWorkspaceCards).not.toContain("backdrop-filter");
    expect(darkDesktopWorkspaceCards).not.toContain("backdrop-filter");
    expect(lightDesktopWorkspaceHeader).toContain("background: var(--desktop-content-surface-light)");
    expect(darkDesktopWorkspaceHeader).toContain("background: var(--desktop-content-surface-dark)");
    expect(lightDesktopWorkspaceHeader).not.toContain("rgb(250 247 242 / 0.58)");
    expect(darkDesktopWorkspaceHeader).not.toContain("rgb(31 31 29 / 0.54)");
  });

  it("keeps frameless Library work surfaces transparent over the desktop shell", () => {
    const framelessWorkspaceCard = cssBlock(".workspace-main-card--frameless");

    expect(framelessWorkspaceCard).toContain("background: transparent");
    expect(framelessWorkspaceCard).toContain("box-shadow: none");
  });

  it("removes the extra desktop shell wash behind the Library workspace", () => {
    const libraryWorkspaceShell = cssBlock("html.desktop-shell-macos .workspace-shell--library-transparent");

    expect(indexCss).toContain("html.dark.desktop-shell-macos .workspace-shell--library-transparent");
    expect(libraryWorkspaceShell).toContain("background: transparent");
  });

  it("keeps the macOS desktop shell top chrome compact", () => {
    const rootTokens = cssBlock(":root");

    expect(rootTokens).toContain("--desktop-titlebar-top-gap: 0.625rem");
    expect(rootTokens).toContain("--desktop-sidebar-top-clearance: 2.125rem");
    expect(rootTokens).toContain("--desktop-content-top-gap: 0.375rem");
  });

  it("keeps desktop workspace shell and work-card corners aligned", () => {
    const rootTokens = cssBlock(":root");
    const workspaceShell = cssBlock(".workspace-shell");
    const workspaceCards = cssBlock(".workspace-context-card,\n  .workspace-main-card");

    expect(rootTokens).toContain("--desktop-workspace-radius: calc(var(--radius-sm) - 1px)");
    expect(workspaceShell).toContain("border-radius: var(--desktop-workspace-radius)");
    expect(workspaceCards).toContain("border-radius: var(--desktop-workspace-radius)");
  });

  it("keeps dashboard run previews compact even when transcripts contain markdown headings", () => {
    const previewMarkdown = cssBlock(".dashboard-run-preview .rudder-markdown");
    const previewHeadings = cssBlock(".dashboard-run-preview .rudder-markdown :where(h1, h2, h3, h4, h5, h6)");

    expect(previewMarkdown).toContain("font-size: 0.75rem");
    expect(previewMarkdown).toContain("line-height: 1.38");
    expect(previewMarkdown).toContain("overflow-wrap: anywhere");
    expect(previewHeadings).toContain("font-size: 0.75rem !important");
    expect(previewHeadings).toContain("letter-spacing: 0");
  });

  it("scopes Library file-tab window dragging to the macOS desktop shell", () => {
    const tabStripSpacer = cssBlock("html.desktop-shell-macos .rudder-doc-editor-tab-drag-spacer");
    const fileTab = cssBlock("html.desktop-shell-macos .rudder-doc-editor-tab--desktop-no-drag");

    expect(tabStripSpacer).toContain("-webkit-app-region: drag");
    expect(fileTab).toContain("-webkit-app-region: no-drag");
    expect(indexCss).not.toMatch(/^\s*\.rudder-doc-editor-tab-strip--desktop-chrome\s*\{\s*-webkit-app-region:\s*drag/m);
    expect(indexCss).not.toMatch(/^\s*html\.desktop-shell-macos\s+\.rudder-doc-editor-tab-strip--desktop-chrome\s*\{\s*-webkit-app-region:\s*drag/m);
  });

  it("keeps the Library file-tab horizontal scrollbar compact", () => {
    const tabScrollerScrollbar = cssBlock(".rudder-doc-editor-tab-scroller::-webkit-scrollbar");

    expect(tabScrollerScrollbar).toContain("height: 4px !important");
  });

  it("keeps Library file-tab chrome and sidebar dividers aligned", () => {
    const editorSurface = cssBlock(".rudder-doc-editor-surface");
    const tabStrip = cssBlock(".rudder-doc-editor-tab-strip");
    const sidebarHeader = cssBlock(".rudder-doc-editor-sidebar-header");
    const sidebarBreadcrumbOnly = cssBlock(".rudder-doc-editor-sidebar-header--breadcrumb-only");
    const sidebarTabsOnly = cssBlock(".rudder-doc-editor-sidebar-header--tabs-only");
    const sidebarTabsAndBreadcrumb = cssBlock(".rudder-doc-editor-sidebar-header--tabs-and-breadcrumb");
    const sidebarChromeStates = cssBlock(".rudder-doc-editor-sidebar-header--breadcrumb-only,\n.rudder-doc-editor-sidebar-header--tabs-only,\n.rudder-doc-editor-sidebar-header--tabs-and-breadcrumb");
    const activeTabCorners = cssBlock(".rudder-doc-editor-tab--active::before,\n.rudder-doc-editor-tab--active::after");

    expect(editorSurface).toContain("--rudder-doc-editor-tab-strip-height: 53px");
    expect(editorSurface).toContain("--rudder-doc-editor-breadcrumb-height: 32px");
    expect(sidebarHeader).toContain("--rudder-doc-editor-tab-strip-height: 53px");
    expect(sidebarHeader).toContain("--rudder-doc-editor-breadcrumb-height: 32px");
    expect(sidebarHeader).toContain("--rudder-doc-editor-sidebar-header-height: calc(var(--rudder-doc-editor-tab-strip-height) - 1px)");
    expect(sidebarHeader).toContain("height: var(--rudder-doc-editor-sidebar-header-height)");
    expect(sidebarBreadcrumbOnly).toContain("--rudder-doc-editor-sidebar-header-height: var(--rudder-doc-editor-breadcrumb-height)");
    expect(sidebarTabsOnly).toContain("--rudder-doc-editor-sidebar-header-height: var(--rudder-doc-editor-tab-strip-height)");
    expect(sidebarTabsAndBreadcrumb).toContain("--rudder-doc-editor-sidebar-header-height: calc(var(--rudder-doc-editor-tab-strip-height) - 1px)");
    expect(sidebarChromeStates).toContain("align-items: flex-start");
    expect(sidebarChromeStates).toContain("padding-top: calc((var(--rudder-doc-editor-sidebar-header-content-height) - 28px) / 2)");
    expect(tabStrip).toContain("--rudder-doc-editor-tab-active-height: calc(var(--rudder-doc-editor-tab-strip-height) - 1px)");
    expect(tabStrip).toContain("--rudder-doc-editor-tab-inactive-height: 38px");
    expect(tabStrip).toContain("--rudder-doc-editor-tab-hover-bg: color-mix(in oklab, var(--surface-active) 86%, var(--foreground) 10%)");
    expect(tabStrip).toContain("--rudder-doc-editor-tab-radius: var(--desktop-workspace-radius)");
    expect(tabStrip).toContain("--rudder-doc-editor-tab-corner-size: calc(var(--rudder-doc-editor-tab-radius) * 2)");
    expect(activeTabCorners).toContain("width: var(--rudder-doc-editor-tab-corner-size)");
    expect(indexCss).toContain("border-bottom-right-radius: var(--rudder-doc-editor-tab-corner-size)");
    expect(indexCss).toContain("border-bottom-left-radius: var(--rudder-doc-editor-tab-corner-size)");
    const tabStripClassMatch = organizationWorkspacesSource.match(/data-testid="org-workspaces-editor-tabs"[\s\S]{0,220}className="([^"]+)"/);
    const tabStripClassTokens = tabStripClassMatch?.[1]?.split(/\s+/) ?? [];

    expect(organizationWorkspacesSource).toContain("rudder-doc-editor-surface flex min-h-[420px]");
    expect(organizationWorkspacesSource).toContain("h-[var(--rudder-doc-editor-tab-strip-height)]");
    expect(organizationWorkspacesSource).toContain("workspace-context-header rudder-doc-editor-sidebar-header desktop-chrome flex shrink-0");
    expect(organizationWorkspacesSource).toContain("sidebarHasTabStrip && !sidebarHasBreadcrumb && \"rudder-doc-editor-sidebar-header--tabs-only\"");
    expect(organizationWorkspacesSource).toContain("!sidebarHasTabStrip && sidebarHasBreadcrumb && \"rudder-doc-editor-sidebar-header--breadcrumb-only\"");
    expect(organizationWorkspacesSource).toContain("sidebarHasTabStrip && sidebarHasBreadcrumb && \"rudder-doc-editor-sidebar-header--tabs-and-breadcrumb\"");
    expect(organizationWorkspacesSource).toContain("flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border transition-colors");
    expect(tabStripClassTokens).toContain("rounded-tr-[var(--radius-lg)]");
    expect(tabStripClassTokens).toContain("border-r");
    expect(tabStripClassTokens).toContain("border-[color:var(--border-base)]");
    expect(tabStripClassTokens).toContain("bg-transparent");
    expect(tabStripClassTokens).not.toContain("border-t");
    expect(organizationWorkspacesSource).not.toContain("rounded-tr-[var(--desktop-workspace-radius)] border-r border-t border-[color:var(--border-base)]");
    expect(organizationWorkspacesSource).toContain("h-[var(--rudder-doc-editor-tab-active-height)]");
    expect(organizationWorkspacesSource).toContain("h-[var(--rudder-doc-editor-tab-inactive-height)]");
    expect(organizationWorkspacesSource).toContain("mb-2 h-[var(--rudder-doc-editor-tab-inactive-height)]");
    expect(organizationWorkspacesSource).toContain("hover:bg-[color:var(--rudder-doc-editor-tab-hover-bg)]");
    expect(organizationWorkspacesSource).toContain("rudder-doc-editor-tab-drag-spacer mb-2 h-9");
    expect(organizationWorkspacesSource).toContain("rounded-t-[var(--rudder-doc-editor-tab-radius)]");
    expect(organizationWorkspacesSource).toContain("rounded-[var(--rudder-doc-editor-tab-radius)]");
    expect(organizationWorkspacesSource).toMatch(/data-testid="org-workspaces-path-breadcrumb"[\s\S]{0,260}className="[^"]*h-\[var\(--rudder-doc-editor-breadcrumb-height\)\]/);
    expect(organizationWorkspacesSource).toMatch(/data-testid="org-workspaces-path-breadcrumb"[\s\S]{0,260}className="[^"]*\bborder-x\b[^"]*\bborder-b\b[^"]*border-\[color:var\(--border-base\)\]/);
    expect(organizationWorkspacesSource).not.toContain("showWorkspaceFileTabs && \"rounded-tr-[var(--desktop-workspace-radius)] border-t\"");
    expect(organizationWorkspacesSource).toContain("const showWorkspaceFileTabs = openFilePaths.length > 0");
    expect(organizationWorkspacesSource).toMatch(/\{showWorkspaceFileTabs \? \([\s\S]{0,240}data-testid="org-workspaces-editor-tabs"/);
    expect(organizationWorkspacesSource).toMatch(/data-testid="org-workspaces-editor-content"[\s\S]{0,260}className=\{cn\([\s\S]{0,240}\bborder-x\b[\s\S]{0,80}\bborder-b\b[\s\S]{0,120}border-\[color:var\(--border-base\)\]/);
    expect(organizationWorkspacesSource).toContain("!showWorkspaceFileTabs && visibleWorkspaceBreadcrumbPath === null && \"rounded-[var(--desktop-workspace-radius)] border-t\"");
    expect(organizationWorkspacesSource).not.toContain("workspace-card-header");
    expect(organizationWorkspacesSource).not.toMatch(/rudder-doc-editor-tab--active[^\n]*rounded-t-\[24px]/);
    expect(organizationWorkspacesSource).not.toMatch(/mb-1 h-9[^\n]*rounded-\[18px]/);
  });
});
