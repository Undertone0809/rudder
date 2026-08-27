import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, projectWorkspaces } from "../../packages/db/src/index.ts";
import {
  E2E_BIN_DIR,
  E2E_DATABASE_URL,
  E2E_HOME,
} from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const cleanupPaths: string[] = [];

async function writeExecutable(filePath: string, contents: string) {
  await fs.writeFile(filePath, contents, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function resolveExecutableOutsideE2EBin(name: string) {
  const e2eBinDir = path.resolve(E2E_BIN_DIR);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry || path.resolve(entry) === e2eBinDir) continue;
    const candidate = path.join(entry, name);
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the inherited PATH.
    }
  }
  throw new Error(`Could not resolve ${name} outside the shared E2E bin directory`);
}

test.afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((candidate) =>
    fs.rm(candidate, { recursive: true, force: true })));
});

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("uses one Workspace Policy cwd while Project Sources remain context", async ({ page }) => {
  test.setTimeout(120_000);

  const suffix = randomUUID();
  const workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-assignment-workspace-"));
  const sourceCwdA = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-assignment-source-a-"));
  const sourceCwdB = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-assignment-source-b-"));
  const captureDir = path.join(E2E_HOME, `assignment-workspace-policy-${suffix}`);
  const cwdCapturePath = path.join(captureDir, "cwd.txt");
  const promptCapturePath = path.join(captureDir, "prompt.txt");
  const commandCapturePath = path.join(captureDir, "unexpected-command.txt");
  const runtimeScriptPath = path.join(captureDir, "runtime-capture.sh");
  cleanupPaths.push(workspaceCwd, sourceCwdA, sourceCwdB, captureDir);

  await fs.mkdir(path.join(workspaceCwd, "node_modules"), { recursive: true });
  await fs.mkdir(captureDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceCwd, "package.json"),
    JSON.stringify({ name: "stale-dependency-metadata", packageManager: "pnpm@9.15.4" }),
    "utf8",
  );
  await fs.writeFile(path.join(workspaceCwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await fs.writeFile(
    path.join(workspaceCwd, "node_modules", ".modules.yaml"),
    [
      "storeDir: /private/tmp/deleted-review/.pnpm-store/v3",
      "virtualStoreDir: /private/tmp/deleted-review/node_modules/.pnpm",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeExecutable(runtimeScriptPath, `#!/bin/bash
set -euo pipefail
pwd > ${JSON.stringify(cwdCapturePath)}
cat > ${JSON.stringify(promptCapturePath)}
printf '%s\\n' '{"type":"thread.started","thread_id":"assignment-workspace-e2e","model":"gpt-5.4"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"Workspace policy assignment completed."}}'
printf '%s\\n' '{"type":"turn.completed","result":"Workspace policy assignment completed.","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`);

  const [workspaceRealPath, originalPnpmPath] = await Promise.all([
    fs.realpath(workspaceCwd),
    resolveExecutableOutsideE2EBin("pnpm"),
  ]);
  const commandTrap = (originalCommand: string) => `#!/bin/bash
if [[ "$PWD" == ${JSON.stringify(workspaceRealPath)} ]]; then
  printf '%s %s\\n' "$(basename "$0")" "$*" >> ${JSON.stringify(commandCapturePath)}
  exit 97
fi
exec ${JSON.stringify(originalCommand)} "$@"
`;
  const nodeTrapPath = path.join(E2E_BIN_DIR, "node");
  const pnpmTrapPath = path.join(E2E_BIN_DIR, "pnpm");
  await writeExecutable(nodeTrapPath, commandTrap(process.execPath));
  await writeExecutable(pnpmTrapPath, commandTrap(originalPnpmPath));
  cleanupPaths.push(nodeTrapPath, pnpmTrapPath);

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Assignment Workspace Policy ${suffix}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Workspace Policy Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: runtimeScriptPath,
        model: "gpt-5.4",
      },
    },
  });
  expect(agentRes.ok(), await agentRes.text()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "Workspace Policy Project",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
      },
    },
  });
  expect(projectRes.ok(), await projectRes.text()).toBe(true);
  const project = await projectRes.json() as { id: string };

  const [projectWorkspace] = await e2eDb.insert(projectWorkspaces).values({
    orgId: organization.id,
    projectId: project.id,
    name: "Primary workspace",
    sourceType: "local_path",
    cwd: workspaceCwd,
    isPrimary: true,
  }).returning({ id: projectWorkspaces.id });
  expect(projectWorkspace?.id).toBeTruthy();

  const createSource = async (name: string, locator: string) => {
    const response = await page.request.post(`/api/orgs/${organization.id}/resources`, {
      data: {
        name,
        kind: "directory",
        sourceType: "external",
        locator,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<{ id: string }>;
  };
  const [sourceA, sourceB] = await Promise.all([
    createSource("Source A", sourceCwdA),
    createSource("Source B", sourceCwdB),
  ]);
  const attachSource = async (resourceId: string, sortOrder: number, isPrimary: boolean) => {
    const response = await page.request.post(
      `/api/projects/${project.id}/resources?orgId=${organization.id}`,
      { data: { resourceId, role: "working_set", sortOrder, isPrimary } },
    );
    expect(response.ok(), await response.text()).toBe(true);
  };
  await attachSource(sourceA.id, 20, false);
  await attachSource(sourceB.id, 10, true);

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Run from Workspace Policy cwd",
      description: "Multiple Sources are context, not competing working directories.",
      status: "todo",
      priority: "medium",
      projectId: project.id,
      projectWorkspaceId: projectWorkspace!.id,
      assigneeAgentId: agent.id,
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as { id: string };

  const readAssignmentRun = async () => {
    const response = await page.request.get(
      `/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    const runs = await response.json() as Array<{
      id: string;
      invocationSource: string;
      status: string;
      contextSnapshot?: Record<string, unknown> | null;
    }>;
    return runs.find((run) =>
      run.invocationSource === "assignment" && run.contextSnapshot?.issueId === issue.id) ?? null;
  };

  await expect.poll(async () => (await readAssignmentRun())?.status, {
    timeout: 60_000,
    intervals: [250, 500, 1_000],
  }).toBe("succeeded");
  const run = await readAssignmentRun();
  expect(run).not.toBeNull();

  await expect.poll(async () => (await fs.readFile(cwdCapturePath, "utf8")).trim(), {
    timeout: 10_000,
  }).toBe(workspaceRealPath);
  const prompt = await fs.readFile(promptCapturePath, "utf8");
  expect(prompt).toContain(sourceCwdA);
  expect(prompt).toContain(sourceCwdB);
  expect(workspaceCwd).not.toBe(sourceCwdA);
  expect(workspaceCwd).not.toBe(sourceCwdB);
  await expect(fs.access(commandCapturePath)).rejects.toMatchObject({ code: "ENOENT" });

  const eventsRes = await page.request.get(`/api/heartbeat-runs/${run!.id}/events`);
  expect(eventsRes.ok(), await eventsRes.text()).toBe(true);
  const events = await eventsRes.json() as Array<{ eventType: string }>;
  expect(events.map((event) => event.eventType)).not.toEqual(expect.arrayContaining([
    "runtime.assignment_preflight",
    "runtime.assignment_dependency_repair",
    "runtime.assignment_preflight_failed",
  ]));
});
