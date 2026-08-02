import { expect, test } from "@playwright/test";

function uniqueIssuePrefix(namespace: string) {
  return `${namespace}${Date.now().toString(36).slice(-7)}`.toUpperCase();
}

test.describe("Organization workspaces agent avatar", () => {
  test("shows each agent workspace with the agent's generated avatar", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Agent-Avatar-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("AVA"),
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
        issuePrefix: uniqueIssuePrefix("GRD"),
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
    const heartbeatFileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: heartbeatPath,
        content: "# Legacy Heartbeat\n",
      },
    });
    expect(heartbeatFileRes.ok()).toBe(true);
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
      await expect(menu).toContainText("Copy absolute path");
      if (options?.includesNewFile) {
        await expect(menu).toContainText("New file");
      }
      await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(heartbeatPath)}`);
    const legacyHeartbeatDialog = page.getByRole("dialog", { name: "Legacy HEARTBEAT.md" });
    await expect(legacyHeartbeatDialog).toBeVisible();
    await legacyHeartbeatDialog.getByRole("button", { name: "Keep files for now" }).click();

    await page.goto(`/${organization.issuePrefix}/library?directory=${encodeURIComponent(instructionsPath)}`);
    await expectProtectedMenu(instructionsPath);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(memoryPath)}`);
    await expectProtectedMenu(`${agentWorkspace!.path}/memory`, { includesNewFile: true });
    await expectProtectedMenu(memoryPath);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(agentSkillPath)}`);
    await expectProtectedMenu(`${agentWorkspace!.path}/skills`, { includesNewFile: true });
    await expectProtectedMenu(agentSkillPath);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(orgSkillPath)}`);
    await expectProtectedMenu("skills");
    await expectProtectedMenu(orgSkillPath);
  });

  test("deletes a Library workspace folder after its agent has been deleted", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Orphan-Agent-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("ORP"),
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Disposable Library Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const instructionsRes = await request.put(`/api/agents/${agent.id}/instructions-bundle/file`, {
      data: {
        path: "SOUL.md",
        content: "# Disposable Library Agent\n",
      },
    });
    expect(instructionsRes.ok()).toBe(true);

    const activeListingRes = await request.get(
      `/api/orgs/${organization.id}/workspace/files?path=${encodeURIComponent("agents")}`,
    );
    expect(activeListingRes.ok()).toBe(true);
    const activeListing = await activeListingRes.json() as {
      entries: Array<{ path: string; displayLabel?: string; entityType?: string }>;
    };
    const activeWorkspace = activeListing.entries.find((entry) => entry.displayLabel === "Disposable Library Agent");
    expect(activeWorkspace?.entityType).toBe("agent_workspace");

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/library`);

    await page.getByRole("button", { name: /^agents$/i }).click();
    const orphanedWorkspacePath = activeWorkspace!.path;
    const orphanedRow = page.locator(`[data-workspace-entry-path="${orphanedWorkspacePath}"]`);
    await expect(orphanedRow).toBeVisible();
    await expect(orphanedRow.getByTestId("org-workspaces-agent-badge")).toHaveText("Agent");
    await orphanedRow.hover();
    await page.getByTestId(`org-workspaces-entry-more-${orphanedWorkspacePath}`).click();

    let menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    const workspaceReclassifiedPromise = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/files`)
      && new URL(response.url()).searchParams.get("path") === "agents"
    ));
    const deleteAgentRes = await request.delete(`/api/agents/${agent.id}`);
    expect(deleteAgentRes.ok()).toBe(true);
    const workspaceReclassifiedResponse = await workspaceReclassifiedPromise;
    expect(workspaceReclassifiedResponse.ok()).toBe(true);

    await expect(orphanedRow.getByTestId("org-workspaces-agent-badge")).toHaveCount(0);
    await orphanedRow.hover();
    await page.getByTestId(`org-workspaces-entry-more-${orphanedWorkspacePath}`).click();

    menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Delete" }).click();

    const dialog = page.getByRole("dialog", { name: "Delete deleted agent folder?" });
    await expect(dialog).toContainText("This folder is no longer linked to an active agent.");
    await expect(dialog).toContainText(orphanedWorkspacePath);

    const deleteWorkspaceResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/entry`)
    ));
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    const deleteWorkspaceResponse = await deleteWorkspaceResponsePromise;
    expect(deleteWorkspaceResponse.ok()).toBe(true);
    await expect(orphanedRow).toHaveCount(0);

    const deletedListingRes = await request.get(
      `/api/orgs/${organization.id}/workspace/files?path=${encodeURIComponent("agents")}`,
    );
    expect(deletedListingRes.ok()).toBe(true);
    const deletedListing = await deletedListingRes.json() as { entries: Array<{ path: string }> };
    expect(deletedListing.entries.some((entry) => entry.path === orphanedWorkspacePath)).toBe(false);
  });

  test("moves entries by drag-and-drop and supports VS Code-style tree keyboard selection", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Tree-Interaction-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("TRE"),
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

  test("renders CodeMirror workspace mentions as single inline tokens", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Mention-Tokens-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("MNT"),
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
    const editor = page
      .getByTestId("org-workspaces-markdown-editor")
      .locator('[data-editor-engine="codemirror-live-preview"]');
    await expect(editor.locator("[data-mention-kind='agent']")).toBeVisible();
    await expect(editor.locator("[data-mention-kind='library_file']")).toBeVisible();
    await expect(editor.locator("[data-skill-token='true']")).toBeVisible();

    const tokenStyles = await editor.evaluate((editorRoot) => {
      const tokenSelector = "[data-mention-kind], [data-skill-token='true']";
      const linkSelector = "a:has(> [data-mention-kind]), a:has(> [data-skill-token='true'])";
      return {
        tokens: Array.from(editorRoot.querySelectorAll<HTMLElement>(tokenSelector)).map((element) => ({
          text: element.textContent,
          display: getComputedStyle(element).display,
          style: element.getAttribute("style") ?? "",
          beforeContent: getComputedStyle(element, "::before").content,
          beforeMask: getComputedStyle(element, "::before").maskImage || getComputedStyle(element, "::before").webkitMaskImage,
        })),
        wrapperLinks: Array.from(editorRoot.querySelectorAll<HTMLElement>(linkSelector)).map((element) => ({
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
