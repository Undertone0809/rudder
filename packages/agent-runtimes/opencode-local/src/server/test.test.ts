import { runChildProcess } from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareOpenCodeRuntimeProfile, resolveOpenCodeProfileDataHome } from "./execute.js";
import { discoverOpenCodeModels } from "./models.js";
import { testEnvironment } from "./test.js";

vi.mock("@rudderhq/agent-runtime-utils/server-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@rudderhq/agent-runtime-utils/server-utils")>(),
  runChildProcess: vi.fn(),
}));
vi.mock("./models.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./models.js")>(),
  discoverOpenCodeModels: vi.fn().mockResolvedValue([{ id: "test/hello", label: "Hello" }]),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-readiness-"));
  roots.push(root);
  const operatorHome = path.join(root, "operator");
  const sharedDataHome = path.join(operatorHome, ".local", "share");
  await fs.mkdir(path.join(sharedDataHome, "opencode"), { recursive: true });
  const sharedDb = path.join(sharedDataHome, "opencode", "opencode.db");
  await fs.writeFile(sharedDb, "user database sentinel");
  vi.stubEnv("RUDDER_OPERATOR_HOME", operatorHome);
  vi.stubEnv("RUDDER_HOME", path.join(root, "rudder"));
  vi.stubEnv("RUDDER_INSTANCE_ID", "readiness-test");
  vi.stubEnv("XDG_DATA_HOME", sharedDataHome);
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "shared-config-must-not-leak");
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(root, "shared-config"));
  const config = {
    command: process.execPath,
    cwd: root,
    model: "test/hello",
    providerHostId: "host-test",
    providerProfileId: "hermetic-profile",
    env: { XDG_DATA_HOME: sharedDataHome, HOME: operatorHome, PROVIDER_TEST_TOKEN: "fixture-token" },
  };
  return { root, operatorHome, sharedDb, config };
}

describe("OpenCode readiness isolation", () => {
  it("uses the execution host/profile data policy for discovery and the hello child, ignoring shared-path overrides", async () => {
    const f = await fixture();
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0, signal: null, timedOut: false, pid: 123, startedAt: new Date().toISOString(),
      stdout: JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }), stderr: "",
    });
    const result = await testEnvironment({ orgId: "org-readiness", agentRuntimeType: "opencode_local", config: f.config });
    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "opencode_hello_probe_passed")).toBe(true);
    const expectedDataHome = resolveOpenCodeProfileDataHome({ ...f.config, env: process.env }, "org-readiness");
    const executionProfile = await prepareOpenCodeRuntimeProfile({
      config: f.config, env: process.env, operatorHome: f.operatorHome, orgId: "org-readiness", onLog: async () => {},
    });
    const child = vi.mocked(runChildProcess).mock.calls[0]![3];
    const discovery = vi.mocked(discoverOpenCodeModels).mock.calls[0]![0]!;
    for (const env of [child.env, discovery.env]) {
      expect(env).toMatchObject({
        HOME: f.operatorHome,
        XDG_DATA_HOME: expectedDataHome,
        XDG_CONFIG_HOME: executionProfile.env.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: executionProfile.env.XDG_CACHE_HOME,
        OPENCODE_CONFIG: executionProfile.env.OPENCODE_CONFIG,
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        PROVIDER_TEST_TOKEN: "fixture-token",
      });
      expect(env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
      expect(env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
    }
    expect(expectedDataHome).toContain(`${path.sep}provider-data${path.sep}`);
    expect(await fs.readFile(f.sharedDb, "utf8")).toBe("user database sentinel");
    expect(await fs.realpath(path.dirname(executionProfile.overrides.OPENCODE_CONFIG))).toContain(f.root);
    expect(resolveOpenCodeProfileDataHome({ ...f.config, providerProfileId: "other-profile", env: process.env }, "org-readiness"))
      .not.toBe(expectedDataHome);
  });

  it("fails closed before discovery or child execution if the isolated profile cannot be prepared", async () => {
    const f = await fixture();
    const blockedHome = path.join(f.root, "not-a-directory");
    await fs.writeFile(blockedHome, "blocked");
    vi.stubEnv("RUDDER_HOME", blockedHome);
    const result = await testEnvironment({ orgId: "org-readiness", agentRuntimeType: "opencode_local", config: f.config });
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "opencode_profile_preparation_failed")).toBe(true);
    expect(discoverOpenCodeModels).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(await fs.readFile(f.sharedDb, "utf8")).toBe("user database sentinel");
  });

  it("a real probe child creates its database only under the configured isolated profile", async () => {
    const f = await fixture();
    const command = path.join(f.root, "opencode-fixture");
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.env.XDG_DATA_HOME, "opencode");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "opencode.db"), "isolated probe sentinel");
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
`, { mode: 0o700 });
    const actual = await vi.importActual<typeof import("@rudderhq/agent-runtime-utils/server-utils")>("@rudderhq/agent-runtime-utils/server-utils");
    vi.mocked(runChildProcess).mockImplementation(actual.runChildProcess);
    const config = { ...f.config, command };
    const result = await testEnvironment({ orgId: "org-readiness", agentRuntimeType: "opencode_local", config });
    expect(result.status).toBe("pass");
    const dataHome = resolveOpenCodeProfileDataHome({ ...config, env: process.env }, "org-readiness");
    expect(await fs.readFile(path.join(dataHome, "opencode", "opencode.db"), "utf8")).toBe("isolated probe sentinel");
    expect(await fs.readFile(f.sharedDb, "utf8")).toBe("user database sentinel");
  });
});
