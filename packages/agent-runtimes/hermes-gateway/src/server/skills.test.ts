import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listHermesGatewaySkills, syncHermesGatewaySkills } from "./skills.js";

const cleanupDirs = new Set<string>();

async function createSkill(root: string, slug: string, content = `# ${slug}\n`): Promise<string> {
  const skillRoot = path.join(root, slug);
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), content, "utf8");
  return skillRoot;
}

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

describe("Hermes gateway skill sync", () => {
  it("reports an ephemeral snapshot and applies full desired-set replacement idempotently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-skill-sync-"));
    cleanupDirs.add(root);
    const alpha = await createSkill(root, "alpha");
    const beta = await createSkill(root, "beta");
    const ctx = {
      agentId: "agent-hermes-1",
      orgId: "org-hermes-1",
      agentRuntimeType: "hermes_gateway",
      config: {
        rudderRuntimeSkills: [
          { key: "org:org-hermes-1/alpha", runtimeName: "alpha", source: alpha },
          { key: "org:org-hermes-1/beta", runtimeName: "beta", source: beta },
        ],
        rudderSkillSync: { desiredSkills: ["org:org-hermes-1/alpha"] },
      },
    } as const;

    const before = await listHermesGatewaySkills(ctx);
    expect(before).toMatchObject({ supported: true, mode: "ephemeral", warnings: [] });
    expect(before.desiredSkills).toEqual(["org:org-hermes-1/alpha"]);
    expect(before.entries.find((entry) => entry.key.endsWith("/alpha"))).toMatchObject({ desired: true, state: "configured", targetPath: null });
    expect(before.entries.find((entry) => entry.key.endsWith("/beta"))).toMatchObject({ desired: false, state: "available", targetPath: null });

    const replaced = await syncHermesGatewaySkills(ctx, ["org:org-hermes-1/beta"]);
    const repeated = await syncHermesGatewaySkills(ctx, ["org:org-hermes-1/beta"]);
    expect(replaced.desiredSkills).toEqual(["org:org-hermes-1/beta"]);
    expect(repeated).toEqual(replaced);
    expect(replaced.entries.find((entry) => entry.key.endsWith("/alpha"))?.desired).toBe(false);
    expect(replaced.entries.find((entry) => entry.key.endsWith("/beta"))?.desired).toBe(true);

    const cleared = await syncHermesGatewaySkills(ctx, []);
    expect(cleared.desiredSkills).toEqual([]);
    expect(cleared.entries.every((entry) => !entry.desired && entry.state === "available")).toBe(true);
  });

  it("keeps an unavailable desired skill visible as a fail-closed diagnostic", async () => {
    const snapshot = await listHermesGatewaySkills({
      agentId: "agent-hermes-2",
      orgId: "org-hermes-2",
      agentRuntimeType: "hermes_gateway",
      config: {
        rudderRuntimeSkills: [{ key: "org:org-hermes-2/alpha", runtimeName: "alpha", source: "/unreadable/alpha" }],
        rudderSkillSync: { desiredSkills: ["org:org-hermes-2/missing"] },
      },
    });

    expect(snapshot.supported).toBe(true);
    expect(snapshot.warnings).toEqual([
      'Desired skill "org:org-hermes-2/missing" is unavailable and the next Hermes Run will fail closed.',
    ]);
    expect(snapshot.entries.find((entry) => entry.key.endsWith("/missing"))).toMatchObject({
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
    });
  });
});
