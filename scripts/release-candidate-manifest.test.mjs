import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCandidateManifest,
  EXPECTED_DESKTOP_ARTIFACT_COUNT,
  EXPECTED_NPM_ARTIFACT_COUNT,
  verifyCandidateManifest,
} from "./release-candidate-manifest.mjs";

const sourceSha = "a".repeat(40);
const sourceTreeSha = "b".repeat(40);
const workflowSourceSha = "c".repeat(40);
const now = new Date("2026-09-01T00:00:00.000Z");
const runtime = {
  node: "v24.0.0",
  nodeMajor: 24,
  pnpm: "pnpm@9.15.4",
  rust: "dtolnay/rust-toolchain@stable",
  electron: "^37.3.1",
  packaging: "electron-builder via pnpm desktop:dist",
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "rudder-candidate-manifest-"));
  const npmDir = join(root, "npm");
  const desktopDir = join(root, "desktop");
  mkdirSync(npmDir);
  mkdirSync(desktopDir);
  const npmRows = [];
  for (let index = 0; index < EXPECTED_NPM_ARTIFACT_COUNT; index += 1) {
    const filename = `rudder-package-${index}.tgz`;
    writeFileSync(join(npmDir, filename), `npm artifact ${index}`);
    npmRows.push({ filename, name: `@rudderhq/package-${index}`, version: "0.7.17" });
  }
  const lines = npmRows.map(({ filename, name, version }) => {
    const digest = createHash("sha256").update(`npm artifact ${filename.match(/(\d+)/u)?.[1]}`).digest("hex");
    return `${name}\t${version}\t${filename}\t${digest}`;
  });
  writeFileSync(join(npmDir, "manifest.tsv"), `${lines.join("\n")}\n`);

  for (const filename of [
    "Rudder-0.7.17-macos-x64-portable.zip",
    "Rudder-0.7.17-macos-x64-shell.zip",
    "Rudder-0.7.17-macos-arm64-portable.zip",
    "Rudder-0.7.17-macos-arm64-shell.zip",
    "Rudder-0.7.17-windows-x64-portable.zip",
    "Rudder-0.7.17-windows-x64-shell.zip",
    "Rudder-0.7.17-linux-x64.AppImage",
  ]) {
    writeFileSync(join(desktopDir, filename), `desktop artifact ${filename}`);
  }
  const runtimeFile = join(root, "runtime.json");
  writeFileSync(runtimeFile, `${JSON.stringify(runtime)}\n`);
  return { root, npmDir, desktopDir, runtimeFile };
}

test("creates and verifies an immutable candidate manifest with all artifact digests", () => {
  const fixture = makeFixture();
  try {
    const manifest = createCandidateManifest({
      sourceSha,
      sourceTreeSha,
      workflowSourceSha,
      version: "0.7.17",
      qualificationRunId: "100",
      candidateRunId: "200",
      runtime,
      npmDir: fixture.npmDir,
      desktopDir: fixture.desktopDir,
      now,
    });

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.artifacts.npm.length, EXPECTED_NPM_ARTIFACT_COUNT);
    assert.equal(manifest.artifacts.desktop.length, EXPECTED_DESKTOP_ARTIFACT_COUNT);
    assert.equal(manifest.artifacts.checksum.filename, "SHASUMS256.txt");
    assert.equal(manifest.candidate.expiresAt, "2026-09-08T00:00:00.000Z");
    assert.strictEqual(
      verifyCandidateManifest({
        manifest,
        sourceSha,
        sourceTreeSha,
        workflowSourceSha,
        version: "0.7.17",
        candidateRunId: "200",
        qualificationRunId: "100",
        npmDir: fixture.npmDir,
        desktopDir: fixture.desktopDir,
        runtimeFile: fixture.runtimeFile,
        now,
      }),
      manifest,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects digest, source, qualification, and expiration mismatches", () => {
  const fixture = makeFixture();
  try {
    const manifest = createCandidateManifest({
      sourceSha,
      sourceTreeSha,
      workflowSourceSha,
      version: "0.7.17",
      qualificationRunId: "100",
      candidateRunId: "200",
      runtime,
      npmDir: fixture.npmDir,
      desktopDir: fixture.desktopDir,
      now,
    });

    assert.throws(
      () => verifyCandidateManifest({ manifest, sourceSha: "d".repeat(40), npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /source SHA/,
    );
    assert.throws(
      () => verifyCandidateManifest({ manifest, sourceTreeSha: "e".repeat(40), npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /source tree SHA/,
    );
    assert.throws(
      () => verifyCandidateManifest({ manifest, workflowSourceSha: "f".repeat(40), npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /workflow source SHA/,
    );
    const invalidExpiration = { ...manifest, candidate: { ...manifest.candidate, expiresAt: "not-a-date" } };
    assert.throws(
      () => verifyCandidateManifest({ manifest: invalidExpiration, npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /expiration is invalid/,
    );
    assert.throws(
      () => verifyCandidateManifest({ manifest, qualificationRunId: "999", npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /Qualification run ID/,
    );
    writeFileSync(join(fixture.npmDir, "rudder-package-0.tgz"), "tampered");
    assert.throws(
      () => verifyCandidateManifest({ manifest, npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /digest mismatch/,
    );
    assert.throws(
      () => verifyCandidateManifest({ manifest, npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now: new Date("2026-09-09T00:00:00.000Z") }),
      /expired/,
    );
    writeFileSync(fixture.runtimeFile, `${JSON.stringify({ ...runtime, nodeMajor: 23 })}\n`);
    assert.throws(
      () => verifyCandidateManifest({ manifest, npmDir: fixture.npmDir, desktopDir: fixture.desktopDir, runtimeFile: fixture.runtimeFile, now }),
      /expected runtime/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a Desktop candidate with an unexpected platform identity", () => {
  const fixture = makeFixture();
  try {
    rmSync(join(fixture.desktopDir, "Rudder-0.7.17-windows-x64-shell.zip"));
    writeFileSync(join(fixture.desktopDir, "Rudder-0.7.17-windows-arm64-portable.zip"), "unexpected desktop artifact");
    assert.throws(
      () => createCandidateManifest({
        sourceSha,
        sourceTreeSha,
        workflowSourceSha,
        version: "0.7.17",
        qualificationRunId: "100",
        candidateRunId: "200",
        runtime,
        npmDir: fixture.npmDir,
        desktopDir: fixture.desktopDir,
        now,
      }),
      /identities do not match the expected set/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an npm candidate manifest with the wrong artifact count", () => {
  const fixture = makeFixture();
  try {
    const manifestPath = join(fixture.npmDir, "manifest.tsv");
    const rows = readFileSync(manifestPath, "utf8").trimEnd().split(/\r?\n/u);
    writeFileSync(manifestPath, `${rows.slice(0, -1).join("\n")}\n`);

    assert.throws(
      () => createCandidateManifest({
        sourceSha,
        sourceTreeSha,
        workflowSourceSha,
        version: "0.7.17",
        qualificationRunId: "100",
        candidateRunId: "200",
        runtime,
        npmDir: fixture.npmDir,
        desktopDir: fixture.desktopDir,
        now,
      }),
      new RegExp(`Expected ${EXPECTED_NPM_ARTIFACT_COUNT} npm artifacts, found ${EXPECTED_NPM_ARTIFACT_COUNT - 1}`),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("verify CLI rejects a mismatched workflow source SHA and accepts the matching SHA", () => {
  const fixture = makeFixture();
  try {
    const manifest = createCandidateManifest({
      sourceSha,
      sourceTreeSha,
      workflowSourceSha,
      version: "0.7.17",
      qualificationRunId: "100",
      candidateRunId: "200",
      runtime,
      npmDir: fixture.npmDir,
      desktopDir: fixture.desktopDir,
      now: new Date(),
    });
    const manifestPath = join(fixture.root, "candidate-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const verify = (expectedWorkflowSha) => spawnSync(process.execPath, [
      fileURLToPath(new URL("./release-candidate-manifest.mjs", import.meta.url)),
      "verify",
      "--manifest", manifestPath,
      "--source-sha", sourceSha,
      "--source-tree-sha", sourceTreeSha,
      "--version", "0.7.17",
      "--candidate-run-id", "200",
      "--qualification-run-id", "100",
      "--workflow-source-sha", expectedWorkflowSha,
      "--npm-dir", fixture.npmDir,
      "--desktop-dir", fixture.desktopDir,
      "--runtime-file", fixture.runtimeFile,
    ], { encoding: "utf8" });

    const matching = verify(workflowSourceSha);
    assert.equal(matching.status, 0, matching.stderr);
    assert.equal(matching.stdout, `verified\t${sourceSha}\t0.7.17\t200\n`);

    const mismatched = verify("d".repeat(40));
    assert.equal(mismatched.status, 1, "CLI must reject a different trusted workflow SHA");
    assert.match(mismatched.stderr, /Candidate workflow source SHA does not match the trusted workflow/);
    assert.equal(mismatched.stdout, "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
