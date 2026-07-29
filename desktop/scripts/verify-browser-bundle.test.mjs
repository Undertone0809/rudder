import { describe, expect, it } from "vitest";
import { packagedCliArgs } from "./verify-browser-bundle.mjs";

describe("packaged Browser bundle verifier", () => {
  it("runs the Linux Electron CLI handshake without GPU or shared-memory requirements", () => {
    expect(packagedCliArgs("linux", ["--desktop-cli", "mcp-server"])).toEqual([
      "--no-sandbox",
      "--headless",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--desktop-cli",
      "mcp-server",
    ]);
  });

  it("preserves normal packaged CLI arguments on desktop platforms", () => {
    const args = ["desktop-cli-runner.js", "mcp-server"];

    expect(packagedCliArgs("darwin", args)).toBe(args);
  });
});
