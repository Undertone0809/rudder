import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  applyGitCredentialHelperPolicyEnv,
  applyGitIdentityPreparationEnv,
  ensureGitIdentityFileConfig,
  ensureGitRepositoryIdentityConfig,
  isUnsafeGitIdentityEmail,
} from "./git-identity.js";

const execFileAsync = promisify(execFile);

function baseGitTestEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = { ...process.env };
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_CONFIG_GLOBAL",
    "XDG_CONFIG_HOME",
  ] as const) {
    delete base[key];
  }
  return {
    ...base,
    ...env,
  };
}

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync("git", args, {
    cwd,
    env: baseGitTestEnv(env),
  });
}

async function createRepoWithoutStoredIdentity(root: string) {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, [
    "-c",
    "user.name=Setup User",
    "-c",
    "user.email=setup@example.com",
    "commit",
    "-m",
    "Initial commit",
  ]);
  await runGit(repo, ["checkout", "-B", "main"]);
  return repo;
}

async function gitAuthorIdent(cwd: string, env: NodeJS.ProcessEnv) {
  return execFileAsync("git", ["var", "GIT_AUTHOR_IDENT"], {
    cwd,
    env: baseGitTestEnv(env),
  });
}

describe("git identity guard", () => {
  it("rejects local-host fallback emails as unsafe identities", () => {
    expect(isUnsafeGitIdentityEmail("zeeland@ZeelanddeMacBook-Pro.local")).toBe(true);
    expect(isUnsafeGitIdentityEmail("72488598+Undertone0809@users.noreply.github.com")).toBe(false);
  });

  it("seeds isolated HOME Git config from repository identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-git-identity-repo-"));
    try {
      const repo = await createRepoWithoutStoredIdentity(root);
      const isolatedHome = path.join(root, "agent-home");
      await runGit(repo, ["config", "user.name", "Rudder Agent"]);
      await runGit(repo, ["config", "user.email", "rudder-agent@example.com"]);

      const result = await ensureGitIdentityFileConfig({
        cwd: repo,
        home: isolatedHome,
        sourceEnv: baseGitTestEnv({
          HOME: path.join(root, "empty-home"),
          GIT_CONFIG_NOSYSTEM: "1",
        }),
      });

      expect(result.identity).toMatchObject({
        name: "Rudder Agent",
        email: "rudder-agent@example.com",
        source: "repository",
      });
      await expect(fs.readFile(path.join(isolatedHome, ".gitconfig"), "utf8")).resolves.toContain(
        "useConfigOnly = true",
      );
      const ident = await gitAuthorIdent(repo, {
        HOME: isolatedHome,
        GIT_CONFIG_NOSYSTEM: "1",
      });
      expect(ident.stdout).toContain("Rudder Agent <rudder-agent@example.com>");
      expect(ident.stdout).not.toContain(".local");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("copies only safe host global Git identity into the isolated config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-git-identity-include-"));
    try {
      const repo = await createRepoWithoutStoredIdentity(root);
      const hostHome = path.join(root, "host-home");
      const isolatedHome = path.join(root, "agent-home");
      await fs.mkdir(hostHome, { recursive: true });
      await fs.writeFile(
        path.join(hostHome, ".gitconfig"),
        [
          "[user]",
          "\tname = Host Operator",
          "\temail = operator@example.com",
          "[credential]",
          "\thelper = store",
        ].join("\n") + "\n",
        "utf8",
      );

      const result = await ensureGitIdentityFileConfig({
        cwd: repo,
        home: isolatedHome,
        sourceEnv: baseGitTestEnv({
          HOME: hostHome,
          GIT_CONFIG_NOSYSTEM: "1",
        }),
      });

      expect(result.identity).toMatchObject({
        name: "Host Operator",
        email: "operator@example.com",
        source: "global",
      });
      await expect(runGit(repo, [
        "config",
        "--get-all",
        "credential.helper",
      ], {
        HOME: isolatedHome,
        GIT_CONFIG_GLOBAL: path.join(isolatedHome, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      })).rejects.toMatchObject({ stdout: "" });
      await expect(runGit(repo, [
        "config",
        "--get",
        "user.email",
      ], {
        HOME: isolatedHome,
        GIT_CONFIG_GLOBAL: path.join(isolatedHome, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      })).resolves.toMatchObject({ stdout: "operator@example.com\n" });
      const managedConfig = await fs.readFile(path.join(isolatedHome, ".gitconfig"), "utf8");
      expect(managedConfig).not.toContain("[include]");
      expect(managedConfig).not.toContain("helper = store");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects a narrow gh-backed Git credential helper policy through env config", async () => {
    const env: Record<string, string> = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.version",
      GIT_CONFIG_VALUE_0: "2",
    };

    applyGitCredentialHelperPolicyEnv(env);

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "protocol.version",
      GIT_CONFIG_VALUE_0: "2",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "!gh auth git-credential",
    });
  });

  it("prevents Git fallback commits when isolated HOME has no usable identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-git-identity-missing-"));
    try {
      const repo = await createRepoWithoutStoredIdentity(root);
      const isolatedHome = path.join(root, "agent-home");

      const result = await ensureGitIdentityFileConfig({
        cwd: repo,
        home: isolatedHome,
        sourceEnv: baseGitTestEnv({
          HOME: path.join(root, "empty-home"),
          GIT_CONFIG_NOSYSTEM: "1",
        }),
      });

      expect(result.identity).toBeNull();
      await expect(gitAuthorIdent(repo, {
        HOME: isolatedHome,
        GIT_CONFIG_NOSYSTEM: "1",
      })).rejects.toMatchObject({
        stderr: expect.not.stringContaining(".local"),
      });
      await expect(execFileAsync("git", ["commit", "--allow-empty", "-m", "agent commit"], {
        cwd: repo,
        env: baseGitTestEnv({
          HOME: isolatedHome,
          GIT_CONFIG_NOSYSTEM: "1",
        }),
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("auto-detection is disabled"),
      });
      const count = await runGit(repo, ["rev-list", "--count", "HEAD"]);
      expect(count.stdout.trim()).toBe("1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse stale managed HOME Git identity when current sources are missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-git-identity-stale-managed-"));
    try {
      const repo = await createRepoWithoutStoredIdentity(root);
      const isolatedHome = path.join(root, "agent-home");
      await fs.mkdir(isolatedHome, { recursive: true });
      await fs.writeFile(
        path.join(isolatedHome, ".gitconfig"),
        [
          "[user]",
          "\tname = Old Operator",
          "\temail = old@example.com",
          "\tuseConfigOnly = true",
        ].join("\n") + "\n",
        "utf8",
      );

      const result = await ensureGitIdentityFileConfig({
        cwd: repo,
        home: isolatedHome,
        sourceEnv: baseGitTestEnv({
          HOME: path.join(root, "empty-home"),
          GIT_CONFIG_NOSYSTEM: "1",
        }),
      });

      expect(result.identity).toBeNull();
      const managedConfig = await fs.readFile(path.join(isolatedHome, ".gitconfig"), "utf8");
      expect(managedConfig).toContain("useConfigOnly = true");
      expect(managedConfig).not.toContain("old@example.com");
      await expect(gitAuthorIdent(repo, {
        HOME: isolatedHome,
        GIT_CONFIG_NOSYSTEM: "1",
      })).rejects.toMatchObject({
        stderr: expect.not.stringContaining("old@example.com"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies an isolated Git config and clears unsafe inherited identity env", async () => {
    const env = {
      GIT_AUTHOR_NAME: "Host User",
      GIT_AUTHOR_EMAIL: "host@machine.local",
      GIT_COMMITTER_NAME: "Host User",
      GIT_COMMITTER_EMAIL: "host@machine.local",
    };

    applyGitIdentityPreparationEnv(env, {
      identity: null,
      configTarget: "/tmp/rudder-agent-home/.gitconfig",
      configuredUseConfigOnly: true,
      warnings: [],
    });

    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: "/tmp/rudder-agent-home/.gitconfig",
    });
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it("applies isolated Git config without injecting resolved identity env", async () => {
    const env: Record<string, string> = {};

    applyGitIdentityPreparationEnv(env, {
      identity: {
        name: "Rudder Operator",
        email: "operator@example.com",
        source: "global",
      },
      configTarget: "/tmp/rudder-agent-home/.gitconfig",
      configuredUseConfigOnly: true,
      warnings: [],
    });

    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: "/tmp/rudder-agent-home/.gitconfig",
    });
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it("preserves explicit safe inherited identity env", async () => {
    const env = {
      GIT_AUTHOR_NAME: "Rudder Operator",
      GIT_AUTHOR_EMAIL: "operator@example.com",
      GIT_COMMITTER_NAME: "Rudder Operator",
      GIT_COMMITTER_EMAIL: "operator@example.com",
    };

    applyGitIdentityPreparationEnv(env, {
      identity: {
        name: "Rudder Operator",
        email: "operator@example.com",
        source: "environment",
      },
      configTarget: "/tmp/rudder-agent-home/.gitconfig",
      configuredUseConfigOnly: true,
      warnings: [],
    });

    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: "/tmp/rudder-agent-home/.gitconfig",
      GIT_AUTHOR_NAME: "Rudder Operator",
      GIT_AUTHOR_EMAIL: "operator@example.com",
      GIT_COMMITTER_NAME: "Rudder Operator",
      GIT_COMMITTER_EMAIL: "operator@example.com",
    });
  });

  it("configures repository useConfigOnly without inventing a fallback identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-git-identity-worktree-"));
    try {
      const repo = await createRepoWithoutStoredIdentity(root);

      const result = await ensureGitRepositoryIdentityConfig({
        cwd: repo,
        sourceEnv: baseGitTestEnv({
          HOME: path.join(root, "empty-home"),
          GIT_CONFIG_NOSYSTEM: "1",
        }),
      });

      expect(result.identity).toBeNull();
      await expect(runGit(repo, ["config", "--local", "--get", "user.useConfigOnly"])).resolves.toMatchObject({
        stdout: "true\n",
      });
      await expect(gitAuthorIdent(repo, {
        HOME: path.join(root, "empty-home"),
        GIT_CONFIG_NOSYSTEM: "1",
      })).rejects.toMatchObject({
        stderr: expect.not.stringContaining(".local"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});
