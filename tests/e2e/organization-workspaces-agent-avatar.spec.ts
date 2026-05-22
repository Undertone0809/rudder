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
      `[docs-proposal.md](library-file://file?p=${encodeURIComponent(targetFilePath)}&t=docs-proposal.md)`,
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
