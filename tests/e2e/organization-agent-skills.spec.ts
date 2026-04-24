import { expect, test, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");
const E2E_CLAUDE_STUB = path.join(E2E_HOME, "bin", "claude");
const E2E_INSTANCE_ID = "playwright";

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

async function writeCodexSkillCaptureStub(commandPath: string, capturePath: string) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
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
    await expect(newAgentMain.getByText("skill-creator").first()).toBeVisible();
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

  test("seeds bundled and community preset org skills and keeps bundled Rudder skills always enabled", async ({ page }) => {
    const organizationName = `Org-Skills-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
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
    await expect(skillsMain.getByText("para-memory-files")).toBeVisible();
    await expect(skillsMain.getByText("rudder-create-agent")).toBeVisible();
    await expect(skillsMain.getByText("deep-research").first()).toBeVisible();
    await expect(skillsMain.getByText("Community preset").first()).toBeVisible();
    await expect(skillsMain.getByText("Bundled by Rudder").first()).toBeVisible();

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByPlaceholder("Search skills")).toBeVisible();
    await expect(agentMain.getByText("Rudder always loads the bundled Rudder skills. Agent, organization, global, and adapter skills load only when enabled on this page.")).toBeVisible();
    await expect(agentMain.getByText("Bundled Rudder skills are locked on. Community presets and other organization skills stay optional; workspace-backed skills can be edited from Workspaces.")).toBeVisible();
    await expect(agentMain.getByText("Available in this organization")).toHaveCount(0);
    await expect(agentMain.getByText("Bundled by Rudder").first()).toBeVisible();
    await expect(agentMain.getByText("Community preset").first()).toBeVisible();
    await expect(agentMain.getByText("deep-research").first()).toBeVisible();
    await expect(agentMain.getByText("Alpha test skill.")).toBeVisible();
    await expect(agentMain.getByText("Will be mounted into the ephemeral Claude skill directory on the next run.")).toHaveCount(0);
    await expect(agentMain.getByRole("switch", { name: "para-memory-files" })).toBeDisabled();
    await expect(agentMain.getByRole("switch", { name: "para-memory-files" })).toHaveAttribute("aria-checked", "true");

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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
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
        defaultChatAgentRuntimeType: "claude_local",
        defaultChatAgentRuntimeConfig: {
          command: E2E_CLAUDE_STUB,
          env: {
            HOME: E2E_HOME,
          },
        },
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
    await expect(agentMain.getByRole("switch", { name: "rudder", exact: true })).toHaveAttribute("aria-checked", "true");
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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          command: E2E_CODEX_STUB,
          model: "gpt-5.4",
          env: {
            CODEX_HOME: codexHome,
          },
        },
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
    await expect(agentMain.getByRole("switch", { name: "rudder", exact: true })).toHaveAttribute("aria-checked", "true");
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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          command: captureCommandPath,
          model: "gpt-5.4",
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
        },
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
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

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
      })
      .toEqual({
        codexHome: managedCodexHome,
        rootEntries: ["rudder"],
        systemEntries: [],
      });
    await expect(fs.access(path.join(managedCodexHome, "skills", ".system"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
