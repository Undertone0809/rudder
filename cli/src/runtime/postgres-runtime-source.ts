export const RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL";
export const RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256";

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
} as const;

export type PostgresRuntimeArchiveSource = {
  url: string;
  expectedSha256: string | null;
  trustedDefault: boolean;
};

export function resolvePostgresRuntimeArchiveSource(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PostgresRuntimeArchiveSource | null {
  const key = `${platform}/${arch}` as keyof typeof SOURCES;
  const trusted = SOURCES[key];
  const explicitUrl = env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL_ENV]?.trim();
  const url = explicitUrl || trusted?.url;
  if (!url) return null;
  const configuredSha256 = env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_SHA256_ENV]?.trim().toLowerCase();
  return {
    url,
    expectedSha256: configuredSha256 || (explicitUrl ? null : trusted.sha256),
    trustedDefault: !explicitUrl && Boolean(trusted),
  };
}
