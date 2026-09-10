#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrationCompatibilityMatrix,
  readCandidateManifest,
  readFixtureManifest,
  validateCompatibilityMatrix,
} from "./release-compatibility-matrix.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(scriptPath);
const repoRoot = resolve(scriptsDirectory, "..");
const matrixPath = join(scriptsDirectory, "release-compatibility-matrix.mjs");
const matrixMarker = "export const migrationCompatibilityMatrix = {\n";

function parseStableVersion(version) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`expected a stable semver like 0.5.1, found: ${version || "<empty>"}`);
  }
  return match.slice(1).map(Number);
}

function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function parseArguments(argv) {
  const options = { candidateVersion: "", stableVersion: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate-version") {
      options.candidateVersion = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--stable-version") {
      options.stableVersion = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`unexpected argument ${argument}`);
    }
  }

  parseStableVersion(options.candidateVersion);
  parseStableVersion(options.stableVersion);
  if (compareStableVersions(options.candidateVersion, options.stableVersion) <= 0) {
    throw new Error(
      `candidate version ${options.candidateVersion} must be newer than stable ${options.stableVersion}`,
    );
  }
  return options;
}

function findPreviousDeclaration(stableVersion) {
  const exact = migrationCompatibilityMatrix[stableVersion];
  if (exact) return { version: stableVersion, declaration: exact };

  const previous = Object.entries(migrationCompatibilityMatrix)
    .filter(([version]) => compareStableVersions(version, stableVersion) < 0)
    .sort(([left], [right]) => compareStableVersions(left, right))
    .at(-1);
  if (!previous) {
    throw new Error(`no prior migration compatibility declaration exists before ${stableVersion}`);
  }
  return { version: previous[0], declaration: previous[1] };
}

function buildDeclaration({ candidateVersion, stableVersion }) {
  const candidateManifest = readCandidateManifest(repoRoot);
  const previous = findPreviousDeclaration(stableVersion);
  const stableFixture = {
    version: stableVersion,
    ref: `v${stableVersion}`,
  };
  const stableManifest = readFixtureManifest(repoRoot, stableFixture);
  const fixtures = [
    { ...stableFixture, fingerprint: stableManifest.fingerprint },
    ...(previous.declaration.fixtures ?? []),
  ].filter((fixture, index, all) => (
    all.findIndex((other) => other.version === fixture.version) === index
  ));
  const declaration = {
    candidateFingerprint: candidateManifest.fingerprint,
    fixtures,
  };

  validateCompatibilityMatrix({
    candidateManifest,
    candidateVersion: `${candidateVersion}-canary.0`,
    channel: "canary",
    matrix: {
      ...migrationCompatibilityMatrix,
      [candidateVersion]: declaration,
    },
    loadFixture: (fixture) => readFixtureManifest(repoRoot, fixture),
  });

  return { declaration, candidateManifest, previous };
}

function formatDeclaration(version, declaration) {
  const fixtures = declaration.fixtures.map((fixture) => (
    "      {\n"
      + `        version: "${fixture.version}",\n`
      + `        ref: "${fixture.ref}",\n`
      + `        fingerprint: "${fixture.fingerprint}",\n`
      + "      },"
  )).join("\n");

  return (
    `  "${version}": {\n`
    + `    candidateFingerprint: "${declaration.candidateFingerprint}",\n`
    + "    fixtures: [\n"
    + `${fixtures}\n`
    + "    ],\n"
    + "  },\n"
  );
}

function updateMatrixFile(candidateVersion, declaration) {
  const source = readFileSync(matrixPath, "utf8");
  if (!source.includes(matrixMarker)) {
    throw new Error(`migration compatibility matrix marker is missing from ${matrixPath}`);
  }

  const nextSource = source.replace(matrixMarker, `${matrixMarker}${formatDeclaration(candidateVersion, declaration)}`);
  if (nextSource === source) {
    throw new Error(`could not add migration compatibility declaration for ${candidateVersion}`);
  }
  writeFileSync(matrixPath, nextSource);
}

function main({ candidateVersion, stableVersion }) {
  const existing = migrationCompatibilityMatrix[candidateVersion];
  const { declaration, candidateManifest, previous } = buildDeclaration({ candidateVersion, stableVersion });
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(declaration)) {
      throw new Error(
        `migration compatibility declaration for ${candidateVersion} already exists with different content`,
      );
    }
    console.log(`Migration compatibility declaration for ${candidateVersion} is already up to date.`);
    return;
  }

  updateMatrixFile(candidateVersion, declaration);
  console.log(
    `Prepared migration compatibility declaration for ${candidateVersion} `
    + `from ${previous.version} using ${candidateManifest.entries.length} migrations.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
