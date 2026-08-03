import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isolateDevShellFromParentRuntime,
  resolveDevDesktopEnvironment,
  resolveDevScriptEnvironment,
} from "./dev-local-env.mjs";

test("defaults the development Desktop to local workspace access", () => {
  assert.equal(resolveDevDesktopEnvironment({}).RUDDER_DESKTOP_AUTH_BYPASS, "1");
  assert.equal(
    resolveDevDesktopEnvironment({ RUDDER_DESKTOP_AUTH_BYPASS: "0" }).RUDDER_DESKTOP_AUTH_BYPASS,
    "0",
  );
  assert.equal(
    resolveDevDesktopEnvironment({ RUDDER_DESKTOP_AUTH_BYPASS: "false" }).RUDDER_DESKTOP_AUTH_BYPASS,
    "false",
  );
});

test("drops inherited production runtime identity before resolving pnpm dev", () => {
  const isolated = isolateDevShellFromParentRuntime({
    PATH: "/usr/bin",
    RUDDER_OPERATOR_HOME: "/Users/operator",
    RUDDER_LOCAL_ENV: "prod_local",
    RUDDER_INSTANCE_ID: "default",
    RUDDER_RUNTIME_OWNER_KIND: "desktop",
    RUDDER_HOME: "/tmp/production-home",
    RUDDER_CONFIG: "/tmp/production-config.json",
    RUDDER_DESKTOP_USER_DATA_DIR: "/tmp/production-user-data",
    RUDDER_ORGANIZATION_WORKSPACE_HOME: "/tmp/production-workspaces",
    PORT: "3200",
    RUDDER_EMBEDDED_POSTGRES_PORT: "54339",
    DATABASE_URL: "postgres://production",
  });

  assert.equal(isolated.PATH, "/usr/bin");
  assert.equal(isolated.RUDDER_OPERATOR_HOME, "/Users/operator");
  assert.equal(isolated.RUDDER_LOCAL_ENV, undefined);
  assert.equal(isolated.RUDDER_INSTANCE_ID, undefined);
  assert.equal(isolated.RUDDER_RUNTIME_OWNER_KIND, undefined);
  assert.equal(isolated.RUDDER_HOME, undefined);
  assert.equal(isolated.RUDDER_CONFIG, undefined);
  assert.equal(isolated.RUDDER_DESKTOP_USER_DATA_DIR, undefined);
  assert.equal(isolated.RUDDER_ORGANIZATION_WORKSPACE_HOME, undefined);
  assert.equal(isolated.PORT, undefined);
  assert.equal(isolated.RUDDER_EMBEDDED_POSTGRES_PORT, undefined);
  assert.equal(isolated.DATABASE_URL, undefined);
});

test("resolves the dev profile after removing inherited production runtime identity", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-dev-parent-runtime-"));
  const { env } = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: isolateDevShellFromParentRuntime({
      RUDDER_LOCAL_ENV: "prod_local",
      RUDDER_INSTANCE_ID: "default",
      RUDDER_RUNTIME_OWNER_KIND: "desktop",
      PORT: "3200",
      RUDDER_EMBEDDED_POSTGRES_PORT: "54339",
    }),
  });

  assert.equal(env.RUDDER_LOCAL_ENV, "dev");
  assert.equal(env.RUDDER_INSTANCE_ID, "dev");
  assert.equal(env.PORT, "3100");
  assert.equal(env.RUDDER_EMBEDDED_POSTGRES_PORT, "54329");
});

test("drops a protected default instance even when other runtime markers are absent", () => {
  const isolated = isolateDevShellFromParentRuntime({
    PATH: "/usr/bin",
    RUDDER_INSTANCE_ID: "default",
    PORT: "3200",
  });

  assert.equal(isolated.PATH, "/usr/bin");
  assert.equal(isolated.RUDDER_INSTANCE_ID, undefined);
  assert.equal(isolated.PORT, undefined);
});

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
