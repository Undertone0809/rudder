import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const motionCss = readFileSync(new URL("../motion.css", import.meta.url), "utf8");

describe("Motion V1 CSS", () => {
  it("defines reduced-motion fallbacks for repeated product motion", () => {
    expect(motionCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(motionCss).toContain(".motion-live-surface::before");
    expect(motionCss).toContain('.motion-kanban-card[data-live="true"]');
    expect(motionCss).toContain('.motion-org-edge[data-active="true"]');
    expect(motionCss).toContain(".motion-chat-options-pop");
    expect(motionCss).toContain(".motion-chat-composer-menu-pop");
    expect(motionCss).toContain(".motion-organization-menu-pop");
    expect(motionCss).toContain(".motion-rail-active-indicator");
    expect(motionCss).toContain(".motion-context-active-indicator");
    expect(motionCss).toContain("animation: none !important");
    expect(motionCss).toContain("transition: none !important");
  });

  it("defines a visible pop animation for chat option disclosure", () => {
    expect(motionCss).toContain("@keyframes rudder-chat-options-pop");
    expect(motionCss).toContain("var(--chat-options-origin-x");
    expect(motionCss).toContain("scale(0.82)");
    expect(motionCss).toContain("scale(1.035)");
    expect(motionCss).toContain("@keyframes rudder-chat-option-enter");
    expect(motionCss).toContain("[data-chat-option]:nth-child(2)");
  });

  it("defines a focused pop animation for chat composer menus", () => {
    expect(motionCss).toContain("@keyframes rudder-chat-composer-menu-pop");
    expect(motionCss).toContain("@keyframes rudder-chat-composer-menu-item-enter");
    expect(motionCss).toContain("[data-chat-composer-menu-item]");
    expect(motionCss).toContain("clip-path: inset(18% 12% 0 12% round var(--radius-lg))");
    expect(motionCss).toContain("transform-origin: bottom center");
  });

  it("defines sliding active indicators for navigation surfaces", () => {
    expect(motionCss).toContain(".motion-rail-nav");
    expect(motionCss).toContain("--motion-rail-active-index");
    expect(motionCss).toContain(".motion-context-nav");
    expect(motionCss).toContain("--motion-context-active-index");
    expect(motionCss).toContain(".motion-context-nav--agent-list");
    expect(motionCss).toContain(".motion-context-nav--project-card-list");
    expect(motionCss).toContain("transform var(--motion-duration-standard) var(--motion-ease-enter)");
  });

  it("highlights kanban card borders on hover and keyboard focus", () => {
    expect(motionCss).toContain(".motion-kanban-card:is(:hover, :focus-within)");
    expect(motionCss).toContain("border-color: color-mix(in oklab, var(--accent-base) 58%, var(--border))");
    expect(motionCss).toContain("inset 0 0 0 1px color-mix(in oklab, var(--accent-base) 34%, transparent)");
  });

  it("defines a pop animation for organization menu disclosure", () => {
    expect(motionCss).toContain("@keyframes rudder-organization-menu-pop");
    expect(motionCss).toContain("@keyframes rudder-organization-menu-close");
    expect(motionCss).toContain("@keyframes rudder-organization-menu-item-enter");
    expect(motionCss).toContain("[data-org-menu-item]");
    expect(motionCss).toContain("--motion-org-menu-item-delay");
    expect(motionCss).toContain("clip-path: inset(0 16% 100% 0 round var(--radius-md))");
  });
});
