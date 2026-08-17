import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishGithubReleaseAssetsImmutable } from "./publish-github-release-assets-immutable.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("immutable GitHub Desktop release assets", () => {
  it("uploads only missing binaries before the checksum completion marker exists", async () => {
    const fixture = await releaseFixture();
    const uploads = [];
    const result = await publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async (upload) => uploads.push(path.basename(upload.filePath)),
    });
    expect(uploads).toEqual(["Rudder-new.zip"]);
    expect(result).toEqual({ phase: "binaries", uploaded: 1, verified: 1 });
  });

  it("rejects a completed Release whose checksum marker coexists with a missing binary", async () => {
    const fixture = await releaseFixture({ includeChecksum: true });
    let uploaded = false;
    await expect(publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async () => { uploaded = true; },
    })).rejects.toThrow("is completed; missing Desktop assets: Rudder-new.zip");
    expect(uploaded).toBe(false);
  });

  it("accepts a byte-identical complete Release without changing it", async () => {
    const fixture = await releaseFixture({ includeChecksum: true, includeNew: true });
    const uploads = [];
    const result = await publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async (upload) => uploads.push(path.basename(upload.filePath)),
    });
    expect(uploads).toEqual([]);
    expect(result).toEqual({ phase: "binaries", uploaded: 0, verified: 2 });
  });

  it("refuses to publish the checksum marker until every GitHub binary exists", async () => {
    const fixture = await releaseFixture();
    let uploaded = false;
    await expect(publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "checksum",
      uploadImpl: async () => { uploaded = true; },
    })).rejects.toThrow("not ready for its checksum marker; missing Desktop assets: Rudder-new.zip");
    expect(uploaded).toBe(false);
  });

  it("verifies the complete binary set before publishing the checksum marker", async () => {
    const fixture = await releaseFixture({ includeNew: true });
    const uploads = [];
    const result = await publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "checksum",
      uploadImpl: async (upload) => uploads.push(path.basename(upload.filePath)),
    });
    expect(uploads).toEqual(["SHASUMS256.txt"]);
    expect(result).toEqual({ phase: "checksum", uploaded: 1, verified: 0 });
  });

  it("rejects a conflicting existing binary without uploading", async () => {
    const fixture = await releaseFixture({ existingDigest: `sha256:${"0".repeat(64)}` });
    let uploaded = false;
    await expect(publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async () => { uploaded = true; },
    })).rejects.toThrow("Immutable GitHub Release asset conflict");
    expect(uploaded).toBe(false);
  });

  it("downloads and verifies existing bytes when GitHub omits the digest", async () => {
    const fixture = await releaseFixture({ omitExistingDigest: true });
    const result = await publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async () => {},
    });
    expect(result).toEqual({ phase: "binaries", uploaded: 1, verified: 1 });
    expect(fixture.downloaded).toEqual(["Rudder-existing.zip"]);
  });

  it("accepts an identical object created by a concurrent upload", async () => {
    const fixture = await releaseFixture({ raceNewAsset: true });
    const result = await publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async () => { throw new Error("already exists"); },
    });
    expect(result).toEqual({ phase: "binaries", uploaded: 0, verified: 2 });
  });

  it("rejects local binaries that do not match the checksum manifest before upload", async () => {
    const fixture = await releaseFixture();
    await writeFile(path.join(fixture.options.assetDir, "Rudder-new.zip"), "corrupt");
    let uploaded = false;
    await expect(publishGithubReleaseAssetsImmutable({
      ...fixture.options,
      phase: "binaries",
      uploadImpl: async () => { uploaded = true; },
    })).rejects.toThrow("does not match SHASUMS256.txt");
    expect(uploaded).toBe(false);
  });
});

async function releaseFixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "rudder-github-assets-test."));
  tempDirs.push(dir);
  const existing = Buffer.from("existing binary");
  const next = Buffer.from("new binary");
  const checksum = Buffer.from(
    `${sha256(existing)}  Rudder-existing.zip\n${sha256(next)}  Rudder-new.zip\n`,
  );
  await Promise.all([
    writeFile(path.join(dir, "Rudder-existing.zip"), existing),
    writeFile(path.join(dir, "Rudder-new.zip"), next),
    writeFile(path.join(dir, "SHASUMS256.txt"), checksum),
  ]);
  const assets = [githubAsset("Rudder-existing.zip", existing, options.existingDigest)];
  if (options.includeNew) assets.push(githubAsset("Rudder-new.zip", next));
  if (options.includeChecksum) assets.push(githubAsset("SHASUMS256.txt", checksum));
  if (options.omitExistingDigest) delete assets[0].digest;
  const racedAssets = options.raceNewAsset ? [...assets, githubAsset("Rudder-new.zip", next)] : assets;
  let releaseReads = 0;
  const downloaded = [];
  return {
    downloaded,
    options: {
      assetDir: dir,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.hostname === "api.github.test" && url.pathname.includes("/releases/tags/")) {
          releaseReads += 1;
          return Response.json({
            assets: options.raceNewAsset && releaseReads > 1 ? racedAssets : assets,
            draft: false,
          });
        }
        const name = decodeURIComponent(url.pathname.slice(1));
        downloaded.push(name);
        const bytes = name === "Rudder-existing.zip" ? existing : checksum;
        return new Response(bytes);
      },
      githubApiBase: "https://api.github.test",
      githubToken: "token",
      log: () => {},
      repo: "Undertone0809/rudder",
      tag: "v0.7.5",
    },
  };
}

function githubAsset(name, bytes, digest = `sha256:${sha256(bytes)}`) {
  return { digest, name, size: bytes.length, url: `https://assets.github.test/${encodeURIComponent(name)}` };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
