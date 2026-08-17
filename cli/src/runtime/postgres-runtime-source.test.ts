import { describe, expect, it } from "vitest";
import { resolvePostgresRuntimeArchiveSource } from "./postgres-runtime-source.js";

describe("PostgreSQL runtime archive source", () => {
  it("pins the supported macOS archive", () => {
    expect(resolvePostgresRuntimeArchiveSource("darwin", "arm64")).toMatchObject({
      url: "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-osx-binaries.zip",
      expectedSha256: "e3af8c3b4a98a790dba60f2733673b35712a81a201b1f9af6e8ebed5d3b64d0c",
      trustedDefault: true,
    });
  });

  it("pins the supported Windows archive", () => {
    expect(resolvePostgresRuntimeArchiveSource("win32", "x64")).toMatchObject({
      expectedSha256: "7effe34c0bf89027b3f171447d351cbc460f4566c8d0f643daec67f140787858",
      trustedDefault: true,
    });
  });

  it("requires an explicit digest for a custom URL", () => {
    expect(resolvePostgresRuntimeArchiveSource("darwin", "arm64", {
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: "file:///tmp/custom.zip",
    })).toMatchObject({ expectedSha256: null, trustedDefault: false });
    expect(resolvePostgresRuntimeArchiveSource("darwin", "arm64", {
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: "file:///tmp/custom.zip",
      RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256: "A".repeat(64),
    })).toMatchObject({ expectedSha256: "a".repeat(64) });
  });
});
