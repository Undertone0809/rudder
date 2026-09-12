import { describe, expect, it } from "vitest";
import { resolvePostgresRuntimeArchiveSource } from "./postgres-runtime-source.mjs";

const MACOS_SHA256 = "e3af8c3b4a98a790dba60f2733673b35712a81a201b1f9af6e8ebed5d3b64d0c";
const WINDOWS_SHA256 = "7effe34c0bf89027b3f171447d351cbc460f4566c8d0f643daec67f140787858";

describe("Desktop PostgreSQL runtime archive source", () => {
  it.each([
    ["darwin", "arm64", "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-osx-binaries.zip", MACOS_SHA256],
    ["darwin", "x64", "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-osx-binaries.zip", MACOS_SHA256],
    ["win32", "x64", "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip", WINDOWS_SHA256],
  ])("pins the default %s/%s archive", (platform, arch, url, expectedSha256) => {
    expect(resolvePostgresRuntimeArchiveSource(platform, arch)).toEqual({
      url,
      expectedSha256,
      trustedDefault: true,
    });
  });

  it("does not let an environment digest replace a trusted default pin", () => {
    expect(resolvePostgresRuntimeArchiveSource("darwin", "arm64", {
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256: "0".repeat(64),
    })).toMatchObject({ expectedSha256: MACOS_SHA256, trustedDefault: true });
  });

  it("rejects an override URL without an explicit digest", () => {
    expect(() => resolvePostgresRuntimeArchiveSource("darwin", "arm64", {
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: "file:///tmp/custom.zip",
    })).toThrow("SHA-256 digest is required");
  });

  it("rejects an override URL with a malformed digest", () => {
    expect(() => resolvePostgresRuntimeArchiveSource("darwin", "arm64", {
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: "file:///tmp/custom.zip",
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256: "not-a-digest",
    })).toThrow("64-character hexadecimal value");
  });

  it("uses the explicit digest for an override URL", () => {
    expect(resolvePostgresRuntimeArchiveSource("darwin", "arm64", {
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: "file:///tmp/custom.zip",
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256: "A".repeat(64),
    })).toEqual({
      url: "file:///tmp/custom.zip",
      expectedSha256: "a".repeat(64),
      trustedDefault: false,
    });
  });

  it("does not invent a default source for an unsupported target", () => {
    expect(resolvePostgresRuntimeArchiveSource("linux", "x64")).toBeNull();
  });
});
