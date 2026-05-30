import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { E2E_CLAUDE_STUB, E2E_CODEX_STUB, E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

const BUNDLED_RUDDER_SKILL_SLUGS = [
  "conversation-to-skill",
  "para-memory-files",
  "rudder",
  "rudder-create-agent",
  "rudder-create-plugin",
  "skill-creator",
  "skill-optimizer",
] as const;

async function resolveSingleAgentWorkspaceRoot(orgId: string) {
  const agentsRoot = path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    orgId,
    "workspaces",
    "agents",
  );
  await expect.poll(async () => {
    try {
      return (await fs.readdir(agentsRoot)).length;
    } catch {
      return 0;
    }
  }).toBe(1);
  const entries = await fs.readdir(agentsRoot);
  expect(entries).toHaveLength(1);
  return path.join(agentsRoot, entries[0]!);
}

async function writeHostSkill(root: string, segments: string[], slug: string) {
  const skillDir = path.join(root, ...segments, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: Host skill that must stay discovery-only unless selected.\n---\n\n# ${slug}\n`,
    "utf8",
  );
}

async function writeCodexSkillCaptureStub(commandPath: string, capturePath: string) {
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

process.stdin.resume();
process.stdin.on("end", () => {
  const skillsHome = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : null;
  const systemHome = skillsHome ? path.join(skillsHome, ".system") : null;
  const payload = {
    codexHome: process.env.CODEX_HOME || null,
    rootEntries: skillsHome && fs.existsSync(skillsHome) ? fs.readdirSync(skillsHome).sort() : [],
    systemEntries: systemHome && fs.existsSync(systemHome) ? fs.readdirSync(systemHome).sort() : [],
  };
  fs.mkdirSync(path.dirname(${JSON.stringify(capturePath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload), "utf8");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-skill-surface", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "captured" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeClaudeSkillBoundaryCaptureStub(commandPath: string, capturePath: string) {
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const home = process.env.HOME || null;
  const skillsHome = home ? path.join(home, ".claude", "skills") : null;
  const claudeJsonPath = home ? path.join(home, ".claude.json") : null;
  const payload = {
    argv: process.argv.slice(2),
    home,
    prompt,
    claudeCodeEnv: Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => key.startsWith("CLAUDE_CODE_"))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    managedClaudeJsonExists: Boolean(claudeJsonPath && fs.existsSync(claudeJsonPath)),
    managedClaudeJsonIsSymlink: Boolean(claudeJsonPath && fs.existsSync(claudeJsonPath) && fs.lstatSync(claudeJsonPath).isSymbolicLink()),
    managedClaudeJsonText: claudeJsonPath && fs.existsSync(claudeJsonPath) && fs.lstatSync(claudeJsonPath).isFile()
      ? fs.readFileSync(claudeJsonPath, "utf8")
      : null,
    managedClaudeSkillEntries: skillsHome && fs.existsSync(skillsHome) ? fs.readdirSync(skillsHome).sort() : [],
  };
  fs.mkdirSync(path.dirname(${JSON.stringify(capturePath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload), "utf8");
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-skill-boundary", model: "claude-test" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", session_id: "claude-skill-boundary", message: { content: [{ type: "text", text: "captured" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "claude-skill-boundary", result: "captured", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }) + "\\n");
});
`;
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeLocalRuntimeBoundaryCaptureStub(
  commandPath: string,
  capturePath: string,
  runtime: "gemini" | "cursor" | "opencode" | "pi",
) {
  const skillDirByRuntime = {
    gemini: [".gemini", "skills"],
    cursor: [".cursor", "skills"],
    opencode: [".claude", "skills"],
    pi: [".pi", "agent", "skills"],
  }[runtime];
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

if (${JSON.stringify(runtime)} === "opencode" && process.argv.includes("models")) {
  console.log("opencode/deepseek-v4-flash-free");
  process.exit(0);
}
if (${JSON.stringify(runtime)} === "pi" && process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("deepseek  deepseek-v4-pro");
  process.exit(0);
}

const stdin = fs.readFileSync(0, "utf8");
const home = process.env.HOME || "";
const skillsHome = home ? path.join(home, ...${JSON.stringify(skillDirByRuntime)}) : null;
const payload = {
  runtime: ${JSON.stringify(runtime)},
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  home,
  prompt: stdin,
  skillsHome,
  skillEntries: skillsHome && fs.existsSync(skillsHome) ? fs.readdirSync(skillsHome).sort() : [],
  rudderEnv: Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith("RUDDER_"))
      .sort(([left], [right]) => left.localeCompare(right)),
  ),
  xdgEnv: Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith("XDG_"))
      .sort(([left], [right]) => left.localeCompare(right)),
  ),
};
fs.mkdirSync(path.dirname(${JSON.stringify(capturePath)}), { recursive: true });
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload), "utf8");

if (${JSON.stringify(runtime)} === "gemini") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-e2e", model: "deepseek-v4-pro" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "output_text", text: "captured" }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "gemini-e2e", result: "captured" }));
} else if (${JSON.stringify(runtime)} === "cursor") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-e2e", model: "auto" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "output_text", text: "captured" }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "cursor-e2e", result: "captured" }));
} else if (${JSON.stringify(runtime)} === "opencode") {
  console.log(JSON.stringify({ type: "step_start", sessionID: "opencode-e2e" }));
  console.log(JSON.stringify({ type: "text", part: { type: "text", text: "captured" } }));
  console.log(JSON.stringify({ type: "step_finish", part: { reason: "stop", cost: 0, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } }));
} else {
  console.log(JSON.stringify({ type: "session", version: 3, id: "pi-e2e", timestamp: new Date().toISOString(), cwd: process.cwd() }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "turn_start" }));
  console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "captured" }], usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } }, toolResults: [] }));
}
`;
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function installDesktopShellOpenExternalStub(page: Page) {
  await page.addInitScript(() => {
    const openedTargets: string[] = [];
    Object.defineProperty(window, "__rudderOpenedExternalTargets", {
      configurable: true,
      value: openedTargets,
      writable: false,
    });

    const desktopShell = {
      getBootState: async () => ({}),
      onBootState: () => () => {},
      openPath: async () => {},
      copyText: async () => {},
      setAppearance: async () => {},
      restart: async () => {},
      getAppVersion: async () => "0.0.0-test",
      checkForUpdates: async () => ({
        status: "unavailable",
        currentVersion: "0.0.0-test",
        checkedAt: "1970-01-01T00:00:00.000Z",
      }),
      sendFeedback: async () => {},
      openExternal: async (target: string) => {
        openedTargets.push(target);
      },
      openNotificationSettings: async () => ({ opened: false, platform: "darwin" }),
      setBadgeCount: async () => {},
      showNotification: async () => {},
      pickPath: async () => ({ canceled: true, path: null }),
    };

    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: desktopShell,
    });
  });
}

async function readNamedSkillSwitchOrder(root: Locator, skillNames: string[]) {
  return await root.locator('[role="switch"]').evaluateAll(
    (nodes, names) =>
      nodes
        .map((node) => node.getAttribute("aria-label"))
        .filter((value): value is string => Boolean(value) && names.includes(value)),
    skillNames,
  );
}

test.describe("Organization and agent skills", () => {
  test("shows seeded community presets in the new-agent picker while keeping bundled defaults hidden", async ({ page }) => {
    const organizationName = `Org-New-Agent-Skills-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/new`);
    const newAgentMain = page.locator("#main-content");
    await expect(newAgentMain.getByRole("heading", { name: "New Agent" })).toBeVisible();
    await expect(newAgentMain.getByRole("heading", { name: "Organization skills" })).toBeVisible();
    await expect(newAgentMain.getByText("deep-research").first()).toBeVisible();
    await expect(newAgentMain.getByText("software-product-advisor").first()).toBeVisible();
    await expect(newAgentMain.getByText("para-memory-files")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-create-agent")).toHaveCount(0);

    const customSkillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Alpha Test",
        slug: "alpha-test",
        markdown: "---\nname: alpha-test\ndescription: Alpha test skill.\n---\n\n# Alpha Test\n",
      },
    });
    expect(customSkillRes.ok()).toBe(true);

    await page.reload();
    await expect(newAgentMain.getByRole("heading", { name: "Organization skills" })).toBeVisible();
    await expect(newAgentMain.getByText("alpha-test").first()).toBeVisible();
    await expect(newAgentMain.getByText("deep-research").first()).toBeVisible();
    await expect(newAgentMain.getByText("para-memory-files")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-create-agent")).toHaveCount(0);
  });

  test("seeds bundled and community preset org skills and lets agents enable only selected skills", async ({ page }) => {
    const organizationName = `Org-Skills-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const customSkillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "alpha-test",
        slug: "alpha-test",
        markdown: "---\nname: alpha-test\ndescription: Alpha test skill.\n---\n\n# Alpha Test\n",
      },
    });
    expect(customSkillRes.ok()).toBe(true);

    const skillsRes = await page.request.get(`/api/orgs/${organization.id}/skills`);
    expect(skillsRes.ok()).toBe(true);
    const skills = await skillsRes.json() as Array<{ key: string }>;
    expect(skills.map((skill) => skill.key)).toEqual(expect.arrayContaining([
      "rudder/para-memory-files",
      "rudder/rudder",
      "rudder/rudder-create-agent",
      "rudder/rudder-create-plugin",
      expect.stringMatching(/deep-research$/),
      expect.stringMatching(/skill-creator$/),
      expect.stringMatching(/software-product-advisor$/),
      expect.stringMatching(/alpha-test$/),
    ]));

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/skills`);
    const skillsMain = page.locator("#main-content");
    await expect(skillsMain.getByRole("heading", { name: "Skills" })).toBeVisible();
    await expect(skillsMain.getByText("Bundled, community preset, and imported skills for this organization.")).toBeVisible();
    await expect(skillsMain.getByText("para-memory-files").first()).toBeVisible();
    await expect(skillsMain.getByText("rudder-create-agent").first()).toBeVisible();
    await expect(skillsMain.getByText("deep-research").first()).toBeVisible();
    await expect(skillsMain.getByText("Community preset").first()).toBeVisible();
    await expect(skillsMain.getByText("Bundled by Rudder").first()).toBeVisible();

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByPlaceholder("Search skills")).toBeVisible();
    await expect(agentMain.getByText("Rudder Agent Skills load only when enabled on this page. Adapter, global, project, plugin, slash-command, and host-installed skills are discovery-only until selected.")).toBeVisible();
    await expect(agentMain.getByText("Bundled, community preset, and organization skills are optional selections controlled by this page; workspace-backed skills can be edited from Workspaces.")).toBeVisible();
    await expect(agentMain.getByText("Available in this organization")).toHaveCount(0);
    await expect(agentMain.getByText("Bundled by Rudder").first()).toBeVisible();
    await expect(agentMain.getByText("Community preset").first()).toBeVisible();
    await expect(agentMain.getByText("deep-research").first()).toBeVisible();
    await expect(agentMain.getByText("Alpha test skill.")).toBeVisible();
    await expect(agentMain.getByText("Will be mounted into the ephemeral Claude skill directory on the next run.")).toHaveCount(0);
    await expect(agentMain.getByRole("switch", { name: "para-memory-files" })).toBeEnabled();
    await expect(agentMain.getByRole("switch", { name: "para-memory-files" })).toHaveAttribute("aria-checked", "false");

    const deepResearchToggle = agentMain.getByRole("switch", { name: "deep-research" });
    await expect(deepResearchToggle).toBeVisible();
    await expect(deepResearchToggle).toHaveAttribute("aria-checked", "false");

    const alphaToggle = agentMain.getByRole("switch", { name: "alpha-test" });
    await expect(alphaToggle).toBeVisible();
    await expect(alphaToggle).toHaveAttribute("aria-checked", "false");

    const enableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await alphaToggle.click();
    await expect(alphaToggle).toHaveAttribute("aria-checked", "true");
    await enableSyncResponse;

    await page.reload();
    const reloadedAgentMain = page.locator("#main-content");
    const reloadedAlphaToggle = reloadedAgentMain.getByRole("switch", { name: "alpha-test" });
    await expect(reloadedAlphaToggle).toHaveAttribute("aria-checked", "true");

    const disableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await reloadedAlphaToggle.click();
    await expect(reloadedAlphaToggle).toHaveAttribute("aria-checked", "false");
    await disableSyncResponse;
  });

  test("opens import helper links through the desktop shell bridge", async ({ page }) => {
    await installDesktopShellOpenExternalStub(page);

    const organizationName = `Org-Skills-External-Links-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/skills`);
    const skillsMain = page.locator("#main-content");
    await skillsMain.getByRole("button", { name: "Add skill" }).click();
    const dialog = page.getByRole("dialog", { name: "Add skill" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("link", { name: "Browse skills.sh" }).click();
    await dialog.getByRole("link", { name: "Search GitHub" }).click();

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderOpenedExternalTargets?: string[] }).__rudderOpenedExternalTargets ?? []
    ))).toEqual([
      "https://skills.sh",
      "https://github.com/search?q=SKILL.md&type=code",
    ]);
  });

  test("shows agent skills above organization skills and edits both through Workspaces", async ({ page }) => {
    const organizationName = `Org-Agent-Private-Skills-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Personal Skill Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const customSkillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Alpha Test",
        slug: "alpha-test",
        markdown: "---\nname: alpha-test\ndescription: Alpha test skill.\n---\n\n# Alpha Test\n",
      },
    });
    expect(customSkillRes.ok()).toBe(true);

    const agentWorkspaceRoot = await resolveSingleAgentWorkspaceRoot(organization.id);
    const agentSkillDir = path.join(agentWorkspaceRoot, "skills", "agent-helper");
    await fs.mkdir(agentSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(agentSkillDir, "SKILL.md"),
      "---\nname: agent-helper\ndescription: Private agent helper skill.\n---\n",
      "utf8",
    );

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByText("Agent skills", { exact: true })).toBeVisible();
    await expect(agentMain.getByText("Organization skills", { exact: true })).toBeVisible();
    const agentHeading = agentMain.getByText("Agent skills", { exact: true }).first();
    const orgHeading = agentMain.getByText("Organization skills", { exact: true }).first();
    const agentHeadingBox = await agentHeading.boundingBox();
    const orgHeadingBox = await orgHeading.boundingBox();
    expect(agentHeadingBox?.y ?? 0).toBeLessThan(orgHeadingBox?.y ?? Number.MAX_SAFE_INTEGER);
    await expect(agentMain.getByText("agent-helper")).toBeVisible();
    await expect(agentMain.getByText("Private agent helper skill.")).toBeVisible();
    await expect(agentMain.getByText("Installed, not enabled").first()).toBeVisible();
    await expect(agentMain.getByText("alpha-test").first()).toBeVisible();
    await expect(agentMain.getByText("Alpha test skill.")).toBeVisible();
    const agentHelperToggle = agentMain.getByRole("switch", { name: "agent-helper" });
    await expect(agentHelperToggle).toHaveAttribute("aria-checked", "false");
    const editLinks = agentMain.getByRole("link", { name: "Edit in workspaces" });
    await expect(editLinks).toHaveCount(2);

    const agentEditHref = await editLinks.nth(0).getAttribute("href");
    expect(agentEditHref).toContain(`/${organization.issuePrefix}/workspaces?path=`);
    await page.goto(agentEditHref!);
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/workspaces\\?path=`));
    const workspaceMain = page.locator("#main-content");
    await expect(workspaceMain.getByText("agents/", { exact: false })).toBeVisible();
    const workspaceEditor = workspaceMain.locator("textarea");
    await workspaceEditor.fill(
      "---\nname: agent-helper\ndescription: Rewritten agent helper skill.\n---\n\n# Agent Helper\n\nUpdated in Workspaces.\n",
    );
    const agentSaveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
      && response.ok(),
    );
    await workspaceMain.getByRole("button", { name: "Save" }).click();
    await agentSaveResponse;
    await expect.poll(() => fs.readFile(path.join(agentSkillDir, "SKILL.md"), "utf8")).toContain("Rewritten agent helper skill.");

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    await expect(agentMain.getByText("Rewritten agent helper skill.")).toBeVisible();

    const orgEditLinks = agentMain.getByRole("link", { name: "Edit in workspaces" });
    await expect(orgEditLinks).toHaveCount(2);
    const orgEditHref = await orgEditLinks.nth(1).getAttribute("href");
    expect(orgEditHref).toContain(`/${organization.issuePrefix}/workspaces?path=`);
    await page.goto(orgEditHref!);
    const orgWorkspaceMain = page.locator("#main-content");
    await expect(orgWorkspaceMain.getByText("skills/alpha-test/SKILL.md")).toBeVisible();
    const orgWorkspaceEditor = orgWorkspaceMain.locator("textarea");
    await orgWorkspaceEditor.fill(
      "---\nname: alpha-test\ndescription: Updated organization skill.\n---\n\n# Alpha Test\n\nEdited from Workspaces.\n",
    );
    const orgSaveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
      && response.ok(),
    );
    await orgWorkspaceMain.getByRole("button", { name: "Save" }).click();
    await orgSaveResponse;

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    await expect(agentMain.getByText("Updated organization skill.")).toBeVisible();

    const enableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await agentHelperToggle.click();
    await expect(agentHelperToggle).toHaveAttribute("aria-checked", "true");
    await enableSyncResponse;

    await page.reload();
    const reloadedAgentMain = page.locator("#main-content");
    await expect(reloadedAgentMain.getByText("Agent skills", { exact: true })).toBeVisible();
    await expect(reloadedAgentMain.getByRole("switch", { name: "agent-helper" })).toHaveAttribute("aria-checked", "true");
  });

  test("pins enabled agent skills to the top on the next visit without reordering immediately", async ({ page }) => {
    const organizationName = `Org-Agent-Skill-Sorting-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Pinned Skill Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const agentWorkspaceRoot = await resolveSingleAgentWorkspaceRoot(organization.id);
    const alphaSkillDir = path.join(agentWorkspaceRoot, "skills", "alpha-helper");
    const zetaSkillDir = path.join(agentWorkspaceRoot, "skills", "zeta-helper");
    await fs.mkdir(alphaSkillDir, { recursive: true });
    await fs.mkdir(zetaSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(alphaSkillDir, "SKILL.md"),
      "---\nname: alpha-helper\ndescription: Alpha helper skill.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(zetaSkillDir, "SKILL.md"),
      "---\nname: zeta-helper\ndescription: Zeta helper skill.\n---\n",
      "utf8",
    );

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByText("Agent skills", { exact: true })).toBeVisible();
    await expect(agentMain.getByRole("switch", { name: "alpha-helper" })).toBeVisible();
    await expect(agentMain.getByRole("switch", { name: "zeta-helper" })).toBeVisible();
    expect(await readNamedSkillSwitchOrder(agentMain, [
      "alpha-helper",
      "zeta-helper",
    ])).toEqual([
      "alpha-helper",
      "zeta-helper",
    ]);

    const enableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await agentMain.getByRole("switch", { name: "zeta-helper" }).click();
    await enableSyncResponse;

    await expect(agentMain.getByRole("switch", { name: "zeta-helper" })).toHaveAttribute("aria-checked", "true");
    expect(await readNamedSkillSwitchOrder(agentMain, [
      "alpha-helper",
      "zeta-helper",
    ])).toEqual([
      "alpha-helper",
      "zeta-helper",
    ]);

    await page.reload();
    const reloadedAgentMain = page.locator("#main-content");
    await expect(reloadedAgentMain.getByText("Agent skills", { exact: true })).toBeVisible();
    expect(await readNamedSkillSwitchOrder(reloadedAgentMain, [
      "alpha-helper",
      "zeta-helper",
    ])).toEqual([
      "zeta-helper",
      "alpha-helper",
    ]);
  });

  test("pins enabled organization and external skills to the top on the next visit without reordering immediately", async ({ page }) => {
    const organizationName = `Org-Managed-Skill-Sorting-${Date.now()}`;
    const globalAlphaDir = path.join(E2E_HOME, ".agents", "skills", "alpha-global");
    const globalZetaDir = path.join(E2E_HOME, ".agents", "skills", "zeta-global");
    await fs.mkdir(globalAlphaDir, { recursive: true });
    await fs.mkdir(globalZetaDir, { recursive: true });
    await fs.writeFile(
      path.join(globalAlphaDir, "SKILL.md"),
      "---\nname: alpha-global\ndescription: Alpha global skill.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(globalZetaDir, "SKILL.md"),
      "---\nname: zeta-global\ndescription: Zeta global skill.\n---\n",
      "utf8",
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Section Sorting Tester",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          command: E2E_CLAUDE_STUB,
          env: {
            HOME: E2E_HOME,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const orgAlphaRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "alpha-org",
        slug: "alpha-org",
        markdown: "---\nname: alpha-org\ndescription: Alpha organization skill.\n---\n",
      },
    });
    expect(orgAlphaRes.ok()).toBe(true);
    const orgZetaRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "zeta-org",
        slug: "zeta-org",
        markdown: "---\nname: zeta-org\ndescription: Zeta organization skill.\n---\n",
      },
    });
    expect(orgZetaRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByText("Organization skills", { exact: true })).toBeVisible();
    expect(await readNamedSkillSwitchOrder(agentMain, [
      "alpha-org",
      "zeta-org",
    ])).toEqual([
      "alpha-org",
      "zeta-org",
    ]);

    const enableOrgSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await agentMain.getByRole("switch", { name: "zeta-org" }).click();
    await enableOrgSyncResponse;
    await expect(agentMain.getByRole("switch", { name: "zeta-org" })).toHaveAttribute("aria-checked", "true");
    expect(await readNamedSkillSwitchOrder(agentMain, [
      "alpha-org",
      "zeta-org",
    ])).toEqual([
      "alpha-org",
      "zeta-org",
    ]);

    await expect(agentMain.getByRole("button", { name: /External skills/ })).toBeVisible();
    await agentMain.getByRole("button", { name: /External skills/ }).click();
    await expect(agentMain.getByText("Global skills", { exact: true })).toBeVisible();
    expect(await readNamedSkillSwitchOrder(agentMain, [
      "alpha-global",
      "zeta-global",
    ])).toEqual([
      "alpha-global",
      "zeta-global",
    ]);

    const enableExternalSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await agentMain.getByRole("switch", { name: "zeta-global" }).click();
    await enableExternalSyncResponse;
    await expect(agentMain.getByRole("switch", { name: "zeta-global" })).toHaveAttribute("aria-checked", "true");
    expect(await readNamedSkillSwitchOrder(agentMain, [
      "alpha-global",
      "zeta-global",
    ])).toEqual([
      "alpha-global",
      "zeta-global",
    ]);

    await page.reload();
    const reloadedAgentMain = page.locator("#main-content");
    await expect(reloadedAgentMain.getByText("Organization skills", { exact: true })).toBeVisible();
    expect(await readNamedSkillSwitchOrder(reloadedAgentMain, [
      "alpha-org",
      "zeta-org",
    ])).toEqual([
      "zeta-org",
      "alpha-org",
    ]);

    await expect(reloadedAgentMain.getByText("Global skills", { exact: true })).toBeVisible();
    expect(await readNamedSkillSwitchOrder(reloadedAgentMain, [
      "alpha-global",
      "zeta-global",
    ])).toEqual([
      "zeta-global",
      "alpha-global",
    ]);
  });

  test("lets users explicitly enable a discovered Claude user-installed skill", async ({ page }) => {
    const organizationName = `Org-External-Skills-${Date.now()}`;
    const globalSkillDir = path.join(E2E_HOME, ".agents", "skills", "global-helper");
    const externalSkillDir = path.join(E2E_HOME, ".claude", "skills", "build-advisor");
    await fs.mkdir(globalSkillDir, { recursive: true });
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(globalSkillDir, "SKILL.md"),
      "---\nname: global-helper\ndescription: Global helper skill.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: build-advisor\ndescription: External build advisor skill.\n---\n",
      "utf8",
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Claude Builder",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          command: E2E_CLAUDE_STUB,
          env: {
            HOME: E2E_HOME,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByRole("switch", { name: "rudder", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(agentMain.getByRole("button", { name: /External skills/ })).toBeVisible();
    await agentMain.getByRole("button", { name: /External skills/ }).click();
    await expect(agentMain.getByText("Global and adapter skills are discovered from ~/.agents/skills and the current runtime adapter home. Discovery does not enable them; only the selections on this page determine runtime loading.")).toBeVisible();
    await expect(agentMain.getByText("Global skills")).toBeVisible();
    await expect(agentMain.getByText("Adapter skills", { exact: true })).toBeVisible();
    await expect(agentMain.getByText("global-helper")).toBeVisible();
    await expect(agentMain.getByText("build-advisor")).toBeVisible();
    const buildAdvisorToggle = agentMain.getByRole("switch", { name: "build-advisor" });
    await expect(buildAdvisorToggle).toHaveAttribute("aria-checked", "false");
    await expect(agentMain.getByText("External build advisor skill.")).toBeVisible();
    await expect(agentMain.getByText("Enabled for this agent. Rudder will mount this user-installed Claude skill on the next run.")).toHaveCount(0);

    const enableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await buildAdvisorToggle.click();
    await expect(buildAdvisorToggle).toHaveAttribute("aria-checked", "true");
    await enableSyncResponse;

    await page.reload();
    const reloadedAgentMain = page.locator("#main-content");
    await expect(reloadedAgentMain.getByText("build-advisor")).toBeVisible();
    await expect(reloadedAgentMain.getByRole("switch", { name: "build-advisor" })).toHaveAttribute("aria-checked", "true");
  });

  test("lets users explicitly enable a discovered Codex user-installed skill", async ({ page }) => {
    const organizationName = `Org-Codex-External-Skills-${Date.now()}`;
    const codexHome = path.join(E2E_HOME, ".codex");
    const externalSkillDir = path.join(codexHome, "skills", "build-advisor");
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: build-advisor\ndescription: External build advisor skill.\n---\n",
      "utf8",
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Codex Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: E2E_CODEX_STUB,
          model: "gpt-5.4",
          env: {
            CODEX_HOME: codexHome,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByRole("switch", { name: "rudder", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(agentMain.getByRole("button", { name: /External skills/ })).toBeVisible();
    await agentMain.getByRole("button", { name: /External skills/ }).click();
    await expect(agentMain.getByText("Adapter skills", { exact: true })).toBeVisible();
    await expect(agentMain.getByText("build-advisor")).toBeVisible();
    const buildAdvisorToggle = agentMain.getByRole("switch", { name: "build-advisor" });
    await expect(buildAdvisorToggle).toHaveAttribute("aria-checked", "false");
    await expect(agentMain.getByText("External build advisor skill.")).toBeVisible();

    const enableSyncResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/agents/${agent.id}/skills/sync`)
      && response.ok(),
    );
    await buildAdvisorToggle.click();
    await expect(buildAdvisorToggle).toHaveAttribute("aria-checked", "true");
    await enableSyncResponse;

    await page.reload();
    const reloadedAgentMain = page.locator("#main-content");
    await expect(reloadedAgentMain.getByText("build-advisor")).toBeVisible();
    await expect(reloadedAgentMain.getByRole("switch", { name: "build-advisor" })).toHaveAttribute("aria-checked", "true");
  });

  test("prunes stale managed Codex .system skills before runtime invocation", async ({ page }) => {
    const organizationName = `Org-Codex-System-Skill-Prune-${Date.now()}`;
    const capturePath = path.join(E2E_HOME, "captures", `codex-skill-surface-${Date.now()}.json`);
    const captureCommandPath = path.join(E2E_HOME, "bin", `codex-skill-surface-${Date.now()}`);
    await writeCodexSkillCaptureStub(captureCommandPath, capturePath);

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Codex Skill Surface Tester",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: captureCommandPath,
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const skillSyncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${organization.id}`, {
      data: {
        desiredSkills: ["rudder/rudder"],
      },
    });
    expect(skillSyncRes.ok()).toBe(true);

    const managedCodexHome = path.join(
      E2E_HOME,
      "instances",
      E2E_INSTANCE_ID,
      "organizations",
      organization.id,
      "codex-home",
      "agents",
      agent.id,
    );
    const staleSystemSkill = path.join(managedCodexHome, "skills", ".system", "imagegen", "SKILL.md");
    await fs.mkdir(path.dirname(staleSystemSkill), { recursive: true });
    await fs.writeFile(staleSystemSkill, "---\nname: imagegen\ndescription: stale system skill\n---\n", "utf8");

    const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(runRes.ok()).toBe(true);

    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(capturePath, "utf8")) as {
            codexHome: string | null;
            rootEntries: string[];
            systemEntries: string[];
          };
        } catch {
          return null;
        }
      }, { timeout: 30_000 })
      .toEqual({
        codexHome: managedCodexHome,
        rootEntries: ["rudder"],
        systemEntries: [],
      });
    await expect(fs.access(path.join(managedCodexHome, "skills", ".system"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("invokes non-Codex local runtimes with the Rudder skill boundary and selected org skills", async ({ page }) => {
    const organizationName = `Org-Local-Runtime-Boundary-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
    };

    const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "runtime-selected",
        slug: "runtime-selected",
        markdown: "---\nname: runtime-selected\ndescription: Runtime selected skill.\n---\n\n# Runtime Selected\n",
      },
    });
    expect(skillRes.ok()).toBe(true);
    const skill = await skillRes.json() as { key: string };

    const hostSkillDirByRuntime = {
      gemini: [".gemini", "skills"],
      cursor: [".cursor", "skills"],
      opencode: [".claude", "skills"],
      pi: [".pi", "agent", "skills"],
    } as const;
    for (const segments of Object.values(hostSkillDirByRuntime)) {
      await writeHostSkill(E2E_HOME, [...segments], "build-advisor");
      await writeHostSkill(E2E_HOME, [...segments], "code-review");
    }
    const hostOpenCodeDb = path.join(E2E_HOME, ".local", "share", "opencode", "opencode.db");
    await fs.mkdir(path.dirname(hostOpenCodeDb), { recursive: true });
    await fs.writeFile(hostOpenCodeDb, "host-db-must-not-be-shared", "utf8");

    const cases = [
      { runtime: "gemini" as const, agentRuntimeType: "gemini_local", model: "deepseek-v4-pro" },
      { runtime: "cursor" as const, agentRuntimeType: "cursor", model: "auto" },
      { runtime: "opencode" as const, agentRuntimeType: "opencode_local", model: "opencode/deepseek-v4-flash-free" },
      { runtime: "pi" as const, agentRuntimeType: "pi_local", model: "deepseek/deepseek-v4-pro" },
    ];

    for (const item of cases) {
      const capturePath = path.join(E2E_HOME, "captures", `${item.runtime}-runtime-boundary-${Date.now()}.json`);
      const commandPath = path.join(E2E_HOME, "bin", `${item.runtime}-runtime-boundary-${Date.now()}`);
      await writeLocalRuntimeBoundaryCaptureStub(commandPath, capturePath, item.runtime);

      const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
        data: {
          name: `${item.runtime} Boundary Tester`,
          role: "engineer",
          agentRuntimeType: item.agentRuntimeType,
          agentRuntimeConfig: {
            command: commandPath,
            model: item.model,
            env: {
              HOME: E2E_HOME,
            },
          },
        },
      });
      expect(agentRes.ok()).toBe(true);
      const agent = await agentRes.json() as { id: string };

      const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync`, {
        data: {
          desiredSkills: [skill.key],
        },
      });
      expect(syncRes.ok()).toBe(true);

      const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
      expect(runRes.ok()).toBe(true);

      await expect
        .poll(async () => {
          try {
            return JSON.parse(await fs.readFile(capturePath, "utf8"));
          } catch {
            return null;
          }
        }, { timeout: 30_000 })
        .not.toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        runtime: string;
        argv: string[];
        prompt: string;
        home: string;
        skillsHome: string;
        skillEntries: string[];
        rudderEnv: Record<string, string>;
        xdgEnv: Record<string, string>;
      };

      const promptArgIndex = capture.argv.indexOf("--prompt");
      const runtimePrompt = promptArgIndex >= 0 ? capture.argv[promptArgIndex + 1] : capture.prompt || capture.argv[1] || "";
      expect(runtimePrompt).toContain("# Rudder Runtime Skill Boundary");
      expect(runtimePrompt).toContain("Enabled Rudder Agent Skills:");
      expect(runtimePrompt).toContain("runtime-selected");
      expect(runtimePrompt).toContain("${RUDDER_CLI:-rudder}");
      expect(runtimePrompt).toContain("--body-file -");
      expect(runtimePrompt).toContain("--comment-file -");
      expect(runtimePrompt).toContain("<requested runtime type>");
      expect(runtimePrompt).not.toContain('"agentRuntimeType":"codex_local"');
      expect(runtimePrompt).not.toContain('"desiredSkills":["rudder/rudder"]');
      expect(capture.home).not.toBe(E2E_HOME);
      expect(capture.skillsHome).not.toBe(path.join(E2E_HOME, ...hostSkillDirByRuntime[item.runtime]));
      expect(capture.rudderEnv.RUDDER_CLI).toBeTruthy();
      expect(capture.skillEntries).toContain("runtime-selected");
      expect(capture.skillEntries).not.toContain("build-advisor");
      expect(capture.skillEntries).not.toContain("code-review");
      if (item.runtime === "opencode") {
        expect(capture.argv).toContain("--pure");
        expect(capture.xdgEnv.XDG_CONFIG_HOME).toBe(path.join(capture.home, ".config"));
        expect(capture.xdgEnv.XDG_DATA_HOME).toBe(path.join(capture.home, ".local", "share"));
        expect(capture.xdgEnv.XDG_CACHE_HOME).toBe(path.join(capture.home, ".cache"));
        await expect(fs.access(path.join(capture.home, ".local", "share", "opencode", "opencode.db"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  });

  test("invokes Claude with the Rudder skill boundary and isolated managed home", async ({ page }) => {
    const organizationName = `Org-Claude-Skill-Boundary-${Date.now()}`;
    const capturePath = path.join(E2E_HOME, "captures", `claude-skill-boundary-${Date.now()}.json`);
    const captureCommandPath = path.join(E2E_HOME, "bin", `claude-skill-boundary-${Date.now()}`);
    await writeClaudeSkillBoundaryCaptureStub(captureCommandPath, capturePath);
    await writeHostSkill(E2E_HOME, [".claude", "skills"], "code-review");
    await fs.writeFile(
      path.join(E2E_HOME, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rogue: { command: "rogue" },
        },
        skillUsage: {
          "code-review": { usageCount: 99 },
        },
      }),
      "utf8",
    );

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Claude Skill Boundary Tester",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          command: captureCommandPath,
          env: {
            HOME: E2E_HOME,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const skillSyncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${organization.id}`, {
      data: {
        desiredSkills: ["rudder/rudder"],
      },
    });
    expect(skillSyncRes.ok()).toBe(true);

    const managedClaudeHome = path.join(
      E2E_HOME,
      "instances",
      E2E_INSTANCE_ID,
      "organizations",
      organization.id,
      "claude-home",
      "agents",
      agent.id,
    );

    const runRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`);
    expect(runRes.ok()).toBe(true);

    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(capturePath, "utf8")) as {
            argv: string[];
            home: string | null;
            prompt: string;
            claudeCodeEnv: Record<string, string>;
            managedClaudeJsonExists: boolean;
            managedClaudeJsonIsSymlink: boolean;
            managedClaudeJsonText: string | null;
            managedClaudeSkillEntries: string[];
          };
        } catch {
          return null;
        }
      }, { timeout: 30_000 })
      .toEqual(expect.objectContaining({
        argv: expect.arrayContaining(["--disable-slash-commands", "--strict-mcp-config"]),
        home: managedClaudeHome,
        claudeCodeEnv: expect.objectContaining({
          CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
          CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: "1",
        }),
        managedClaudeJsonExists: true,
        managedClaudeJsonIsSymlink: false,
        managedClaudeJsonText: "{}\n",
        managedClaudeSkillEntries: ["rudder"],
        prompt: expect.stringContaining("# Rudder Runtime Skill Boundary"),
      }));

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
      prompt: string;
      managedClaudeSkillEntries: string[];
    };
    expect(capture.prompt).toContain("Enabled Rudder Agent Skills:");
    expect(capture.prompt).toContain("rudder");
    expect(capture.prompt).not.toContain("code-review");
    expect(capture.managedClaudeSkillEntries).toContain("rudder");
    expect(capture.managedClaudeSkillEntries).not.toContain("code-review");
    expect(capture.managedClaudeSkillEntries).not.toContain("rudder-create-agent");
    expect(capture.managedClaudeSkillEntries).not.toContain("skill-creator");
  });
});
