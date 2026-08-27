import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isolateDevShellFromParentRuntime,
  resolveDevAccessEnvironment,
  resolveDevDesktopEnvironment,
  resolveDevScriptEnvironment,
  resolveStandaloneDevUiCommandArgs,
  resolveStandaloneDevUiOrigin,
} from "./dev-local-env.mjs";

test("resolves the standalone Vite origin alongside the selected API port", () => {
  assert.equal(resolveStandaloneDevUiOrigin({ PORT: "3100" }), "http://127.0.0.1:5173");
  assert.equal(resolveStandaloneDevUiOrigin({ PORT: "3412" }), "http://127.0.0.1:5485");
  assert.equal(
    resolveStandaloneDevUiOrigin({ PORT: "3412", RUDDER_UI_PORT: "6200" }),
    "http://127.0.0.1:6200",
  );
  assert.throws(
    () => resolveStandaloneDevUiOrigin({ PORT: "3100", RUDDER_UI_PORT: "70000" }),
    /Invalid standalone Vite UI port/,
  );
});

test("forwards the standalone Vite host without a pnpm separator argument", () => {
  assert.deepEqual(resolveStandaloneDevUiCommandArgs(), [
    "--filter",
    "@rudderhq/ui",
    "dev",
    "--host",
    "127.0.0.1",
  ]);
});

test("normalizes authenticated/private CLI flags into an integrated dev environment", () => {
  const resolved = resolveDevAccessEnvironment({
    args: ["--authenticatedPrivate", "--inspect-runtime"],
    baseEnv: {},
  });

  assert.equal(resolved.authenticated, true);
  assert.equal(resolved.authenticatedPrivateRequested, true);
  assert.equal(resolved.standaloneUiEnabled, false);
  assert.deepEqual(resolved.forwardedArgs, ["--inspect-runtime"]);
  assert.equal(resolved.env.RUDDER_DEPLOYMENT_MODE, "authenticated");
  assert.equal(resolved.env.RUDDER_DEPLOYMENT_EXPOSURE, "private");
  assert.equal(resolved.env.RUDDER_AUTH_BASE_URL_MODE, "auto");
  assert.equal(resolved.env.RUDDER_UI_DEV_MIDDLEWARE, "true");
  assert.equal(resolved.env.HOST, "0.0.0.0");
});

test("keeps npm-config authenticated/private compatibility paths on the integrated UI", () => {
  for (const npmConfigKey of [
    "npm_config_tailscale_auth",
    "npm_config_authenticated_private",
  ]) {
    const resolved = resolveDevAccessEnvironment({
      args: [],
      baseEnv: { [npmConfigKey]: "true" },
    });

    assert.equal(resolved.authenticated, true, npmConfigKey);
    assert.equal(resolved.standaloneUiEnabled, false, npmConfigKey);
    assert.equal(resolved.env.RUDDER_UI_DEV_MIDDLEWARE, "true", npmConfigKey);
  }
});

test("respects canonical environment and repo config authenticated modes", () => {
  const fromEnvironment = resolveDevAccessEnvironment({
    args: [],
    baseEnv: {
      RUDDER_DEPLOYMENT_MODE: "authenticated",
      RUDDER_DEPLOYMENT_EXPOSURE: "private",
      RUDDER_UI_DEV_MIDDLEWARE: "false",
    },
  });
  assert.equal(fromEnvironment.authenticated, true);
  assert.equal(fromEnvironment.standaloneUiEnabled, false);
  assert.equal(fromEnvironment.env.RUDDER_UI_DEV_MIDDLEWARE, "true");

  const fromConfig = resolveDevAccessEnvironment({
    args: [],
    baseEnv: {},
    repoLocalConfig: { server: { deploymentMode: "authenticated", exposure: "private" } },
  });
  assert.equal(fromConfig.authenticated, true);
  assert.equal(fromConfig.standaloneUiEnabled, false);
  assert.equal(fromConfig.env.RUDDER_UI_DEV_MIDDLEWARE, "true");
});

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

test("defaults development startup to non-interactive automatic migrations", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-dev-migrations-"));
  const resolved = resolveDevScriptEnvironment({ repoRoot, baseEnv: {} });

  assert.equal(resolved.env.RUDDER_MIGRATION_AUTO_APPLY, "true");
  assert.equal(resolved.env.RUDDER_MIGRATION_PROMPT, "never");

  const overridden = resolveDevScriptEnvironment({
    repoRoot,
    baseEnv: {
      RUDDER_MIGRATION_AUTO_APPLY: "false",
      RUDDER_MIGRATION_PROMPT: "ask",
    },
  });

  assert.equal(overridden.env.RUDDER_MIGRATION_AUTO_APPLY, "false");
  assert.equal(overridden.env.RUDDER_MIGRATION_PROMPT, "ask");
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
