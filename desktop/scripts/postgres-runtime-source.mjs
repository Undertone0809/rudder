export const RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL";
export const RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const SOURCES = {
  "darwin/arm64": {
    url: "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-osx-binaries.zip",
    sha256: "e3af8c3b4a98a790dba60f2733673b35712a81a201b1f9af6e8ebed5d3b64d0c",
  },
  "darwin/x64": {
    url: "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-osx-binaries.zip",
    sha256: "e3af8c3b4a98a790dba60f2733673b35712a81a201b1f9af6e8ebed5d3b64d0c",
  },
  "win32/x64": {
    url: "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip",
    sha256: "7effe34c0bf89027b3f171447d351cbc460f4566c8d0f643daec67f140787858",
  },
};

export function resolvePostgresRuntimeArchiveSource(
  platform = process.platform,
  arch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch,
  env = process.env,
) {
  const explicitUrl = env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL_ENV]?.trim();
  if (explicitUrl) {
    const expectedSha256 = env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV]?.trim().toLowerCase();
    if (!expectedSha256) {
      throw new Error("PostgreSQL runtime archive SHA-256 digest is required for an override URL");
    }
    if (!SHA256_PATTERN.test(expectedSha256)) {
      throw new Error("PostgreSQL runtime archive SHA-256 digest must be a 64-character hexadecimal value");
    }
    return {
      url: explicitUrl,
      expectedSha256,
      trustedDefault: false,
    };
  }

  const trusted = SOURCES[`${platform}/${arch}`];
  if (!trusted) return null;
  return {
    url: trusted.url,
    expectedSha256: trusted.sha256,
    trustedDefault: true,
  };
}
