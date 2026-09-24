import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexSkills } from "./skills.js";
import { resolveManagedCodexHomeDir } from "./codex-home.js";

describe("Codex skill source projection", () => {
  const tempRoots: string[] = [];
  const previousEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const key of previousEnv.keys()) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("labels retained provider-native CODEX_HOME skills separately from Rudder skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-skills-source-"));
    tempRoots.push(root);
    const rudderHome = path.join(root, "rudder-home");
    const nativeSkill = path.join(
      resolveManagedCodexHomeDir({ RUDDER_HOME: rudderHome }, "org-1", "agent-1"),
      "skills",
      ".system",
      "native-system",
      "SKILL.md",
    );
    await mkdir(path.dirname(nativeSkill), { recursive: true });
    await writeFile(nativeSkill, "# Native\n", "utf8");
    for (const key of ["RUDDER_HOME", "RUDDER_INSTANCE_ID"]) {
      previousEnv.set(key, process.env[key]);
    }
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "default";

    const snapshot = await listCodexSkills({
      agentId: "agent-1",
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      config: {},
    });
    const nativeEntry = snapshot.entries.find((entry) => entry.key === ".system");

    expect(nativeEntry).toMatchObject({
      managed: false,
      state: "external",
      originLabel: "Provider-native Codex",
      locationLabel: "authorized provider CODEX_HOME/skills",
      detail: "Retained from the authorized Codex profile; outside Rudder skill enablement.",
      readOnly: true,
    });
  });
});
