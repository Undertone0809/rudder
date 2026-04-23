import { describe, expect, it } from "vitest";
import { sidebarItemVariants } from "./sidebarItemStyles";

describe("sidebarItemVariants", () => {
  it("returns the default inactive style with rounded hover treatment", () => {
    const classes = sidebarItemVariants({ variant: "default", active: false });

    expect(classes).toContain("rounded-[calc(var(--radius-sm)-1px)]");
    expect(classes).toContain("border-transparent");
    expect(classes).toContain("px-3");
    expect(classes).toContain("py-2.5");
    expect(classes).toContain("hover:bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)]");
    expect(classes).toContain("hover:border-[color:var(--border-soft)]");
    expect(classes).not.toContain("shadow-[var(--shadow-sm)]");
  });

  it("returns the default active style with the primary nav shadow", () => {
    const classes = sidebarItemVariants({ variant: "default", active: true });

    expect(classes).toContain("rounded-[calc(var(--radius-sm)-1px)]");
    expect(classes).toContain("surface-active");
    expect(classes).toContain("border-[color:var(--border-strong)]");
    expect(classes).toContain("text-foreground");
    expect(classes).toContain("shadow-[var(--shadow-sm)]");
  });

  it("returns the compact inactive style with rounded hover treatment", () => {
    const classes = sidebarItemVariants({ variant: "compact", active: false });

    expect(classes).toContain("rounded-[calc(var(--radius-sm)-1px)]");
    expect(classes).toContain("border-transparent");
    expect(classes).toContain("px-3");
    expect(classes).toContain("py-1.5");
    expect(classes).toContain("hover:bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)]");
    expect(classes).toContain("hover:border-[color:var(--border-soft)]");
    expect(classes).not.toContain("shadow-[var(--shadow-sm)]");
  });

  it("returns the compact active style without the primary nav shadow", () => {
    const classes = sidebarItemVariants({ variant: "compact", active: true });

    expect(classes).toContain("rounded-[calc(var(--radius-sm)-1px)]");
    expect(classes).toContain("surface-active");
    expect(classes).toContain("border-[color:var(--border-strong)]");
    expect(classes).toContain("text-foreground");
    expect(classes).not.toContain("shadow-[var(--shadow-sm)]");
  });
});
