import { expect, test, type Page } from "@playwright/test";

type DeferredUpdatePrompt = {
  promptId: string;
  title: string;
  message: string;
  detail: string;
  totalRuns: number;
  blockers: Array<{
    runId: string;
    agentId: string | null;
    agentName: string;
    issueId: string | null;
    organizationId: string;
    organizationName: string;
  }>;
  confirmLabel: string;
  forceLabel: string;
  cancelLabel: string;
};

type DesktopUpdateProgress = {
  updateId: string;
  version: string;
  phase: "waiting_for_active_runs" | "ready_to_install";
  message: string;
  percent: number;
  blockers?: DeferredUpdatePrompt["blockers"];
  totalRuns?: number;
  automaticApply?: boolean;
  at: string;
};

async function installDesktopPromptStub(page: Page) {
  await page.addInitScript(() => {
    let promptListener: ((prompt: DeferredUpdatePrompt) => void) | null = null;
    let progressListener: ((progress: DesktopUpdateProgress) => void) | null = null;
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        getBootState: async () => ({
          runtime: { version: "0.3.6-canary.21", mode: "owned", ownerKind: "desktop" },
          paths: { instanceRoot: "/tmp/rudder-e2e" },
        }),
        onBootState: () => () => {},
        getUpdateProgress: async () => null,
        onUpdateProgress: (nextListener: (progress: DesktopUpdateProgress) => void) => {
          progressListener = nextListener;
          return () => {
            progressListener = null;
          };
        },
        setDeferredUpdatePromptReady: async () => undefined,
        onDeferredUpdatePrompt: (nextListener: (prompt: DeferredUpdatePrompt) => void) => {
          promptListener = nextListener;
          return () => {
            promptListener = null;
          };
        },
        applyUpdate: async () => ({
          status: "started",
          updateId: "update-e2e",
          version: "0.3.7-canary.1",
        }),
        respondDeferredUpdatePrompt: async () => undefined,
      },
    });
    Object.defineProperty(window, "__emitDeferredUpdatePrompt", {
      configurable: true,
      value: (prompt: DeferredUpdatePrompt) => {
        promptListener?.(prompt);
      },
    });
    Object.defineProperty(window, "__emitDesktopUpdateProgress", {
      configurable: true,
      value: (progress: DesktopUpdateProgress) => {
        progressListener?.(progress);
      },
    });
  });
}

async function emitDesktopUpdateProgress(page: Page, progress: DesktopUpdateProgress) {
  await page.evaluate((event) => {
    const emitProgress = (window as typeof window & {
      __emitDesktopUpdateProgress?: (progress: DesktopUpdateProgress) => void;
    }).__emitDesktopUpdateProgress;
    emitProgress?.(event);
  }, progress);
}

async function createOrganization(page: Page) {
  const issuePrefix = `D${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Desktop Update Prompt ${Date.now()}`,
      issuePrefix,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return await orgRes.json() as { issuePrefix: string };
}

async function showDeferredUpdatePrompt(page: Page, issuePrefix: string) {
  await page.goto(`/${issuePrefix}/workspaces/backups`);
  await page.evaluate(() => {
    const emitPrompt = (window as typeof window & {
      __emitDeferredUpdatePrompt?: (prompt: DeferredUpdatePrompt) => void;
    }).__emitDeferredUpdatePrompt;
    emitPrompt?.({
      promptId: "prompt-e2e",
      title: "Rudder",
      message: "There are 2 running agent runs in this Rudder instance.",
      detail:
        "Rudder can download the installer now, keep running work alive, then apply the update automatically after the runs finish. "
        + "The desktop app may close and reopen automatically when it is safe to replace. "
        + "Choose Stop Runs and Update Now to cancel the listed runs, quit Rudder, and apply the update immediately.\n\n"
        + "Z Studio: Wesley (run run-wesley-1)\nZ Studio: Wesley (run run-wesley-2)",
      totalRuns: 2,
      blockers: [
        {
          runId: "run-wesley-1",
          agentId: "agent-wesley",
          agentName: "Wesley",
          issueId: "issue-zst-776",
          organizationId: "org-z-studio",
          organizationName: "Z Studio",
        },
        {
          runId: "run-wesley-2",
          agentId: "agent-wesley",
          agentName: "Wesley",
          issueId: null,
          organizationId: "org-z-studio",
          organizationName: "Z Studio",
        },
      ],
      confirmLabel: "Download and Update When Idle",
      forceLabel: "Stop Runs and Update Now",
      cancelLabel: "Cancel",
    });
  });
}

async function assertDialogActionsFit(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("There are 2 running agent runs in this Rudder instance.")).toBeVisible();
  await expect(dialog.getByText("Z Studio: Wesley (run run-wesley-1)")).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).toBeTruthy();

  for (const buttonName of ["Cancel", "Stop Runs and Update Now", "Download and Update When Idle"]) {
    const button = dialog.getByRole("button", { name: buttonName });
    const buttonBox = await button.boundingBox();
    expect(buttonBox, `${buttonName} button should render`).toBeTruthy();
    expect(buttonBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
    await expect.poll(() => button.evaluate((element) => ({
      clippedHorizontally: element.scrollWidth > element.clientWidth + 1,
      clippedVertically: element.scrollHeight > element.clientHeight + 1,
    })), { message: `${buttonName} label should not be clipped` }).toEqual({
      clippedHorizontally: false,
      clippedVertically: false,
    });
  }
}

test("desktop deferred update prompt keeps long actions inside the dialog", async ({ page }, testInfo) => {
  await installDesktopPromptStub(page);

  const organization = await createOrganization(page);
  await showDeferredUpdatePrompt(page, organization.issuePrefix);

  await assertDialogActionsFit(page);

  await page.screenshot({
    path: testInfo.outputPath("desktop-update-prompt.png"),
    fullPage: true,
  });
});

test("desktop deferred update prompt keeps wrapped actions readable on narrow dark viewports", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.theme", "dark");
  });
  await installDesktopPromptStub(page);

  const organization = await createOrganization(page);
  await showDeferredUpdatePrompt(page, organization.issuePrefix);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);

  await assertDialogActionsFit(page);

  await page.screenshot({
    path: testInfo.outputPath("desktop-update-prompt-narrow-dark.png"),
    fullPage: true,
  });
});

test("desktop update progress replaces live blockers and needs no second automatic apply action", async ({ page }, testInfo) => {
  await installDesktopPromptStub(page);
  const organization = await createOrganization(page);
  await page.goto(`/${organization.issuePrefix}/workspaces/backups`);

  const blockerA = {
    runId: "run-alpha-12345678",
    agentId: "agent-mia",
    agentName: "Mia",
    issueId: "issue-alpha",
    organizationId: "org-alpha",
    organizationName: "Org Alpha",
  };
  await emitDesktopUpdateProgress(page, {
    updateId: "update-e2e",
    version: "0.3.7-canary.1",
    phase: "waiting_for_active_runs",
    message: "Waiting for 1 running agent run before applying the update.",
    percent: 100,
    totalRuns: 1,
    blockers: [blockerA],
    automaticApply: true,
    at: new Date().toISOString(),
  });

  await expect(page.getByText("Org Alpha · Mia · run run-alph")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop runs and update now" })).toBeVisible();

  await emitDesktopUpdateProgress(page, {
    updateId: "update-e2e",
    version: "0.3.7-canary.1",
    phase: "waiting_for_active_runs",
    message: "Waiting for 1 running agent run before applying the update.",
    percent: 100,
    totalRuns: 1,
    blockers: [{
      runId: "run-beta-87654321",
      agentId: "agent-wesley",
      agentName: "Wesley",
      issueId: "issue-beta",
      organizationId: "org-beta",
      organizationName: "Org Beta",
    }],
    automaticApply: true,
    at: new Date().toISOString(),
  });

  await expect(page.getByText("Org Alpha · Mia · run run-alph")).toHaveCount(0);
  await expect(page.getByText("Org Beta · Wesley · run run-beta")).toBeVisible();

  await emitDesktopUpdateProgress(page, {
    updateId: "update-e2e",
    version: "0.3.7-canary.1",
    phase: "ready_to_install",
    message: "Desktop update is downloaded and verified.",
    percent: 100,
    blockers: [],
    automaticApply: true,
    at: new Date().toISOString(),
  });

  await expect(page.getByText("Update ready")).toBeVisible();
  await expect(page.getByRole("button", { name: "Quit and update" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop runs and update now" })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("desktop-update-automatic-ready.png"),
    fullPage: true,
  });
});
