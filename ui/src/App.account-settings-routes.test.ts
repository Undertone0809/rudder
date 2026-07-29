import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Account settings routes", () => {
  it("mounts Account settings in both normal and desktop overlay route trees", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).toContain(
      'import { InstanceAccountSettings } from "./pages/InstanceAccountSettings";',
    );
    expect(
      appSource.match(
        /<Route path="account" element=\{<InstanceAccountSettings \/>\} \/>/g,
      ),
    ).toHaveLength(2);
  });
});
