import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexReadinessFingerprint,
  clearMatchingCodexAuthFailure,
  hasMatchingCodexAuthFailure,
  recordCodexAuthFailure,
} from "./readiness-gate.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-readiness-"));
  roots.push(root);
  const agentHome = path.join(root, "agent");
  const sharedCodexHome = path.join(root, "shared-codex");
  await fs.mkdir(sharedCodexHome, { recursive: true });
  await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"first"}\n', "utf8");
  await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model_provider = "custom"\n', "utf8");
  return { root, agentHome, sharedCodexHome };
}

describe("Codex provider readiness gate", () => {
  it("persists only an opaque fingerprint and blocks the same readiness state", async () => {
    const { agentHome, sharedCodexHome } = await createFixture();
    const fingerprint = await buildCodexReadinessFingerprint({
      env: { OPENAI_BASE_URL: "https://provider.test/v1" },
      sharedCodexHome,
      model: "gpt-test",
    });

    await recordCodexAuthFailure(agentHome, fingerprint);

    expect(await hasMatchingCodexAuthFailure(agentHome, fingerprint)).toBe(true);
    const raw = await fs.readFile(
      path.join(agentHome, ".rudder", "provider-readiness", "codex", `${fingerprint}.json`),
      "utf8",
    );
    expect(raw).toContain(fingerprint);
    expect(raw).not.toContain("first");
    expect(raw).not.toContain("provider.test");
  });

  it("uses one provider and credential scope across model fallbacks", async () => {
    const { sharedCodexHome } = await createFixture();
    const primary = await buildCodexReadinessFingerprint({
      env: { OPENAI_BASE_URL: "https://provider.test/v1" },
      sharedCodexHome,
      model: "gpt-primary",
    });
    const fallback = await buildCodexReadinessFingerprint({
      env: { OPENAI_BASE_URL: "https://provider.test/v1" },
      sharedCodexHome,
      model: "gpt-fallback",
    });

    expect(fallback).toBe(primary);
  });

  it("publishes the first concurrent auth failure without overwriting it", async () => {
    const { agentHome } = await createFixture();
    await Promise.all([
      recordCodexAuthFailure(agentHome, "same-scope"),
      recordCodexAuthFailure(agentHome, "same-scope"),
    ]);

    expect(await hasMatchingCodexAuthFailure(agentHome, "same-scope")).toBe(true);
  });

  it("allows a retry after credentials or provider configuration changes", async () => {
    const { agentHome, sharedCodexHome } = await createFixture();
    const input = { env: {}, sharedCodexHome, model: "gpt-test" };
    const failedFingerprint = await buildCodexReadinessFingerprint(input);
    await recordCodexAuthFailure(agentHome, failedFingerprint);

    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"second"}\n', "utf8");
    const credentialFingerprint = await buildCodexReadinessFingerprint(input);
    expect(credentialFingerprint).not.toBe(failedFingerprint);
    expect(await hasMatchingCodexAuthFailure(agentHome, credentialFingerprint)).toBe(false);

    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model_provider = "other"\n', "utf8");
    const providerFingerprint = await buildCodexReadinessFingerprint(input);
    expect(providerFingerprint).not.toBe(credentialFingerprint);
  });

  it("clears only the matching failure state", async () => {
    const { agentHome } = await createFixture();
    await recordCodexAuthFailure(agentHome, "failed-fingerprint");

    await clearMatchingCodexAuthFailure(agentHome, "different-fingerprint");
    expect(await hasMatchingCodexAuthFailure(agentHome, "failed-fingerprint")).toBe(true);

    await clearMatchingCodexAuthFailure(agentHome, "failed-fingerprint");
    expect(await hasMatchingCodexAuthFailure(agentHome, "failed-fingerprint")).toBe(false);
  });
});
