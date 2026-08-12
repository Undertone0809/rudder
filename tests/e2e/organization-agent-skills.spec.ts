import { expect, test, type Locator } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOrganizationStorageKey } from "../../packages/agent-runtime-utils/src/organization-storage.ts";
import { E2E_CLAUDE_STUB, E2E_CODEX_STUB, E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

async function resolveSingleAgentWorkspaceRoot(orgId: string) {
  const agentsRoot = path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    resolveOrganizationStorageKey(orgId),
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

async function writeCodexInstalledSkillContentCaptureStub(
  commandPath: string,
  capturePath: string,
  skillSlug: string,
) {
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

process.stdin.resume();
process.stdin.on("end", () => {
  const skillRoot = path.join(process.env.CODEX_HOME || "", "skills", ${JSON.stringify(skillSlug)});
  const read = (relativePath) => fs.readFileSync(path.join(skillRoot, relativePath), "utf8");
  const payload = {
    skill: read("SKILL.md"),
    reference: read("references/guide.md"),
    script: read("scripts/check.mjs"),
    asset: read("assets/template.txt"),
  };
  fs.mkdirSync(path.dirname(${JSON.stringify(capturePath)}), { recursive: true });
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload) + "\\n", "utf8");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-editable-skill", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "captured editable skill" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
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
  test("shows the Agent Skills introduction once and remembers dismissal", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Org-Skills-Onboarding-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Skills Explorer",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: E2E_CODEX_STUB,
          model: "gpt-5.4",
          env: {
            CODEX_HOME: path.join(E2E_HOME, ".codex"),
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.removeItem("rudder:agent-skills:onboarding:v1");
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    const onboardingCallout = agentMain.getByTestId("agent-skills-onboarding");
    await expect(onboardingCallout).toBeVisible();
    await expect(
      onboardingCallout.getByRole("heading", { name: "Build your agent's skill set" }),
    ).toBeVisible();
    await expect(
      onboardingCallout.getByText(/local runtimes such as Codex and Claude Code/),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(agentMain.getByPlaceholder("Search skills")).toBeEnabled();

    await page.setViewportSize({ width: 420, height: 800 });
    const onboardingCalloutBox = await onboardingCallout.boundingBox();
    expect(onboardingCalloutBox).not.toBeNull();
    expect(onboardingCalloutBox!.x).toBeGreaterThanOrEqual(0);
    expect(onboardingCalloutBox!.x + onboardingCalloutBox!.width).toBeLessThanOrEqual(420);
    await expect(onboardingCallout.getByRole("button", { name: "Got it" })).toBeVisible();

    await onboardingCallout.getByRole("button", { name: "Got it" }).click();
    await expect(onboardingCallout).toHaveCount(0);
    await expect.poll(
      () => page.evaluate(() => window.localStorage.getItem("rudder:agent-skills:onboarding:v1")),
    ).toBe("dismissed");

    await page.reload();
    await expect(agentMain.getByTestId("agent-skills-onboarding")).toHaveCount(0);
  });

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
    await expect(newAgentMain.getByText("skill-creator")).toHaveCount(0);
    await expect(newAgentMain.getByText("software-product-advisor").first()).toBeVisible();
    await expect(newAgentMain.getByText("para-memory-files")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-docs")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-create-agent")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-create-plugin")).toHaveCount(0);

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
    await expect(newAgentMain.getByText("skill-creator")).toHaveCount(0);
    await expect(newAgentMain.getByText("para-memory-files")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-docs")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-create-agent")).toHaveCount(0);
    await expect(newAgentMain.getByText("rudder-create-plugin")).toHaveCount(0);
  });

  test("persists selected new-agent skills by canonical public reference", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Org-New-Agent-Skill-Selection-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
      urlKey: string;
    };

    const customSkillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Alpha Test",
        slug: "alpha-test",
        markdown: "---\nname: alpha-test\ndescription: Alpha test skill.\n---\n\n# Alpha Test\n",
      },
    });
    expect(customSkillRes.ok()).toBe(true);
    const customSkill = await customSkillRes.json() as { key: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/new`);

    const newAgentMain = page.locator("#main-content");
    await expect(newAgentMain.getByRole("heading", { name: "Organization skills" })).toBeVisible();

    const deepResearchToggle = newAgentMain.getByRole("switch", { name: /\/deep-research$/ });
    await expect(deepResearchToggle).toHaveAttribute("aria-checked", "false");
    await expect(deepResearchToggle.locator("..")).toContainText("Community preset");
    await deepResearchToggle.click();
    await expect(deepResearchToggle).toHaveAttribute("aria-checked", "true");
    await deepResearchToggle.click();
    await expect(deepResearchToggle).toHaveAttribute("aria-checked", "false");

    const alphaToggle = newAgentMain.getByRole("switch", { name: /\/alpha-test$/ });
    await expect(alphaToggle).toHaveAttribute("aria-checked", "false");
    await expect(alphaToggle.locator("..")).toContainText("Alpha test skill.");
    await expect(alphaToggle.locator("..")).toContainText("/alpha-test");
    await alphaToggle.click();
    await expect(alphaToggle).toHaveAttribute("aria-checked", "true");

    await newAgentMain.getByPlaceholder("Agent name").fill("Skill Selection Agent");
    const hireResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/agent-hires`)
    ));
    await newAgentMain.getByRole("button", { name: "Create agent" }).click();
    const hireResponse = await hireResponsePromise;
    expect(hireResponse.ok()).toBe(true);
    const hireRequest = hireResponse.request().postDataJSON() as { desiredSkills?: string[] };
    expect(hireRequest.desiredSkills).toContain(`org/${organization.urlKey}/alpha-test`);
    const hireResult = await hireResponse.json() as { agent: { id: string } };

    const skillSnapshotRes = await page.request.get(
      `/api/agents/${hireResult.agent.id}/skills?orgId=${encodeURIComponent(organization.id)}`,
    );
    expect(skillSnapshotRes.ok()).toBe(true);
    const skillSnapshot = await skillSnapshotRes.json() as { desiredSkills: string[] };
    expect(skillSnapshot.desiredSkills).toContain(`org:${customSkill.key}`);
  });

  test("seeds bundled and community preset org skills and keeps bundled Rudder skills always enabled", async ({ page }) => {
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
      urlKey: string;
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
    const skills = await skillsRes.json() as Array<{
      id: string;
      key: string;
      slug: string;
      trustLevel: string;
      fileInventory: Array<{ path: string; kind: string }>;
    }>;
    expect(skills.map((skill) => skill.key)).toEqual(expect.arrayContaining([
      "rudder/para-memory-files",
      "rudder/rudder-docs",
      "rudder/visualize",
      expect.stringMatching(/deep-research$/),
      expect.stringMatching(/skill-creator$/),
      expect.stringMatching(/software-product-advisor$/),
      expect.stringMatching(/alpha-test$/),
    ]));
    expect(skills.map((skill) => skill.key)).not.toEqual(expect.arrayContaining([
      "rudder/rudder-create-agent",
      "rudder/rudder-create-plugin",
      "rudder/conversation-to-skill",
      "rudder/skill-optimizer",
    ]));
    const skillCreator = skills.find((skill) => skill.key === "rudder/skill-creator");
    expect(skillCreator).toMatchObject({
      slug: "skill-creator",
      trustLevel: "scripts_executables",
    });
    expect(skillCreator?.fileInventory).toEqual(expect.arrayContaining([
      { path: "references/rudder.md", kind: "reference" },
      { path: "scripts/package_skill.py", kind: "script" },
    ]));

    const rudderReferenceRes = await page.request.get(
      `/api/orgs/${organization.id}/skills/${skillCreator!.id}/files?path=references%2Frudder.md`,
    );
    expect(rudderReferenceRes.ok()).toBe(true);
    const rudderReference = await rudderReferenceRes.json();
    expect(rudderReference).toMatchObject({
      path: "references/rudder.md",
      kind: "reference",
      content: expect.stringContaining("# Rudder Compatibility"),
    });

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

    await page.goto(`/${organization.urlKey}/skills`);
    const skillsMain = page.locator("#main-content");
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/library\\?directory=skills$`));
    const libraryFiles = page.getByTestId("org-workspaces-files-scroll");
    await expect(libraryFiles).toContainText("para-memory-files");
    await expect(libraryFiles).toContainText("rudder-docs");
    await expect(libraryFiles).toContainText("skill-creator");
    await expect(libraryFiles).not.toContainText("rudder-create-agent");
    await expect(libraryFiles).not.toContainText("rudder-create-plugin");
    await expect(libraryFiles).toContainText("visualize");
    await expect(skillsMain.getByText("conversation-to-skill")).toHaveCount(0);
    await expect(skillsMain.getByText("skill-optimizer")).toHaveCount(0);
    await expect(libraryFiles).toContainText("deep-research");

    await page.goto(
      `/${organization.urlKey}/library?skill=${skillCreator!.id}&skillFile=references%2Frudder.md`,
    );
    await expect(page.getByTestId("org-workspaces-virtual-skill-readonly")).toContainText(
      "Rudder Compatibility",
    );

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await expect(agentMain.getByPlaceholder("Search skills")).toBeVisible();
    await expect(agentMain.getByText("Rudder always loads the bundled Rudder skills. Agent, organization, global, and adapter skills load only when enabled on this page.")).toBeVisible();
    await expect(agentMain.getByText(/Bundled Rudder skills are locked on/)).toBeVisible();
    await expect(agentMain.getByText("Available in this organization")).toHaveCount(0);
    await expect(agentMain.getByText("Bundled by Rudder").first()).toBeVisible();
    await expect(agentMain.getByText("Community preset").first()).toBeVisible();
    await expect(agentMain.getByText("deep-research").first()).toBeVisible();
    await expect(agentMain.getByText("Alpha test skill.")).toBeVisible();
    await expect(agentMain.getByRole("switch", { name: "conversation-to-skill" })).toHaveCount(0);
    await expect(agentMain.getByRole("switch", { name: "skill-optimizer" })).toHaveCount(0);
    await expect(agentMain.getByText("Will be mounted into the ephemeral Claude skill directory on the next run.")).toHaveCount(0);
    await expect(agentMain.getByRole("switch", { name: "para-memory-files" })).toBeDisabled();
    await expect(agentMain.getByRole("switch", { name: "para-memory-files" })).toHaveAttribute("aria-checked", "true");
    await expect(agentMain.getByRole("switch", { name: "rudder-docs" })).toBeDisabled();
    await expect(agentMain.getByRole("switch", { name: "rudder-docs" })).toHaveAttribute("aria-checked", "true");
    await expect(agentMain.getByRole("switch", { name: "visualize" })).toBeDisabled();
    await expect(agentMain.getByRole("switch", { name: "visualize" })).toHaveAttribute("aria-checked", "true");

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

  test("routes Library skill creation through Hub Chat or upload", async ({ page }) => {
    const organizationName = `Org-Skills-External-Links-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      urlKey: string;
    };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.urlKey}/library?directory=skills`);
    await page.getByTestId("org-workspaces-skills-add-button").click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/hub\\?tab=skills$`));
    await expect(page.getByRole("heading", { name: "Hub" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Skill" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add skill to Library" })).toHaveCount(0);

    await page.getByRole("button", { name: "Create Skill" }).click();
    await expect(page.getByRole("menuitem", { name: "Create via Chat" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Upload Skill" })).toBeVisible();
  });

  test("shows agent skills above organization skills and edits both through Library", async ({ page }) => {
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
    const editLinks = agentMain.getByRole("link", { name: "Edit in Library" });
    await expect(editLinks).toHaveCount(2);

    const agentEditHref = await editLinks.nth(0).getAttribute("href");
    expect(agentEditHref).toContain(`/${organization.issuePrefix}/library?path=`);
    await page.goto(agentEditHref!);
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?path=`));
    const workspaceMain = page.locator("#main-content");
    await expect(workspaceMain.getByText("agents/", { exact: false })).toBeVisible();
    const workspaceEditor = workspaceMain.locator("textarea");
    const agentSaveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
      && response.ok(),
    );
    await workspaceEditor.fill(
      "---\nname: agent-helper\ndescription: Rewritten agent helper skill.\n---\n\n# Agent Helper\n\nUpdated in Library.\n",
    );
    await agentSaveResponse;
    await expect.poll(() => fs.readFile(path.join(agentSkillDir, "SKILL.md"), "utf8")).toContain("Rewritten agent helper skill.");

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`);
    await expect(agentMain.getByText("Rewritten agent helper skill.")).toBeVisible();

    const orgEditLinks = agentMain.getByRole("link", { name: "Edit in Library" });
    await expect(orgEditLinks).toHaveCount(2);
    const orgEditHref = await orgEditLinks.nth(1).getAttribute("href");
    expect(orgEditHref).toContain(`/${organization.issuePrefix}/library?path=`);
    await page.goto(orgEditHref!);
    const orgWorkspaceMain = page.locator("#main-content");
    await expect(orgWorkspaceMain.getByText("skills/alpha-test/SKILL.md")).toBeVisible();
    const orgWorkspaceEditor = orgWorkspaceMain.locator("textarea");
    const orgSaveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
      && response.ok(),
    );
    await orgWorkspaceEditor.fill(
      "---\nname: alpha-test\ndescription: Updated organization skill.\n---\n\n# Alpha Test\n\nEdited from Library.\n",
    );
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
    const externalSkillsScroll = agentMain.getByTestId("agent-external-skills-scroll");
    await expect(externalSkillsScroll).toBeVisible();
    await expect(externalSkillsScroll.locator('[role="switch"]')).toHaveCount(2);
    await expect(externalSkillsScroll).toHaveClass(/overflow-y-auto/);
    await expect(externalSkillsScroll).toHaveClass(/scrollbar-auto-hide/);
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
    await expect(agentMain.getByRole("switch", { name: "rudder-docs", exact: true })).toHaveAttribute("aria-checked", "true");
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
    await expect(agentMain.getByRole("switch", { name: "rudder-docs", exact: true })).toHaveAttribute("aria-checked", "true");
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
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder-docs"],
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
      resolveOrganizationStorageKey(organization.id),
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
        rootEntries: [
          "browser",
          "para-memory-files",
          "rudder-docs",
          "skill-creator",
          "visualize",
        ],
        systemEntries: [],
      });
    await expect(fs.access(path.join(managedCodexHome, "skills", ".system"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const materializedSkillCreator = path.join(managedCodexHome, "skills", "skill-creator");
    await expect(
      fs.readFile(path.join(materializedSkillCreator, "references", "rudder.md"), "utf8"),
    ).resolves.toContain("# Rudder Compatibility");
    await expect(
      fs.readFile(path.join(materializedSkillCreator, "scripts", "package_skill.py"), "utf8"),
    ).resolves.toContain("def main");
    await expect(
      fs.readFile(path.join(materializedSkillCreator, "eval-viewer", "generate_review.py"), "utf8"),
    ).resolves.toContain("def main");
  });

  test("reuses a complete editable organization skill and loads local edits on the next run", async ({ page }) => {
    const suffix = Date.now();
    const skillSlug = `editable-runtime-${suffix}`;
    const sourceRoot = path.join(E2E_HOME, "skill-imports", skillSlug);
    const capturePath = path.join(E2E_HOME, "captures", `${skillSlug}.jsonl`);
    const captureCommandPath = path.join(E2E_HOME, "bin", `${skillSlug}-capture`);
    await Promise.all([
      fs.mkdir(path.join(sourceRoot, "references"), { recursive: true }),
      fs.mkdir(path.join(sourceRoot, "scripts"), { recursive: true }),
      fs.mkdir(path.join(sourceRoot, "assets"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(sourceRoot, "SKILL.md"),
        `---\nname: ${skillSlug}\ndescription: Editable runtime skill.\n---\n\n# Version one\n`,
        "utf8",
      ),
      fs.writeFile(path.join(sourceRoot, "references", "guide.md"), "# Guide one\n", "utf8"),
      fs.writeFile(path.join(sourceRoot, "scripts", "check.mjs"), "export const version = 1;\n", "utf8"),
      fs.writeFile(path.join(sourceRoot, "assets", "template.txt"), "template-one\n", "utf8"),
    ]);
    await writeCodexInstalledSkillContentCaptureStub(captureCommandPath, capturePath, skillSlug);

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Org-Editable-Runtime-Skill-${suffix}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const importRes = await page.request.post(`/api/orgs/${organization.id}/skills/import`, {
      data: { source: sourceRoot },
    });
    expect(importRes.ok()).toBe(true);
    const imported = await importRes.json() as {
      imported: Array<{
        id: string;
        key: string;
        fileInventory: Array<{ path: string }>;
      }>;
    };
    expect(imported.imported).toHaveLength(1);
    const [skill] = imported.imported;
    expect(skill!.fileInventory.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "SKILL.md",
      "references/guide.md",
      "scripts/check.mjs",
      "assets/template.txt",
    ]));
    const detailRes = await page.request.get(
      `/api/orgs/${organization.id}/skills/${skill!.id}`,
    );
    expect(detailRes.ok()).toBe(true);
    await expect(detailRes.json()).resolves.toMatchObject({ editable: true });

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Editable Skill Runner",
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

    const syncRes = await page.request.post(
      `/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`,
      { data: { desiredSkills: [skill!.key] } },
    );
    expect(syncRes.ok()).toBe(true);

    const firstRunRes = await page.request.post(
      `/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`,
    );
    expect(firstRunRes.ok()).toBe(true);
    await expect.poll(async () => (await readJsonLines(capturePath)).length).toBe(1);
    await expect.poll(async () => (await readJsonLines<{
      skill: string;
      reference: string;
      script: string;
      asset: string;
    }>(capturePath))[0]).toMatchObject({
      skill: expect.stringContaining("# Version one"),
      reference: "# Guide one\n",
      script: "export const version = 1;\n",
      asset: "template-one\n",
    });

    const editRes = await page.request.patch(
      `/api/orgs/${organization.id}/skills/${skill!.id}/files`,
      {
        data: {
          path: "SKILL.md",
          content: `---\nname: ${skillSlug}\ndescription: Editable runtime skill.\n---\n\n# Version two\n`,
        },
      },
    );
    expect(editRes.ok()).toBe(true);

    const secondRunRes = await page.request.post(
      `/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`,
    );
    expect(secondRunRes.ok()).toBe(true);
    await expect.poll(async () => (await readJsonLines(capturePath)).length).toBe(2);
    const captures = await readJsonLines<{
      skill: string;
      reference: string;
      script: string;
      asset: string;
    }>(capturePath);
    expect(captures[1]).toMatchObject({
      skill: expect.stringContaining("# Version two"),
      reference: "# Guide one\n",
      script: "export const version = 1;\n",
      asset: "template-one\n",
    });
  });
});
