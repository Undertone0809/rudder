import { createHash } from "node:crypto";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const NATIVE_ARTIFACT_MANIFEST_SCHEMA = "rudder.native-artifacts/v1";

export const NATIVE_ARTIFACTS = Object.freeze([
  Object.freeze({ name: "rudder-process-host", role: "process-host" }),
  Object.freeze({ name: "rudder-native", role: "native" }),
  Object.freeze({ name: "rudder-update-helper", role: "update-helper" }),
  Object.freeze({ name: "rudder-cli", role: "cli" }),
  Object.freeze({ name: "rudder-mcp", role: "mcp" }),
]);

function executableName(name, platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

function assertManifestIdentity({ version, target, platform, arch }) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("native artifact manifest version is required");
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("native artifact manifest target is required");
  }
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("native artifact manifest platform is required");
  }
  if (typeof arch !== "string" || arch.length === 0) {
    throw new Error("native artifact manifest arch is required");
  }
}

async function digestFile(filePath) {
  const [fileStats, bytes] = await Promise.all([lstat(filePath), readFile(filePath)]);
  if (!fileStats.isFile()) throw new Error(`native artifact is not a regular file: ${filePath}`);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function createNativeArtifactManifest({ version, target, platform, arch, targetRoot }) {
  assertManifestIdentity({ version, target, platform, arch });
  const artifacts = [];
  for (const artifact of NATIVE_ARTIFACTS) {
    const file = executableName(artifact.name, platform);
    const identity = await digestFile(path.join(targetRoot, file));
    artifacts.push({
      name: artifact.name,
      role: artifact.role,
      file,
      version,
      ...identity,
    });
  }
  return {
    schema: NATIVE_ARTIFACT_MANIFEST_SCHEMA,
    version,
    target,
    platform,
    arch,
    artifacts,
  };
}

export async function writeNativeArtifactManifest(manifestPath, manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function assertManifestShape(manifest, expected) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("native artifact manifest must be an object");
  }
  if (manifest.schema !== NATIVE_ARTIFACT_MANIFEST_SCHEMA) {
    throw new Error(`unsupported native artifact manifest schema: ${manifest.schema ?? "<missing>"}`);
  }
  for (const field of ["version", "target", "platform", "arch"]) {
    if (manifest[field] !== expected[field]) {
      throw new Error(
        `native artifact manifest ${field} ${manifest[field] ?? "<missing>"} does not match ${expected[field]}`,
      );
    }
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== NATIVE_ARTIFACTS.length) {
    throw new Error(`native artifact manifest must contain exactly ${NATIVE_ARTIFACTS.length} artifacts`);
  }
}

export async function verifyNativeArtifactManifest({
  manifestPath,
  expectedVersion,
  expectedTarget,
  expectedPlatform,
  expectedArch,
  targetRoot = path.dirname(manifestPath),
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifestShape(manifest, {
    version: expectedVersion,
    target: expectedTarget,
    platform: expectedPlatform,
    arch: expectedArch,
  });

  const seen = new Set();
  for (const expectedArtifact of NATIVE_ARTIFACTS) {
    const artifact = manifest.artifacts.find((entry) => entry?.name === expectedArtifact.name);
    if (!artifact || seen.has(expectedArtifact.name)) {
      throw new Error(`native artifact manifest is missing or duplicates ${expectedArtifact.name}`);
    }
    seen.add(expectedArtifact.name);
    const expectedFile = executableName(expectedArtifact.name, expectedPlatform);
    if (artifact.role !== expectedArtifact.role || artifact.file !== expectedFile) {
      throw new Error(`native artifact manifest identity mismatch for ${expectedArtifact.name}`);
    }
    if (artifact.version !== expectedVersion) {
      throw new Error(`native artifact ${expectedArtifact.name} version does not match ${expectedVersion}`);
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "")) {
      throw new Error(`native artifact ${expectedArtifact.name} has invalid size or SHA-256`);
    }
    const artifactPath = path.join(targetRoot, expectedFile);
    const fileStats = await stat(artifactPath).catch(() => null);
    if (!fileStats?.isFile()) throw new Error(`native artifact is missing: ${artifactPath}`);
    const identity = await digestFile(artifactPath);
    if (identity.bytes !== artifact.bytes || identity.sha256 !== artifact.sha256) {
      throw new Error(`native artifact ${expectedArtifact.name} hash or size does not match its manifest`);
    }
  }

  return manifest;
}

export { executableName };
