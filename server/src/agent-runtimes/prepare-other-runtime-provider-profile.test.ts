import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  stdout: "provider 3.14.15\n",
  stderr: "",
  error: null as Error | null,
  realPython: false,
  installedVersion: "0.21.0\n",
}));

vi.mock("node:child_process", () => ({
  execFile: Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      childProcessMock.calls.push({ command, args, options });
      if (childProcessMock.error) throw childProcessMock.error;
      if (args[0] === "-I") {
        if (childProcessMock.realPython) {
          const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
          return new Promise((resolve, reject) => {
            actual.execFile(command, args, options, (error, stdout, stderr) => {
              if (error) reject(error);
              else resolve({ stdout, stderr });
            });
          });
        }
        return { stdout: childProcessMock.installedVersion, stderr: "" };
      }
      return { stdout: childProcessMock.stdout, stderr: childProcessMock.stderr };
    },
  }),
}));

import { prepareOtherRuntimeProviderProfile, versionFromOutput } from "./prepare-other-runtime-provider-profile.js";

const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const pythonDiscovery = actualChildProcess.spawnSync("python3", ["-I", "-S", "-c", "import sys; print(sys.executable)"], {
  encoding: "utf8", timeout: 5_000,
});
const installedPython = pythonDiscovery.status === 0 ? pythonDiscovery.stdout.trim() : null;

describe("other runtime provider profile preparation", () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rudder-provider-profile-"));
    cwd = await mkdtemp(path.join(root, "workspace-"));
    childProcessMock.calls = [];
    childProcessMock.stdout = "provider 3.14.15\n";
    childProcessMock.stderr = "";
    childProcessMock.error = null;
    childProcessMock.realPython = false;
    childProcessMock.installedVersion = "0.21.0\n";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function hermesProfile(versionSource = '__version__ = "0.21.0"\n') {
    const hermesHome = path.join(root, "hermes-home");
    const sourcePath = path.join(hermesHome, "hermes-agent");
    await mkdir(path.join(sourcePath, "hermes_cli"), { recursive: true });
    await writeFile(path.join(sourcePath, "hermes_state.py"), "");
    await writeFile(path.join(sourcePath, "hermes_cli", "__init__.py"), versionSource);
    return {
      cwd, hermesHome, hermesSourcePath: sourcePath,
      hermesPythonCommand: installedPython ?? process.execPath,
      hermesChatBackend: "native_product_rpc",
      hermesAcpCommand: "/a/different/hermes",
      hermesProviderVersion: "99.0.0", providerVersion: "99.0.0",
    };
  }

  const prepareHermes = (config: Record<string, unknown>) => prepareOtherRuntimeProviderProfile({
    runtimeType: "hermes_gateway", orgId: "org", agentId: "agent", config,
  });

  it.runIf(installedPython)("reads the selected installed source without importing Hermes or trusting supplied versions", async () => {
    const sideEffect = path.join(root, "must-not-execute");
    const config = await hermesProfile(`"""\n__version__ = "88.0.0"\n"""\n__version__ = "0.21.0"\nopen(${JSON.stringify(sideEffect)}, "w").write("executed")\n`);
    childProcessMock.realPython = true;
    const result = await prepareHermes(config);
    expect(result).toMatchObject({ providerVersion: "0.21.0", hermesProviderVersion: "0.21.0", hermesSourcePath: config.hermesSourcePath });
    expect(config.providerVersion).toBe("99.0.0");
    await expect(access(sideEffect)).rejects.toThrow();
    expect(childProcessMock.calls).toHaveLength(1);
    expect(childProcessMock.calls[0]).toMatchObject({
      command: config.hermesPythonCommand,
      options: { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
    });
    expect(childProcessMock.calls[0].args.slice(0, 4)).toEqual(["-I", "-S", "-B", "-c"]);
    expect(childProcessMock.calls[0].args.at(-1)).toBe(config.hermesSourcePath);
  });

  it("uses installed source discovery for the implicitly selected Product RPC backend", async () => {
    const config = await hermesProfile();
    const result = await prepareHermes({ ...config, hermesChatBackend: undefined });
    expect(result.hermesProviderVersion).toBe("0.21.0");
    expect(childProcessMock.calls[0].command).toBe(config.hermesPythonCommand);
  });

  it.each(["acp", "native_runs_http"])("preserves the executable version probe for explicit %s even with an unrelated source", async (backend) => {
    const config = await hermesProfile();
    const result = await prepareHermes({ ...config, hermesChatBackend: backend });
    expect(result.hermesProviderVersion).toBe("3.14.15");
    expect(childProcessMock.calls).toEqual([expect.objectContaining({
      command: config.hermesAcpCommand, args: ["--version"], options: expect.objectContaining({ timeout: 15_000 }),
    })]);
  });

  it.each(["hermesPythonCommand", "hermesSourcePath"])("rejects missing or relative %s rather than trusting a supplied version or another home", async (field) => {
    const config = await hermesProfile();
    for (const value of [path.join(root, "missing"), "relative/path"]) {
      await expect(prepareHermes({ ...config, [field]: value })).rejects.toThrow("requires an available absolute");
    }
    expect(childProcessMock.calls).toHaveLength(0);
  });

  it.runIf(installedPython).each([
    ["absent declaration", "# __version__ = '9.9.9'\n"],
    ["dynamic declaration", "__version__ = str(21)\n"],
    ["duplicate declaration", "__version__ = '0.21.0'\n__version__ = '9.9.9'\n"],
    ["invalid version", "__version__ = 'unavailable'\n"],
    ["oversized module", "#".repeat(65_537)],
  ])("fails closed for an %s in the selected source", async (_name, content) => {
    childProcessMock.realPython = true;
    await expect(prepareHermes(await hermesProfile(content))).rejects.toThrow("installed version discovery failed");
    expect(childProcessMock.calls).toHaveLength(1);
    expect(childProcessMock.calls[0].args).not.toContain("--version");
  });

  it.runIf(installedPython)("rejects a missing version module and one linked to a different installation", async () => {
    const config = await hermesProfile();
    const modulePath = path.join(config.hermesSourcePath, "hermes_cli", "__init__.py");
    await rm(modulePath);
    childProcessMock.realPython = true;
    await expect(prepareHermes(config)).rejects.toThrow("installed version discovery failed");
    const otherModule = path.join(root, "other-init.py");
    await writeFile(otherModule, '__version__ = "9.9.9"');
    await symlink(otherModule, modulePath);
    await expect(prepareHermes(config)).rejects.toThrow("escapes selected source");
  });

  it("fails closed on a timed-out selected Python probe without a heavy CLI fallback", async () => {
    childProcessMock.error = new Error("ETIMEDOUT");
    await expect(prepareHermes(await hermesProfile())).rejects.toThrow("installed version discovery failed");
    expect(childProcessMock.calls).toHaveLength(1);
    expect(childProcessMock.calls[0].options).toMatchObject({ timeout: 5_000, killSignal: "SIGKILL" });
    expect(childProcessMock.calls[0].args).not.toContain("--version");
  });

  it("keeps custom ACP timeout failures on the bounded executable path", async () => {
    childProcessMock.error = new Error("ETIMEDOUT");
    await expect(prepareHermes({ ...await hermesProfile(), hermesChatBackend: "acp" })).rejects.toThrow("provider version discovery failed");
    expect(childProcessMock.calls).toHaveLength(1);
    expect(childProcessMock.calls[0]).toMatchObject({ args: ["--version"], options: { timeout: 15_000 } });
  });

  it("parses semver and Cursor date-style installed versions without accepting arbitrary text", () => {
    expect(versionFromOutput("Claude Code 2.1.216 (stable)")).toBe("2.1.216");
    expect(versionFromOutput("Cursor Agent 2026.06.19-20-24-33-653a7fb")).toBe("2026.06.19-20-24-33-653a7fb");
    expect(versionFromOutput("provider version unavailable")).toBeNull();
  });

  it("discovers Pi when its piped --version response is on stderr", async () => {
    childProcessMock.stdout = "";
    childProcessMock.stderr = "0.76.0\n";
    const result = await prepareOtherRuntimeProviderProfile({
      runtimeType: "pi_local", orgId: "org-profile", agentId: "agent-profile", config: { cwd },
    });
    expect(result.providerVersion).toBe("0.76.0");
    expect(result.piProviderVersion).toBe("0.76.0");
  });

  it("prepares all five default profiles from one actual --version probe each", async () => {
    const env = { RUDDER_HOME: root, RUDDER_INSTANCE_ID: "profile-test", HOME: "/untrusted/home" };
    const cases = [
      ["claude_local", "claude"],
      ["hermes_gateway", "hermes"],
      ["opencode_local", "opencode"],
      ["pi_local", "pi"],
      ["cursor", "agent"],
    ] as const;

    const prepared = await Promise.all(cases.map(([runtimeType]) => prepareOtherRuntimeProviderProfile({
      runtimeType,
      orgId: "org-profile",
      agentId: "agent-profile",
      config: { env },
      workspace: { cwd, source: "workspace" },
    })));

    expect(prepared.map((config) => config.providerVersion)).toEqual(cases.map(() => "3.14.15"));
    expect(prepared.map((config) => config.cwd)).toEqual(cases.map(() => cwd));
    expect(prepared[0]).toMatchObject({
      command: "claude",
      claudeProviderVersion: "3.14.15",
      claudeConfigDir: path.join(root, "instances", "profile-test", "organizations", "org-profile", "claude-home", ".claude"),
    });
    expect(prepared[1]).toMatchObject({
      hermesAcpCommand: "hermes",
      hermesAcpArgs: ["acp"],
      hermesAcpProtocolVersion: 1,
      hermesProviderVersion: "3.14.15",
    });
    expect(prepared[2]).toMatchObject({
      command: "opencode",
      serverCommand: "opencode",
      exportCommand: "opencode",
      exportEnv: {
        XDG_CONFIG_HOME: path.join(root, "instances", "profile-test", "organizations", "org-profile", "opencode-home", ".config"),
      },
    });
    expect(prepared[3]).toMatchObject({
      command: "pi",
      sessionDir: path.join(root, "instances", "profile-test", "organizations", "org-profile", "pi-home", ".pi", "paperclips"),
      rpcEnv: {
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "instances", "profile-test", "organizations", "org-profile", "pi-home", ".pi", "paperclips"),
      },
    });
    expect(prepared[4]).toMatchObject({
      command: "agent",
      cursorAcpCommand: "agent",
      cursorAcpProtocolVersion: 1,
      cursorProviderVersion: "3.14.15",
    });
    expect(childProcessMock.calls).toHaveLength(5);
    expect(childProcessMock.calls.every((call) => call.args.length === 1 && call.args[0] === "--version")).toBe(true);
    expect(childProcessMock.calls.every((call) => !call.args.includes("--model") && !call.args.includes("--session"))).toBe(true);
  });

  it("derives the read-only Hermes history profile only from a host-authorized Hermes home", async () => {
    const hermesHome = path.join(root, "hermes-home");
    const sourcePath = path.join(hermesHome, "hermes-agent");
    const pythonPath = path.join(sourcePath, "venv", "bin", "python3");
    await (await import("node:fs/promises")).mkdir(path.dirname(pythonPath), { recursive: true });
    await (await import("node:fs/promises")).writeFile(pythonPath, "", "utf8");
    await (await import("node:fs/promises")).writeFile(path.join(sourcePath, "hermes_state.py"), "", "utf8");

    const prepared = await prepareOtherRuntimeProviderProfile({
      runtimeType: "hermes_gateway",
      orgId: "org",
      agentId: "agent",
      config: { env: { HERMES_HOME: hermesHome } },
      workspace: { cwd },
    });

    expect(prepared).toMatchObject({
      hermesHome,
      hermesPythonCommand: pythonPath,
      hermesSourcePath: sourcePath,
    });
  });

  it("matches execute cwd precedence and does not mutate caller config", async () => {
    const configured = { command: process.execPath, cwd, providerVersion: "stale", env: { RUDDER_HOME: root } };
    const prepared = await prepareOtherRuntimeProviderProfile({
      runtimeType: "claude_local",
      orgId: "org",
      agentId: "agent",
      config: configured,
      workspace: { cwd: path.join(root, "workspace-not-used"), source: "agent_home" },
    });

    expect(prepared.cwd).toBe(cwd);
    expect(prepared.providerVersion).toBe("3.14.15");
    expect(configured).toEqual({ command: process.execPath, cwd, providerVersion: "stale", env: { RUDDER_HOME: root } });
  });

  it("does not invent dynamic transport authority", async () => {
    const openCode = await prepareOtherRuntimeProviderProfile({
      runtimeType: "opencode_local",
      orgId: "org",
      agentId: "agent",
      config: { command: process.execPath, env: { RUDDER_HOME: root } },
      workspace: { cwd },
    });
    const pi = await prepareOtherRuntimeProviderProfile({
      runtimeType: "pi_local",
      orgId: "org",
      agentId: "agent",
      config: { command: process.execPath, env: { RUDDER_HOME: root } },
      workspace: { cwd },
    });

    expect(openCode.serverUrl).toBeUndefined();
    expect(pi.rpcArgs).toBeUndefined();
  });

  it("does not propagate an operator OpenCode config path into the managed export environment", async () => {
    const prepared = await prepareOtherRuntimeProviderProfile({
      runtimeType: "opencode_local",
      orgId: "org",
      agentId: "agent",
      config: {
        command: process.execPath,
        exportEnv: { OPENCODE_CONFIG: path.join(os.homedir(), ".config", "opencode.json") },
        env: { RUDDER_HOME: root },
      },
      workspace: { cwd },
    });

    expect((prepared.exportEnv as Record<string, string>).OPENCODE_CONFIG).toBeUndefined();
  });

  it("rejects an untrusted OpenCode server and leaves non-native runtimes untouched", async () => {
    await expect(prepareOtherRuntimeProviderProfile({
      runtimeType: "opencode_local",
      orgId: "org",
      agentId: "agent",
      config: { command: process.execPath, serverUrl: "https://example.invalid", env: { RUDDER_HOME: root } },
      workspace: { cwd },
    })).rejects.toThrow("loopback managed server URL");

    const legacy = { command: "not-run", providerVersion: "legacy" };
    await expect(prepareOtherRuntimeProviderProfile({
      runtimeType: "gemini_local",
      orgId: "org",
      agentId: "agent",
      config: legacy,
      workspace: { cwd },
    })).resolves.toBe(legacy);
    expect(childProcessMock.calls).toHaveLength(0);
  });

  it("fails closed on missing or unparseable installation versions instead of trusting stale config", async () => {
    childProcessMock.stdout = "provider version unavailable\n";
    await expect(prepareOtherRuntimeProviderProfile({
      runtimeType: "pi_local",
      orgId: "org",
      agentId: "agent",
      config: { command: process.execPath, providerVersion: "stale", env: { RUDDER_HOME: root } },
      workspace: { cwd },
    })).rejects.toThrow("no parseable version");

    childProcessMock.stdout = "provider 3.14.15\n";
    childProcessMock.error = new Error("ENOENT");
    await expect(prepareOtherRuntimeProviderProfile({
      runtimeType: "cursor",
      orgId: "org",
      agentId: "agent",
      config: { command: process.execPath, providerVersion: "stale", env: { RUDDER_HOME: root } },
      workspace: { cwd },
    })).rejects.toThrow("version discovery failed");
  });

  it("rejects relative cwd before probing a provider", async () => {
    await expect(prepareOtherRuntimeProviderProfile({
      runtimeType: "claude_local",
      orgId: "org",
      agentId: "agent",
      config: { command: process.execPath, cwd: "relative/path" },
    })).rejects.toThrow("Working directory must be an absolute path");
    expect(childProcessMock.calls).toHaveLength(0);
  });
});
