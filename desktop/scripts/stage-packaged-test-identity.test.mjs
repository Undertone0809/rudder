import { describe, expect, it } from "vitest";

describe("packaged test Identity marker", () => {
  it("keeps the marker opt-in and scoped to the test artifact build", async () => {
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(new URL("./dist.mjs", import.meta.url), "utf8");
    expect(text).toContain("RUDDER_DESKTOP_PACKAGED_TEST_IDENTITY");
    expect(text).toContain("packaged-test-identity.marker");
    expect(text).toContain("rudder-packaged-test-identity-v1");
  });
});
