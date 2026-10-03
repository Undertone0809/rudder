import { describe, expect, it } from "vitest";
import {
  buildRuntimeProviderProfileSnapshot,
  runtimeConfigFromProviderProfileSnapshot,
  sanitizeRuntimeProviderProfileSnapshot,
} from "./runtime-provider-profile-snapshot.js";

describe("runtime provider profile snapshots", () => {
  it("keeps static OpenCode transport bounded and drops auth and dynamic fields", () => {
    const snapshot = buildRuntimeProviderProfileSnapshot("opencode_local", {
      cwd: "/tmp/workspace",
      command: "opencode",
      providerVersion: "1.2.3",
      serverCommand: "opencode",
      exportCommand: "opencode",
      exportEnv: {
        HOME: "/tmp/operator",
        XDG_CONFIG_HOME: "/tmp/managed/config",
        OPENCODE_CONFIG: "/Users/operator/.config/opencode.json",
        OPENAI_API_KEY: "secret",
      },
      serverUrl: "http://127.0.0.1:43123",
    });

    expect(snapshot).toEqual({
      runtimeType: "opencode_local",
      cwd: "/tmp/workspace",
      providerVersion: "1.2.3",
      command: "opencode",
      serverCommand: "opencode",
      exportCommand: "opencode",
      exportEnv: { HOME: "/tmp/operator", XDG_CONFIG_HOME: "/tmp/managed/config" },
    });
  });

  it("projects generated Claude, Hermes, Pi, Cursor, and Codex fields without env secrets", () => {
    expect(buildRuntimeProviderProfileSnapshot("claude_local", {
      cwd: "/tmp/claude",
      command: "claude",
      claudeConfigDir: "/tmp/claude-config",
      env: { ANTHROPIC_API_KEY: "secret" },
      providerVersion: "2.1.0",
    })).toMatchObject({ cwd: "/tmp/claude", command: "claude", claudeConfigDir: "/tmp/claude-config" });
    expect(buildRuntimeProviderProfileSnapshot("hermes_gateway", {
      cwd: "/tmp/hermes",
      hermesAcpCommand: "hermes",
      hermesAcpArgs: ["acp"],
      hermesAcpProtocolVersion: 1,
      hermesPythonCommand: "/tmp/hermes/venv/bin/python3",
      hermesSourcePath: "/tmp/hermes/hermes-agent",
      hermesHome: "/tmp/hermes-home",
    })).toMatchObject({
      hermesAcpCommand: "hermes",
      hermesAcpArgs: ["acp"],
      hermesAcpProtocolVersion: 1,
      hermesPythonCommand: "/tmp/hermes/venv/bin/python3",
      hermesSourcePath: "/tmp/hermes/hermes-agent",
    });
    expect(buildRuntimeProviderProfileSnapshot("pi_local", {
      cwd: "/tmp/pi",
      sessionDir: "/tmp/pi-session",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-session", API_KEY: "secret" },
      rpcArgs: ["--extension", "not-persisted-here"],
    })).toEqual({
      runtimeType: "pi_local",
      cwd: "/tmp/pi",
      sessionDir: "/tmp/pi-session",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-session" },
    });
    expect(buildRuntimeProviderProfileSnapshot("cursor", {
      cwd: "/tmp/cursor",
      cursorAcpCommand: "agent",
      cursorAcpProtocolVersion: 1,
      cursorAcpAuthMethodId: "cursor_login",
      env: { CURSOR_TOKEN: "secret" },
    })).toMatchObject({ cursorAcpCommand: "agent", cursorAcpProtocolVersion: 1, authMethodId: "cursor_login" });
    expect(buildRuntimeProviderProfileSnapshot("codex_local", {
      cwd: "/tmp/codex",
      codexHome: "/tmp/codex-home",
      nativeCapabilityMethods: { threadRead: true, threadResume: false, threadFork: true },
      env: { CODEX_API_KEY: "secret" },
    })).toMatchObject({
      codexHome: "/tmp/codex-home",
      nativeCapabilityMethods: { threadRead: true, threadResume: false, threadFork: true },
    });
  });

  it("sanitizes legacy or caller-shaped snapshots through the same static allowlist", () => {
    const snapshot = sanitizeRuntimeProviderProfileSnapshot({
      runtimeType: "pi_local",
      cwd: "/tmp/pi",
      sessionDir: "/tmp/pi-session",
      rpcArgs: ["--extension", "attacker"],
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-session", TOKEN: "secret" },
    });
    expect(snapshot).toEqual({
      runtimeType: "pi_local",
      cwd: "/tmp/pi",
      sessionDir: "/tmp/pi-session",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-session" },
    });
    expect(runtimeConfigFromProviderProfileSnapshot(snapshot)).toEqual({
      cwd: "/tmp/pi",
      sessionDir: "/tmp/pi-session",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-session" },
    });
  });
});
