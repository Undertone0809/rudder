import { describe, expect, it, vi } from "vitest";
import { readMacBrowserKeychainPassword } from "./browser-keychain-macos.js";

describe("macOS browser Keychain access", () => {
  it("uses /usr/bin/security with an argument array and returns a trimmed Buffer", async () => {
    const runSecurity = vi.fn(async () => Buffer.from("secret-password\n"));
    const password = await readMacBrowserKeychainPassword({
      service: "Chrome Safe Storage",
      account: "Chrome",
    }, { runSecurity });

    expect(runSecurity).toHaveBeenCalledWith([
      "find-generic-password",
      "-w",
      "-s",
      "Chrome Safe Storage",
      "-a",
      "Chrome",
    ]);
    expect(Buffer.isBuffer(password)).toBe(true);
    expect(password.toString("utf8")).toBe("secret-password");
    password.fill(0);
  });

  it("returns only a sanitized error when Keychain access fails", async () => {
    const stdout = Buffer.from("secret-password");
    const stderr = Buffer.from("secret stderr with /Users/tester/profile");
    const runSecurity = vi.fn(async () => {
      throw Object.assign(new Error("security failed"), { stdout, stderr });
    });
    const error = await readMacBrowserKeychainPassword({
      service: "Chrome Safe Storage",
      account: "Chrome",
    }, { runSecurity }).catch((caught) => caught as Error);

    expect(error.message).toBe("Browser Keychain access was denied or unavailable.");
    expect(error.message).not.toContain("/Users/tester");
    expect(error.message).not.toContain("Chrome Safe Storage");
    expect(stdout.every((byte) => byte === 0)).toBe(true);
    expect(stderr.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes stdout and stderr returned by the real command callback on failure", async () => {
    const stdout = Buffer.from("secret-password");
    const stderr = Buffer.from("security diagnostic");
    const execSecurity = vi.fn((_file, _args, _options, callback) => {
      callback(new Error("security failed"), stdout, stderr);
    });

    await expect(readMacBrowserKeychainPassword({ service: "service", account: "account" }, {
      execSecurity,
    })).rejects.toThrow("unavailable");
    expect(stdout.every((byte) => byte === 0)).toBe(true);
    expect(stderr.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects empty or unexpectedly large Keychain values", async () => {
    await expect(readMacBrowserKeychainPassword({ service: "service", account: "account" }, {
      runSecurity: async () => Buffer.from("\n"),
    })).rejects.toThrow("unavailable");
    await expect(readMacBrowserKeychainPassword({ service: "service", account: "account" }, {
      runSecurity: async () => Buffer.alloc(4_097, 1),
    })).rejects.toThrow("unavailable");
  });
});
