import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOrganizationStorageKey } from "../../packages/agent-runtime-utils/src/organization-storage.ts";
import { E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

test.describe("Agent instructions Library redirect", () => {
  test("opens instructions in Library from the tab and legacy URL", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: { name: `Agent-Instructions-Redirect-${Date.now()}` },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Instructions Redirect Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const detailRes = await request.get(`/api/agents/${agent.id}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json() as { instructionsLibraryPath: string | null };
    expect(detail.instructionsLibraryPath).toBeTruthy();

    const instructionsDirectory = detail.instructionsLibraryPath!;
    const organizationStorageKey = resolveOrganizationStorageKey(organization.id);
    const canonicalRoot = path.join(
      E2E_HOME,
      "instances",
      E2E_INSTANCE_ID,
      "organizations",
      organizationStorageKey,
      "workspaces",
      instructionsDirectory,
    );
    const previousInstanceId = E2E_INSTANCE_ID === "default" ? "previous" : "default";
    const historicalRoot = path.join(
      E2E_HOME,
      "instances",
      previousInstanceId,
      "organizations",
      organization.id,
      "workspaces",
      instructionsDirectory,
    );
    await fs.rm(canonicalRoot, { recursive: true, force: true });
    await fs.mkdir(historicalRoot, { recursive: true });
    await fs.writeFile(path.join(historicalRoot, "SOUL.md"), "# Recovered Vera persona\n", "utf8");

    const externalConfigRes = await request.patch(`/api/agents/${agent.id}`, {
      data: {
        agentRuntimeConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: historicalRoot,
          instructionsEntryFile: "SOUL.md",
          instructionsFilePath: path.join(historicalRoot, "SOUL.md"),
        },
      },
    });
    expect(externalConfigRes.ok()).toBe(true);

    const recoveredBundleRes = await request.get(`/api/agents/${agent.id}/instructions-bundle`);
    expect(recoveredBundleRes.ok()).toBe(true);
    const recoveredBundle = await recoveredBundleRes.json() as {
      mode: string | null;
      rootPath: string | null;
      files: Array<{ path: string }>;
    };
    expect(recoveredBundle.mode).toBe("managed");
    expect(recoveredBundle.rootPath).toBe(canonicalRoot);
    expect(recoveredBundle.files.map((file) => file.path)).toEqual(["MEMORY.md", "SOUL.md", "TOOLS.md"]);
    const recoveredSoulRes = await request.get(
      `/api/agents/${agent.id}/instructions-bundle/file?path=${encodeURIComponent("SOUL.md")}`,
    );
    expect(recoveredSoulRes.ok()).toBe(true);
    await expect(recoveredSoulRes.json()).resolves.toEqual(expect.objectContaining({
      path: "SOUL.md",
      content: "# Recovered Vera persona\n",
    }));

    const recoveredDetailRes = await request.get(`/api/agents/${agent.id}`);
    expect(recoveredDetailRes.ok()).toBe(true);
    const recoveredDetail = await recoveredDetailRes.json() as { instructionsLibraryPath: string | null };
    expect(recoveredDetail.instructionsLibraryPath).toBe(instructionsDirectory);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/dashboard`);
    await page.getByRole("tab", { name: "Instructions" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/library\\?directory=`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(instructionsDirectory);
    await expect(page.getByTestId("workspace-context-header")).toHaveAttribute("aria-label", "Library");
    await expect(page.getByText("SOUL.md", { exact: true })).toBeVisible();
    await expect(page.getByText("TOOLS.md", { exact: true })).toBeVisible();
    await expect(page.getByText("MEMORY.md", { exact: true })).toBeVisible();

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/instructions`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/library\\?directory=`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(detail.instructionsLibraryPath);
    await expect(page.getByRole("tab", { name: "Instructions" })).toHaveCount(0);

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/prompts`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/library\\?directory=`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(detail.instructionsLibraryPath);

    const ordinaryExternalRoot = path.join(E2E_HOME, "ordinary-external-instructions");
    const ordinaryExternalBundleRes = await request.patch(`/api/agents/${agent.id}/instructions-bundle`, {
      data: {
        mode: "external",
        rootPath: ordinaryExternalRoot,
        entryFile: "SOUL.md",
      },
    });
    expect(ordinaryExternalBundleRes.ok()).toBe(true);

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/dashboard`);
    await expect(page.getByRole("tab", { name: "Instructions" })).toHaveCount(0);
    await page.goto(`/${organization.urlKey}/agents/${agent.id}/instructions`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/agents/[^/]+/dashboard$`));
  });
});
