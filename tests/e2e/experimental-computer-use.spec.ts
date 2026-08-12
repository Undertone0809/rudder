import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";

type McpResponse = {
  id: number;
  result?: {
    tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    isError?: boolean;
    structuredContent?: { code?: string };
  };
};

test.describe("Experimental Computer Use", () => {
  test.describe.configure({ mode: "serial" });

  test("enables one Desktop-backed Agent capability without adding a new workflow", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const organization = await page.request.post("/api/orgs", {
      data: {
        name: `Computer Use E2E ${Date.now()}`,
        issuePrefix: `CU${Date.now().toString().slice(-6)}`,
      },
    });
    expect(organization.ok(), await organization.text()).toBe(true);
    await page.request.patch("/api/instance/settings/general", {
      data: { experimentalComputerUseEnabled: false },
    });
    await page.addInitScript(() => {
      const state = { permissionRequests: 0 };
      window.localStorage.setItem("rudder.productTour.completed.v1", "true");
      window.localStorage.removeItem("rudder.productTour.pendingAfterSetup.v1");
      Object.defineProperty(window, "__computerUseE2E", { configurable: true, value: state });
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          computerUse: {
            supported: true,
            readiness: async () => ({
              supported: true,
              platform: "darwin",
              driverAvailable: true,
              accessibility: state.permissionRequests > 0,
              screenRecording: state.permissionRequests > 0,
              actionReady: state.permissionRequests > 0,
              permissionPromptAvailable: true,
              screenRecordingSettingsAvailable: state.permissionRequests === 0,
              driverVersion: "0.19.2",
              reason: state.permissionRequests > 0 ? null : "Accessibility and Screen Recording access are required.",
            }),
            requestPermissions: async () => {
              state.permissionRequests += 1;
              return {
                supported: true,
                platform: "darwin",
                driverAvailable: true,
                accessibility: true,
                screenRecording: true,
                actionReady: true,
                permissionPromptAvailable: true,
                screenRecordingSettingsAvailable: false,
                driverVersion: "0.19.2",
                reason: null,
              };
            },
            openScreenRecordingSettings: async () => ({ opened: true }),
          },
        },
      });
    });

    await page.goto("/instance/settings/experimental", { waitUntil: "domcontentloaded" });
    const toggle = page.getByTestId("experimental-computer-use-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __computerUseE2E?: { permissionRequests: number } }
    ).__computerUseE2E?.permissionRequests)).toBe(1);
    const settings = await page.request.get("/api/instance/settings/general");
    expect(settings.ok(), await settings.text()).toBe(true);
    await expect(settings.json()).resolves.toMatchObject({ experimentalComputerUseEnabled: true });
    await expect(page.getByText("Agents can observe and operate apps on this device.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("experimental-computer-use-light.png"), fullPage: true });

    await page.evaluate(() => {
      window.localStorage.setItem("rudder.theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await page.screenshot({ path: testInfo.outputPath("experimental-computer-use-dark.png"), fullPage: true });
  });

  test("projects only Computer Use tools from the dedicated MCP server", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const child = spawn(process.execPath, [
      path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
      path.join(repoRoot, "cli/src/index.ts"),
      "mcp-server",
      "--server",
      "computer",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RUDDER_API_URL: "http://127.0.0.1:1",
        RUDDER_API_KEY: "e2e-runtime-key",
        RUDDER_ORG_ID: "e2e-org",
        RUDDER_AGENT_ID: "e2e-agent",
        RUDDER_RUN_ID: "e2e-run",
        RUDDER_COMPUTER_ENABLED: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "rudder_computer_click", arguments: { observationId: "not-a-uuid", x: 1, y: 2 } },
    })}\n`);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode, stderr).toBe(0);
    const responses = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as McpResponse);
    const tools = responses.find((response) => response.id === 1)?.result?.tools ?? [];
    expect(tools).toHaveLength(13);
    expect(tools.every((tool) => tool.name.startsWith("rudder_computer_"))).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain("rudder_computer_launch_app");
    expect(responses.find((response) => response.id === 2)?.result).toMatchObject({
      isError: true,
      structuredContent: { code: "computer_invalid_argument" },
    });
  });
});
