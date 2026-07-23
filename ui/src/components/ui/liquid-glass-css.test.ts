import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const uiRoot = path.resolve(import.meta.dirname, "../../..");
const cssPath = path.join(uiRoot, "src/components/ui/liquid-glass.css");
const entryCssPath = path.join(uiRoot, "src/z-liquid-glass.css");
const mainPath = path.join(uiRoot, "src/main.tsx");
const pluginLaunchersPath = path.join(uiRoot, "src/plugins/launchers.tsx");

describe("liquid glass material CSS", () => {
  it("loads after the existing global and motion styles", () => {
    const main = fs.readFileSync(mainPath, "utf8");
    const indexImport = main.indexOf('import "./index.css"');
    const motionImport = main.indexOf('import "./motion.css"');
    const glassImport = main.indexOf('import "./z-liquid-glass.css"');

    expect(glassImport).toBeGreaterThan(indexImport);
    expect(glassImport).toBeGreaterThan(motionImport);
    expect(fs.readFileSync(entryCssPath, "utf8")).toContain(
      '@import "./components/ui/liquid-glass.css"',
    );
  });

  it("defines enhanced, reduced-motion, forced-colors, and fallback rendering", () => {
    expect(fs.existsSync(cssPath)).toBe(true);
    if (!fs.existsSync(cssPath)) return;

    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain(".liquid-glass-surface");
    expect(css).toContain(".liquid-glass-warp");
    expect(css).toContain("backdrop-filter:");
    expect(css).toContain("@supports not");
    expect(css).toContain(
      '.liquid-glass-host[data-liquid-glass-variant="tooltip"] .liquid-glass-tint',
    );
    expect(css).toMatch(
      /@layer components\s*\{\s*:where\(\.liquid-glass-host\)\s*\{\s*position: relative;/,
    );
    expect(css).not.toContain(".liquid-glass-host > :not([data-rudder-liquid-glass])");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toMatch(
      /\.liquid-glass-host\.liquid-glass-host \{[\s\S]*?backdrop-filter:/,
    );
  });

  it("bridges legacy custom menu surfaces into the shared material", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain(".surface-overlay:not(.liquid-glass-host)");
    expect(css).toContain(".glass-popover:not(.liquid-glass-host)");
    expect(css).toContain("--liquid-glass-legacy-tint");
  });

  it("covers custom plugin launcher modal, drawer, and popover shells", () => {
    const launchers = fs.readFileSync(pluginLaunchersPath, "utf8");

    expect(launchers).toContain("liquid-glass-host fixed");
    expect(launchers).toContain(
      '<LiquidGlassSurface variant={shellType === "openPopover" ? "menu" : "modal"} />',
    );
  });
});
