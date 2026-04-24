import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderTemplate, runChildProcess, selectPromptTemplate } from "./server-utils.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_ZDOTDIR = process.env.ZDOTDIR;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_ZDOTDIR === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = ORIGINAL_ZDOTDIR;
});

describe("selectPromptTemplate", () => {
  it("renders an issue-aware recovery prompt when recovery metadata and issue context are present", () => {
    const context = {
      wakeReason: "retry_failed_run",
      issue: {
        id: "issue-1",
        title: "Finish CMO onboarding",
        status: "in_progress",
        priority: "high",
        description: "Create the agent, update files, and leave the final comment.",
      },
      recovery: {
        originalRunId: "run-123",
        failureKind: "network_error",
        failureSummary: "Model connection dropped after creating the agent.",
        recoveryTrigger: "manual",
        recoveryMode: "continue_preferred",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-1", name: "CEO" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("This is a recovery run, not a fresh task.");
    expect(rendered).toContain("**Original Run ID:** run-123");
    expect(rendered).toContain("Finish CMO onboarding");
    expect(rendered).toContain("inspect what the previous run already completed");
    expect(rendered).toContain("Avoid blindly re-running the whole task.");
  });

  it("renders a generic recovery prompt when no issue snapshot is available", () => {
    const context = {
      wakeReason: "process_lost_retry",
      recovery: {
        originalRunId: "run-456",
        failureKind: "process_lost",
        failureSummary: "Local child pid disappeared during execution.",
        recoveryTrigger: "automatic",
        recoveryMode: "continue_preferred",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-2", name: "Worker" },
      context,
    });

    expect(rendered).toContain("This is a recovery run, not a fresh task.");
    expect(rendered).toContain("**Original Run ID:** run-456");
    expect(rendered).toContain("**Failure Kind:** process_lost");
    expect(rendered).toContain("inspect what the previous run already completed");
    expect(rendered).not.toContain("Current Issue Context");
  });

  it("renders a passive issue follow-up prompt when close-out governance wakes the agent", () => {
    const context = {
      wakeReason: "issue_passive_followup",
      issue: {
        id: "issue-2",
        title: "Publish onboarding notes",
        status: "in_progress",
        priority: "medium",
        description: "Write the notes and close out the issue.",
      },
      passiveFollowup: {
        originRunId: "run-origin",
        previousRunId: "run-prev",
        attempt: 1,
        maxAttempts: 2,
        reason: "missing_closure",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-3", name: "Builder" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("This is a passive issue follow-up");
    expect(rendered).toContain("The previous run ended without sufficient issue close-out.");
    expect(rendered).toContain("**Origin Run ID:** run-origin");
    expect(rendered).toContain("Publish onboarding notes");
    expect(rendered).toContain("add a progress comment, mark the issue done, block it with a reason, or hand it off");
  });

  it("injects the shared org resources section into default prompts when present", () => {
    const context = {
      rudderWorkspace: {
        orgResourcesPrompt: "## Organization Resources\n\n- Rudder repo\n  - Kind: directory\n  - Locator: `~/projects/rudder`",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-3", name: "Builder" },
      context,
    });

    expect(rendered).toContain("Continue your Rudder work.");
    expect(rendered).toContain("## Organization Resources");
    expect(rendered).toContain("Locator: `~/projects/rudder`");
  });
});

describe("runChildProcess", () => {
  it("drops inherited ZDOTDIR when HOME is isolated for the child process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-"));
    const capturePath = path.join(root, "env.json");
    const childHome = path.join(root, "isolated-home");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.mkdir(childHome, { recursive: true });
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  home: process.env.HOME ?? null,",
        "  zdotdir: process.env.ZDOTDIR ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    process.env.HOME = "/Users/host-user";
    process.env.ZDOTDIR = "/Users/host-user";

    try {
      const result = await runChildProcess("run-child-process-zdotdir", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: { HOME: childHome },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string | null;
        zdotdir: string | null;
      };
      expect(capture.home).toBe(childHome);
      expect(capture.zdotdir).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit ZDOTDIR override for the child process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-zdotdir-explicit-"));
    const capturePath = path.join(root, "env.json");
    const childHome = path.join(root, "isolated-home");
    const childZdotdir = path.join(root, "isolated-zdotdir");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.mkdir(childHome, { recursive: true });
    await fs.mkdir(childZdotdir, { recursive: true });
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  home: process.env.HOME ?? null,",
        "  zdotdir: process.env.ZDOTDIR ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    process.env.HOME = "/Users/host-user";
    process.env.ZDOTDIR = "/Users/host-user";

    try {
      const result = await runChildProcess("run-child-process-zdotdir-explicit", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: { HOME: childHome, ZDOTDIR: childZdotdir },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string | null;
        zdotdir: string | null;
      };
      expect(capture.home).toBe(childHome);
      expect(capture.zdotdir).toBe(childZdotdir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("forces SIGKILL after the grace period when an aborted child ignores SIGTERM", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-abort-"));
    const scriptPath = path.join(root, "ignore-sigterm.mjs");
    let spawnedPid: number | null = null;
    await fs.writeFile(
      scriptPath,
      [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const controller = new AbortController();
    const startedAt = Date.now();

    try {
      const result = await runChildProcess("run-child-process-ignore-sigterm", process.execPath, [scriptPath], {
        cwd: root,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        abortSignal: controller.signal,
        onSpawn: async ({ pid }) => {
          spawnedPid = pid;
          setTimeout(() => controller.abort(), 50);
        },
        onLog: async () => {},
      });

      expect(result.signal).toBe("SIGTERM");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(spawnedPid).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(spawnedPid!, 0)).toThrow();
    } finally {
      controller.abort();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
