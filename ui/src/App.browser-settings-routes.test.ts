import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Browser settings routes", () => {
  it("registers Browser settings in both the normal and modal-overlay route trees", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).toContain('import { InstanceBrowserSettings } from "./pages/InstanceBrowserSettings";');
    expect(appSource.match(/<Route path="browser" element={<InstanceBrowserSettings \/>} \/>/g)).toHaveLength(2);
  });
});
