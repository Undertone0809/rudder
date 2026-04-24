import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

function normalizeAgentSlug(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function buildWorkspaceKey(name: string, agentId: string) {
  return `${normalizeAgentSlug(name)}--${agentId.replace(/-/g, "").toLowerCase().slice(0, 8)}`;
}

function resolveAgentWorkspacesRoot(orgId: string) {
  return path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    orgId,
    "workspaces",
    "agents",
  );
}

function resolveAgentWorkspaceRoot(orgId: string, workspaceKey: string) {
  return path.join(resolveAgentWorkspacesRoot(orgId), workspaceKey);
}

async function listAgentWorkspaceKeys(orgId: string) {
  const entries = await fs.readdir(resolveAgentWorkspacesRoot(orgId), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

test.describe("Agent rename workspace contract", () => {
  test("keeps managed instructions pinned to the original workspace after rename", async ({ request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Agent-Rename-Workspace-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "CTO",
        role: "engineer",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const originalWorkspaceKey = buildWorkspaceKey("CTO", agent.id);
    const renamedWorkspaceKey = buildWorkspaceKey("Ella", agent.id);
    const originalInstructionsRoot = path.join(
      resolveAgentWorkspaceRoot(organization.id, originalWorkspaceKey),
      "instructions",
    );

    const writeInstructionsRes = await request.put(`/api/agents/${agent.id}/instructions-bundle/file`, {
      data: {
        path: "AGENTS.md",
        content: "# Original instructions\n",
      },
    });
    expect(writeInstructionsRes.ok()).toBe(true);

    const renameRes = await request.patch(`/api/agents/${agent.id}`, {
      data: {
        name: "Ella",
      },
    });
    expect(renameRes.ok()).toBe(true);

    const bundleRes = await request.get(`/api/agents/${agent.id}/instructions-bundle`);
    expect(bundleRes.ok()).toBe(true);
    const bundle = await bundleRes.json() as {
      rootPath: string | null;
      files: Array<{ path: string }>;
    };

    expect(bundle.rootPath).toBe(originalInstructionsRoot);
    expect(bundle.files.map((file) => file.path)).toContain("AGENTS.md");
    expect(await listAgentWorkspaceKeys(organization.id)).toEqual([originalWorkspaceKey]);
    await expect(
      fs.readFile(path.join(originalInstructionsRoot, "AGENTS.md"), "utf8"),
    ).resolves.toBe("# Original instructions\n");
    await expect(
      fs.stat(resolveAgentWorkspaceRoot(organization.id, renamedWorkspaceKey)),
    ).rejects.toThrow();
  });
});
