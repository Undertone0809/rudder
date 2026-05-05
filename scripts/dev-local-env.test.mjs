import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDevScriptEnvironment } from "./dev-local-env.mjs";

test("auto-isolates Codex-managed worktrees without repo-local Rudder config", () => {
  const repoRoot = path.join(os.homedir(), ".codex", "worktrees", "1f39", "rudder-oss");
  const { env } = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: {},
  });

  assert.equal(env.RUDDER_LOCAL_ENV, "dev");
  assert.equal(env.RUDDER_INSTANCE_ID, "codex-1f39-rudder-oss");
  assert.equal(env.RUDDER_HOME, path.join(os.homedir(), ".rudder-worktrees"));
  assert.equal(env.RUDDER_IN_WORKTREE, "true");
  assert.equal(env.RUDDER_WORKTREE_NAME, "rudder-oss-1f39");
  assert.match(env.RUDDER_WORKTREE_COLOR, /^#[0-9a-f]{6}$/);
  assert.notEqual(env.PORT, "3100");
  assert.notEqual(env.RUDDER_EMBEDDED_POSTGRES_PORT, "54329");
});

test("respects explicit dev environment over Codex worktree auto-isolation", () => {
  const repoRoot = path.join(os.homedir(), ".codex", "worktrees", "1f39", "rudder-oss");
  const { env } = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: {
      RUDDER_HOME: "/tmp/rudder-explicit-home",
      RUDDER_INSTANCE_ID: "explicit-instance",
      PORT: "4999",
    },
  });

  assert.equal(env.RUDDER_HOME, "/tmp/rudder-explicit-home");
  assert.equal(env.RUDDER_INSTANCE_ID, "explicit-instance");
  assert.equal(env.PORT, "4999");
  assert.equal(env.RUDDER_IN_WORKTREE, undefined);
});

test("repo-local Rudder env disables Codex worktree auto-isolation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-dev-local-env-"));
  const repoRoot = path.join(root, ".codex", "worktrees", "abcd", "rudder-oss");
  fs.mkdirSync(path.join(repoRoot, ".rudder"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, ".rudder", ".env"),
    [
      "RUDDER_HOME=/tmp/rudder-local-home",
      "RUDDER_INSTANCE_ID=local-instance",
      "PORT=4567",
      "RUDDER_EMBEDDED_POSTGRES_PORT=5567",
      "",
    ].join("\n"),
  );

  const { env } = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: {},
  });

  assert.equal(env.RUDDER_HOME, "/tmp/rudder-local-home");
  assert.equal(env.RUDDER_INSTANCE_ID, "local-instance");
  assert.equal(env.PORT, "4567");
  assert.equal(env.RUDDER_EMBEDDED_POSTGRES_PORT, "5567");
  assert.equal(env.RUDDER_IN_WORKTREE, undefined);
});
