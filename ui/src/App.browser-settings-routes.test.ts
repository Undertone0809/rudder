import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Browser settings routes", () => {
  it("guards Browser settings in both route trees from authenticated direct navigation", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).toContain('import { InstanceBrowserSettings } from "./pages/InstanceBrowserSettings";');
    expect(appSource).toContain('import { LocalTrustedSettingsRoute } from "./components/LocalTrustedSettingsRoute";');
    expect(
      appSource.match(
        /<Route\s+path="browser"\s+element=\{\s*<LocalTrustedSettingsRoute>\s*<InstanceBrowserSettings \/>\s*<\/LocalTrustedSettingsRoute>\s*\}\s*\/>/g,
      ),
    ).toHaveLength(2);
  });
});
