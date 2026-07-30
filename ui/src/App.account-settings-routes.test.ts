import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Account settings routes", () => {
  it("redirects the legacy Account route to the combined Profile page in both route trees", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).not.toContain('import { InstanceAccountSettings } from "./pages/InstanceAccountSettings";');
    expect(
      appSource.match(
        /<Route path="account" element=\{<LegacyAccountSettingsRedirect \/>\} \/>/g,
      ),
    ).toHaveLength(2);
    expect(appSource).toContain('to={`/instance/settings/profile${location.search}${location.hash}`}');
    expect(appSource).toContain("state={location.state}");
  });
});
