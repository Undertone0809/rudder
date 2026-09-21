import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexReadinessFingerprint,
  claimCodexAuthProbe,
  clearMatchingCodexAuthFailure,
  clearObservedCodexAuthSuccess,
  hasMatchingCodexAuthFailure,
  recordCodexAuthFailure,
  renewCodexAuthProbe,
  type CodexAuthProbeClaim,
} from "./readiness-gate.js";

let roots: string[] = [];
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../../..");
const readinessGateSourceUrl = pathToFileURL(path.join(testDirectory, "readiness-gate.ts")).href;
const tsxLoaderPath = path.join(repositoryRoot, "server", "node_modules", "tsx", "dist", "loader.mjs");

afterEach(async () => {
  vi.useRealTimers();
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

function readinessStatePath(agentHome: string, fingerprint: string): string {
  return path.join(agentHome, ".rudder", "provider-readiness", "codex", `${fingerprint}.json`);
}

function readinessLockPath(agentHome: string, fingerprint: string): string {
  return `${readinessStatePath(agentHome, fingerprint)}.lock`;
}

function startProbeChild(
  agentHome: string,
  fingerprint: string,
  holdMs: number,
): {
  child: ReturnType<typeof spawn>;
  claimed: Promise<CodexAuthProbeClaim>;
  exited: Promise<number | null>;
} {
  const script = `
import { claimCodexAuthProbe } from ${JSON.stringify(readinessGateSourceUrl)};
const result = await claimCodexAuthProbe(process.argv[1], process.argv[2]);
process.stdout.write(JSON.stringify(result) + "\\n");
const holdMs = Number(process.argv[3] ?? "0");
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
`;
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--import",
    tsxLoaderPath,
    "--input-type=module",
    "-e",
    script,
    agentHome,
    fingerprint,
    String(holdMs),
  ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  const output = createInterface({ input: child.stdout! });
  let claimedSettled = false;
  let resolveClaim!: (claim: CodexAuthProbeClaim) => void;
  let rejectClaim!: (error: Error) => void;
  const claimed = new Promise<CodexAuthProbeClaim>((resolve, reject) => {
    resolveClaim = resolve;
    rejectClaim = reject;
  });
  output.once("line", (line) => {
    claimedSettled = true;
    output.close();
    try {
      resolveClaim(JSON.parse(line) as CodexAuthProbeClaim);
    } catch (error) {
      rejectClaim(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => {
      if (!claimedSettled) rejectClaim(error);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      output.close();
      if (!claimedSettled) {
        rejectClaim(new Error(`probe child exited before claim (${code ?? signal ?? "unknown"})`));
      }
      resolve(code);
    });
  });
  return { child, claimed, exited };
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
    const raw = await fs.readFile(readinessStatePath(agentHome, fingerprint), "utf8");
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

  it("keeps the staged managed config fingerprint stable across Rudder-owned runtime entries", async () => {
    const { sharedCodexHome, root } = await createFixture();
    const managedCodexHome = path.join(root, "managed-codex");
    await fs.mkdir(managedCodexHome, { recursive: true });
    await fs.copyFile(path.join(sharedCodexHome, "auth.json"), path.join(managedCodexHome, "auth.json"));
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'base_url = "https://provider.test/v1"',
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(managedCodexHome, "config.toml"), [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'base_url = "https://provider.test/v1"',
      "",
      "[features]",
      "plugins = false",
      "",
      "[skills.bundled]",
      "enabled = false",
      "",
      "[mcp_servers.rudder-tools]",
      'command = "rudder"',
      'args = ["mcp-server"]',
      "",
      "[mcp_servers.rudder-tools.env]",
      'RUDDER_RUN_ID = "run-2"',
      "",
      "[[skills.config]]",
      'path = "/tmp/operator-skills"',
      "enabled = false",
      "",
    ].join("\n"), "utf8");

    const sourceFingerprint = await buildCodexReadinessFingerprint({
      env: { OPENAI_BASE_URL: "https://provider.test/v1" },
      sharedCodexHome,
      model: "gpt-test",
    });
    const stagedFingerprint = await buildCodexReadinessFingerprint({
      env: { OPENAI_BASE_URL: "https://provider.test/v1" },
      sharedCodexHome,
      codexHome: managedCodexHome,
      model: "gpt-test",
    });

    expect(stagedFingerprint).toBe(sourceFingerprint);
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

  it("expires and refreshes a matching failure after the bounded cooldown", async () => {
    const { agentHome, sharedCodexHome } = await createFixture();
    vi.useFakeTimers();
    const initialTime = new Date("2026-09-15T00:00:00.000Z");
    vi.setSystemTime(initialTime);
    const fingerprint = await buildCodexReadinessFingerprint({
      env: {},
      sharedCodexHome,
      model: "gpt-test",
    });

    await recordCodexAuthFailure(agentHome, fingerprint);
    vi.advanceTimersByTime(60_001);
    expect(await hasMatchingCodexAuthFailure(agentHome, fingerprint)).toBe(false);

    await recordCodexAuthFailure(agentHome, fingerprint);
    expect(await hasMatchingCodexAuthFailure(agentHome, fingerprint)).toBe(true);
    const state = JSON.parse(await fs.readFile(
      path.join(agentHome, ".rudder", "provider-readiness", "codex", `${fingerprint}.json`),
      "utf8",
    )) as { failedAt: string };
    expect(state.failedAt).toBe(new Date(initialTime.getTime() + 60_001).toISOString());
  });

  it("claims an expired probe exactly once and rejects the previous owner after a new generation", async () => {
    const { agentHome } = await createFixture();
    const claims = await Promise.all([
      claimCodexAuthProbe(agentHome, "same-scope"),
      claimCodexAuthProbe(agentHome, "same-scope"),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const first = claims.find((claim) => claim.claimed);
    if (!first?.claimed) throw new Error("missing first probe lease");

    const gatePath = readinessStatePath(agentHome, "same-scope");
    const state = JSON.parse(await fs.readFile(gatePath, "utf8")) as Record<string, unknown>;
    state.probeStartedAt = new Date(0).toISOString();
    await fs.writeFile(gatePath, `${JSON.stringify(state)}\n`, "utf8");

    const second = await claimCodexAuthProbe(agentHome, "same-scope");
    expect(second.claimed).toBe(true);
    if (!second.claimed) throw new Error("missing second probe lease");
    expect(second.lease.generation).toBe(first.lease.generation + 1);

    expect(await recordCodexAuthFailure(agentHome, "same-scope", first.lease)).toBe(false);
    expect(await clearMatchingCodexAuthFailure(agentHome, "same-scope", first.lease)).toBe(false);
    expect(await recordCodexAuthFailure(agentHome, "same-scope", second.lease)).toBe(true);
    expect(await hasMatchingCodexAuthFailure(agentHome, "same-scope")).toBe(true);
  });

  it("distinguishes an active probe from a confirmed authentication failure", async () => {
    const { agentHome } = await createFixture();
    const first = await claimCodexAuthProbe(agentHome, "same-scope");
    expect(first.claimed).toBe(true);
    if (!first.claimed) throw new Error("missing first probe lease");

    const observation = await claimCodexAuthProbe(agentHome, "same-scope");
    expect(observation).toMatchObject({
      claimed: false,
      readinessState: "probing",
      observation: first.lease,
    });

    expect(await recordCodexAuthFailure(agentHome, "same-scope", first.lease)).toBe(true);
    if (observation.claimed || observation.readinessState !== "probing") {
      throw new Error("missing concurrent probe observation");
    }
    expect(await clearObservedCodexAuthSuccess(agentHome, "same-scope", observation.observation)).toBe(true);
    expect(await hasMatchingCodexAuthFailure(agentHome, "same-scope")).toBe(false);
    const replacement = await claimCodexAuthProbe(agentHome, "same-scope");
    expect(replacement.claimed).toBe(true);
  });

  it("does not let an old concurrent success clear a later readiness generation", async () => {
    const { agentHome } = await createFixture();
    const first = await claimCodexAuthProbe(agentHome, "generation-scope");
    if (!first.claimed) throw new Error("missing first probe lease");
    const observation = await claimCodexAuthProbe(agentHome, "generation-scope");
    if (observation.claimed || observation.readinessState !== "probing") {
      throw new Error("missing concurrent probe observation");
    }
    expect(await recordCodexAuthFailure(agentHome, "generation-scope", first.lease)).toBe(true);
    expect(await clearObservedCodexAuthSuccess(agentHome, "generation-scope", observation.observation)).toBe(true);

    const second = await claimCodexAuthProbe(agentHome, "generation-scope");
    expect(second.claimed).toBe(true);
    if (!second.claimed) throw new Error("missing replacement probe lease");
    expect(await clearObservedCodexAuthSuccess(agentHome, "generation-scope", observation.observation)).toBe(false);
    expect(await hasMatchingCodexAuthFailure(agentHome, "generation-scope")).toBe(true);
  });

  it("keeps a locally renewed probe active but recovers an abandoned future-dated state", async () => {
    const { agentHome } = await createFixture();
    const claim = await claimCodexAuthProbe(agentHome, "future-probe");
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("missing future probe lease");

    const gatePath = readinessStatePath(agentHome, "future-probe");
    const state = JSON.parse(await fs.readFile(gatePath, "utf8")) as Record<string, unknown>;
    state.probeStartedAt = new Date(Date.now() + 86_400_000).toISOString();
    state.probeOwnerPid = process.pid;
    await fs.writeFile(gatePath, `${JSON.stringify(state)}\n`, "utf8");

    expect(await claimCodexAuthProbe(agentHome, "future-probe")).toMatchObject({
      claimed: false,
      readinessState: "probing",
      observation: claim.lease,
    });

    state.probeId = "abandoned-future-probe";
    await fs.writeFile(gatePath, `${JSON.stringify(state)}\n`, "utf8");
    expect((await claimCodexAuthProbe(agentHome, "future-probe")).claimed).toBe(true);
  });

  it("treats a future failure timestamp as expired instead of blocking indefinitely", async () => {
    const { agentHome } = await createFixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    await recordCodexAuthFailure(agentHome, "future-scope");

    const gatePath = readinessStatePath(agentHome, "future-scope");
    const state = JSON.parse(await fs.readFile(gatePath, "utf8")) as Record<string, unknown>;
    state.failedAt = new Date(Date.now() + 86_400_000).toISOString();
    await fs.writeFile(gatePath, `${JSON.stringify(state)}\n`, "utf8");

    expect(await hasMatchingCodexAuthFailure(agentHome, "future-scope")).toBe(false);
    expect((await claimCodexAuthProbe(agentHome, "future-scope")).claimed).toBe(true);
  });

  it("clears only the matching failure state", async () => {
    const { agentHome } = await createFixture();
    await recordCodexAuthFailure(agentHome, "failed-fingerprint");

    await clearMatchingCodexAuthFailure(agentHome, "different-fingerprint");
    expect(await hasMatchingCodexAuthFailure(agentHome, "failed-fingerprint")).toBe(true);

    await clearMatchingCodexAuthFailure(agentHome, "failed-fingerprint");
    expect(await hasMatchingCodexAuthFailure(agentHome, "failed-fingerprint")).toBe(false);
  });

  it("returns readiness busy while a live owner holds the lock, even with a future mtime", async () => {
    const { agentHome } = await createFixture();
    const fingerprint = "live-lock";
    const lockPath = readinessLockPath(agentHome, fingerprint);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerToken: "live-owner", ownerPid: process.pid })}\n`,
      "utf8",
    );
    const future = new Date(Date.now() + 86_400_000);
    await fs.utimes(lockPath, future, future);

    const claim = await claimCodexAuthProbe(agentHome, fingerprint);
    expect(claim).toEqual({ claimed: false, readinessState: "busy" });
    await expect(fs.lstat(lockPath)).resolves.toBeDefined();
  });

  it("reclaims a dead-owner lock even when its mtime is in the future", async () => {
    const { agentHome } = await createFixture();
    const fingerprint = "dead-future-lock";
    const lockPath = readinessLockPath(agentHome, fingerprint);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerToken: "dead-owner", ownerPid: process.pid + 1_000_000 })}\n`,
      "utf8",
    );
    const future = new Date(Date.now() + 86_400_000);
    await fs.utimes(lockPath, future, future);

    const claim = await claimCodexAuthProbe(agentHome, fingerprint);
    expect(claim.claimed).toBe(true);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a lock when a live PID has a different process-start identity", async () => {
    const { agentHome } = await createFixture();
    const fingerprint = "reused-pid-lock";
    const lockPath = readinessLockPath(agentHome, fingerprint);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        ownerToken: "foreign-owner",
        ownerPid: process.pid,
        ownerStartIdentity: "foreign-process-start",
      })}\n`,
      "utf8",
    );

    const claim = await claimCodexAuthProbe(agentHome, fingerprint);
    expect(claim.claimed).toBe(true);
  });

  it("uses creation time to recover an unidentified lock whose mtime moved into the future", async () => {
    vi.useFakeTimers();
    const initialTime = new Date();
    vi.setSystemTime(initialTime);
    const { agentHome } = await createFixture();
    const fingerprint = "unidentified-future-lock";
    const lockPath = readinessLockPath(agentHome, fingerprint);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "incomplete lock metadata\n", "utf8");
    const future = new Date(initialTime.getTime() + 86_400_000);
    await fs.utimes(lockPath, future, future);

    vi.setSystemTime(new Date(initialTime.getTime() + 31_000));
    const claim = await claimCodexAuthProbe(agentHome, fingerprint);
    expect(claim.claimed).toBe(true);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a long-running probe active after lease renewal", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-09-16T00:00:00.000Z");
    vi.setSystemTime(initialTime);
    const { agentHome } = await createFixture();
    const claim = await claimCodexAuthProbe(agentHome, "long-running");
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("missing long-running probe lease");

    vi.setSystemTime(new Date(initialTime.getTime() + 90_000));
    expect(await renewCodexAuthProbe(agentHome, "long-running", claim.lease)).toBe(true);
    vi.setSystemTime(new Date(initialTime.getTime() + 209_999));
    expect(await hasMatchingCodexAuthFailure(agentHome, "long-running")).toBe(true);
    vi.setSystemTime(new Date(initialTime.getTime() + 210_001));
    expect(await hasMatchingCodexAuthFailure(agentHome, "long-running")).toBe(false);
  });

  it("serializes readiness claims across independent Node processes", async () => {
    const { agentHome } = await createFixture();
    const first = startProbeChild(agentHome, "cross-process", 1_500);
    const second = startProbeChild(agentHome, "cross-process", 0);
    try {
      const [firstClaim, secondClaim] = await Promise.all([first.claimed, second.claimed]);
      expect([firstClaim, secondClaim].filter((claim) => claim.claimed)).toHaveLength(1);
      const blocked = [firstClaim, secondClaim].find((claim) => !claim.claimed);
      expect(blocked).toMatchObject({
        claimed: false,
        readinessState: "probing",
        observation: { probeId: expect.any(String), generation: expect.any(Number) },
      });
      await Promise.all([first.exited, second.exited]);
    } finally {
      if (first.child.exitCode === null) first.child.kill();
      if (second.child.exitCode === null) second.child.kill();
      await Promise.allSettled([first.exited, second.exited]);
    }
  });

  it("serializes multiple stale-lock reclaimers before creating a new owner", async () => {
    const { agentHome } = await createFixture();
    const fingerprint = "multi-reclaimer";
    const lockPath = readinessLockPath(agentHome, fingerprint);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ownerToken: "dead-owner", ownerPid: process.pid + 1_000_000 })}\n`,
      "utf8",
    );

    const probes = Array.from({ length: 8 }, () => startProbeChild(agentHome, fingerprint, 250));
    try {
      const claims = await Promise.all(probes.map((probe) => probe.claimed));
      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
      for (const claim of claims.filter((candidate) => !candidate.claimed)) {
        expect(claim).toMatchObject({
          claimed: false,
          readinessState: "probing",
          observation: { probeId: expect.any(String), generation: expect.any(Number) },
        });
      }
      await Promise.all(probes.map((probe) => probe.exited));
    } finally {
      for (const probe of probes) {
        if (probe.child.exitCode === null) probe.child.kill();
      }
      await Promise.allSettled(probes.map((probe) => probe.exited));
    }
  });
});
