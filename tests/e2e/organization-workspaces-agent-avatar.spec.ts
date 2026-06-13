import { expect, test } from "@playwright/test";

test.describe("Organization workspaces agent avatar", () => {
  test("shows each agent workspace with the agent's generated avatar", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Agent-Avatar-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Avatar Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/workspaces`);

    await page.getByRole("button", { name: /^agents$/i }).click();

    const agentWorkspaceRow = page.locator('[data-workspace-entry-path^="agents/"] > button').filter({
      hasText: "Avatar Agent",
    });
    await expect(agentWorkspaceRow).toBeVisible();
    await expect(
      agentWorkspaceRow.getByTestId("org-workspaces-agent-icon").locator('img[src^="data:image/svg+xml"]'),
    ).toBeVisible();
    await expect(agentWorkspaceRow.getByTestId("org-workspaces-agent-badge")).toHaveText("Agent");
  });

  test("hides delete actions for protected managed Library entries", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Protected-Managed-Entries-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Instruction Guard Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agentsDirectoryRes = await request.get(
      `/api/orgs/${organization.id}/workspace/files?path=${encodeURIComponent("agents")}`,
    );
    expect(agentsDirectoryRes.ok()).toBe(true);
    const agentsDirectory = await agentsDirectoryRes.json() as {
      entries: Array<{ displayLabel?: string | null; path: string }>;
    };
    const agentWorkspace = agentsDirectory.entries.find((entry) => entry.displayLabel === "Instruction Guard Agent");
    expect(agentWorkspace).toBeTruthy();

    const instructionsPath = `${agentWorkspace!.path}/instructions`;
    const heartbeatPath = `${instructionsPath}/HEARTBEAT.md`;
    const memoryPath = `${agentWorkspace!.path}/memory/session-notes.md`;
    const agentSkillDirPath = `${agentWorkspace!.path}/skills/agent-helper`;
    const agentSkillPath = `${agentSkillDirPath}/SKILL.md`;
    const orgSkillPath = "skills/org-helper/SKILL.md";

    const memoryFileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: memoryPath,
        content: "# Memory\n",
      },
    });
    expect(memoryFileRes.ok()).toBe(true);
    const agentSkillDirRes = await request.post(`/api/orgs/${organization.id}/workspace/directory`, {
      data: {
        directoryPath: agentSkillDirPath,
      },
    });
    expect(agentSkillDirRes.ok()).toBe(true);
    const agentSkillFileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: agentSkillPath,
        content: "---\nname: agent-helper\ndescription: Agent helper skill.\n---\n",
      },
    });
    expect(agentSkillFileRes.ok()).toBe(true);
    const orgSkillRes = await request.post(`/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Org Helper",
        slug: "org-helper",
        markdown: "---\nname: org-helper\ndescription: Org helper skill.\n---\n\n# Org Helper\n",
      },
    });
    expect(orgSkillRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    async function expectProtectedMenu(entryPath: string, options?: { includesNewFile?: boolean }) {
      const row = page.locator(`[data-workspace-entry-path="${entryPath}"]`);
      await expect(row).toBeVisible();
      await row.hover();
      await page.getByTestId(`org-workspaces-entry-more-${entryPath}`).click();

      const menu = page.getByRole("menu");
      await expect(menu).toContainText("Copy file path");
      if (options?.includesNewFile) {
        await expect(menu).toContainText("New file");
      }
      await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(heartbeatPath)}`);
    await expectProtectedMenu(instructionsPath, { includesNewFile: true });
    await expectProtectedMenu(heartbeatPath);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(memoryPath)}`);
    await expectProtectedMenu(`${agentWorkspace!.path}/memory`, { includesNewFile: true });
    await expectProtectedMenu(memoryPath);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(agentSkillPath)}`);
    await expectProtectedMenu(`${agentWorkspace!.path}/skills`, { includesNewFile: true });
    await expectProtectedMenu(agentSkillPath);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(orgSkillPath)}`);
    await expectProtectedMenu("skills", { includesNewFile: true });
    await expectProtectedMenu(orgSkillPath);
  });

  test("moves entries by drag-and-drop and supports VS Code-style tree keyboard selection", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Tree-Interaction-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const folderPath = "target-folder";
    const filePath = "tree-file.md";
    const movedPath = `${folderPath}/${filePath}`;

    const directoryRes = await request.post(`/api/orgs/${organization.id}/workspace/directory`, {
      data: { directoryPath: folderPath },
    });
    expect(directoryRes.ok()).toBe(true);
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: "# Tree file\n" },
    });
    expect(fileRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/library`);

    const folderRow = page.locator(`[data-workspace-entry-path="${folderPath}"]`);
    const folderButton = folderRow.locator("> button").first();
    const fileRow = page.locator(`[data-workspace-entry-path="${filePath}"]`);
    await expect(folderRow).toBeVisible();
    await expect(fileRow).toBeVisible();

    await folderButton.click();
    await expect(folderButton).toHaveAttribute("aria-selected", "true");
    await folderButton.press("ArrowDown");
    await expect(fileRow.locator("> button").first()).toBeFocused();
    await expect(fileRow.locator("> button").first()).toHaveAttribute("aria-selected", "true");

    await fileRow.dragTo(folderRow);
    await expect(page.locator(`[data-workspace-entry-path="${movedPath}"]`)).toBeVisible();
    await expect(page.getByTestId("org-workspaces-files-card")).not.toHaveClass(/ring-1/);

    const movedFileRes = await request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(movedPath)}`,
    );
    expect(movedFileRes.ok()).toBe(true);
    await expect(fileRow).toHaveCount(0);
  });

  test("renders Milkdown workspace mentions as single inline tokens", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Mention-Tokens-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Winter (CEO)",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const targetFilePath = "docs-proposal.md";
    const sourceFilePath = "mention-tokens.md";
    const skillPath = `${process.cwd()}/server/resources/bundled-skills/skill-creator/SKILL.md`;
    const sourceContent = [
      `[Winter (CEO)](agent://${agent.id})`,
      "",
      `[docs-proposal.md](library-file://file?p=${encodeURIComponent(targetFilePath)})`,
      "",
      `[skill-creator](${skillPath})`,
      "",
    ].join("\n");

    const targetFileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath: targetFilePath, content: "# Proposal\n" },
    });
    expect(targetFileRes.ok()).toBe(true);
    const sourceFileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath: sourceFilePath, content: sourceContent },
    });
    expect(sourceFileRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(sourceFilePath)}`);
    await expect(page.locator(".rudder-milkdown-content [data-mention-kind='agent']")).toBeVisible();
    await expect(page.locator(".rudder-milkdown-content [data-mention-kind='library_file']")).toBeVisible();
    await expect(page.locator(".rudder-milkdown-content [data-skill-token='true']")).toBeVisible();

    const tokenStyles = await page.evaluate(() => {
      const tokenSelector = ".rudder-milkdown-content [data-mention-kind], .rudder-milkdown-content [data-skill-token='true']";
      const linkSelector = ".rudder-milkdown-content a:has(> [data-mention-kind]), .rudder-milkdown-content a:has(> [data-skill-token='true'])";
      return {
        tokens: Array.from(document.querySelectorAll<HTMLElement>(tokenSelector)).map((element) => ({
          text: element.textContent,
          display: getComputedStyle(element).display,
          style: element.getAttribute("style") ?? "",
          beforeContent: getComputedStyle(element, "::before").content,
          beforeMask: getComputedStyle(element, "::before").maskImage || getComputedStyle(element, "::before").webkitMaskImage,
        })),
        wrapperLinks: Array.from(document.querySelectorAll<HTMLElement>(linkSelector)).map((element) => ({
          text: element.textContent,
          display: getComputedStyle(element).display,
          beforeContent: getComputedStyle(element, "::before").content,
        })),
      };
    });

    expect(tokenStyles.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Winter (CEO)", display: "inline-flex", beforeContent: "\"\"" }),
      expect.objectContaining({ text: "docs-proposal.md", display: "inline-flex", beforeContent: "\"\"" }),
      expect.objectContaining({ text: "skill-creator", display: "inline-flex", beforeContent: "\"\"" }),
    ]));
    expect(tokenStyles.tokens.find((token) => token.text === "docs-proposal.md")?.beforeMask).not.toBe("none");
    expect(tokenStyles.tokens.find((token) => token.text === "docs-proposal.md")?.style).toContain("--rudder-mention-icon-mask");
    expect(tokenStyles.tokens.find((token) => token.text === "skill-creator")?.beforeMask).not.toBe("none");
    expect(tokenStyles.tokens.find((token) => token.text === "skill-creator")?.style).toContain("--rudder-skill-icon-mask");
    expect(tokenStyles.wrapperLinks).toHaveLength(3);
    for (const wrapper of tokenStyles.wrapperLinks) {
      expect(wrapper.display).toBe("inline");
      expect(wrapper.beforeContent).toBe("none");
    }
  });
});
