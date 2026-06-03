import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIssueDocumentsPrompt,
  ensureLocalCliCredentialShimsInPath,
  ensureRudderCliInPath,
  resolveLocalOperatorHome,
  syncLocalCliCredentialHomeEntries,
  loadAgentInstructionsPrefix,
  renderTemplate,
  RUDDER_AGENT_OPERATING_CONTRACT,
  runChildProcess,
  selectPromptTemplate,
} from "./server-utils.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_RUDDER_OPERATOR_HOME = process.env.RUDDER_OPERATOR_HOME;
const ORIGINAL_ZDOTDIR = process.env.ZDOTDIR;
const ORIGINAL_GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL;
const ORIGINAL_GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_RUDDER_OPERATOR_HOME === undefined) delete process.env.RUDDER_OPERATOR_HOME;
  else process.env.RUDDER_OPERATOR_HOME = ORIGINAL_RUDDER_OPERATOR_HOME;
  if (ORIGINAL_ZDOTDIR === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = ORIGINAL_ZDOTDIR;
  if (ORIGINAL_GIT_AUTHOR_EMAIL === undefined) delete process.env.GIT_AUTHOR_EMAIL;
  else process.env.GIT_AUTHOR_EMAIL = ORIGINAL_GIT_AUTHOR_EMAIL;
  if (ORIGINAL_GIT_COMMITTER_EMAIL === undefined) delete process.env.GIT_COMMITTER_EMAIL;
  else process.env.GIT_COMMITTER_EMAIL = ORIGINAL_GIT_COMMITTER_EMAIL;
});

function readPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? "";
}

function shimName(): string {
  return process.platform === "win32" ? "rudder.cmd" : "rudder";
}

describe("ensureRudderCliInPath", () => {
  it("prefers the current source CLI shim over an existing rudder binary on PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cli-source-shim-"));
    const moduleDir = path.join(root, "packages", "agent-runtime-utils", "src");
    const staleBinDir = path.join(root, "stale-bin");
    const staleRudder = path.join(staleBinDir, shimName());
    const tsxEntry = path.join(root, "cli", "node_modules", "tsx", "dist", "cli.mjs");
    const cliSource = path.join(root, "cli", "src", "index.ts");

    try {
      await fs.mkdir(path.dirname(tsxEntry), { recursive: true });
      await fs.mkdir(path.dirname(cliSource), { recursive: true });
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.mkdir(staleBinDir, { recursive: true });
      await fs.writeFile(tsxEntry, "console.log('fake tsx');\n", "utf8");
      await fs.writeFile(cliSource, "console.log('fake rudder source');\n", "utf8");
      await fs.writeFile(
        staleRudder,
        process.platform === "win32" ? "@echo off\r\necho stale\r\n" : "#!/bin/sh\necho stale\n",
        "utf8",
      );
      await fs.chmod(staleRudder, 0o755);

      const env = await ensureRudderCliInPath(moduleDir, {
        PATH: staleBinDir,
      });
      const firstPathEntry = readPathValue(env).split(path.delimiter)[0];
      const shimPath = path.join(firstPathEntry!, shimName());
      const shim = await fs.readFile(shimPath, "utf8");

      expect(firstPathEntry).not.toBe(staleBinDir);
      expect(shim).toContain(tsxEntry);
      expect(shim).toContain(cliSource);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("materializes a shim for non-executable packaged desktop CLI files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cli-packaged-shim-"));
    const packageRoot = path.join(root, "server-package");
    const moduleDir = path.join(packageRoot, "node_modules", "@rudderhq", "agent-runtime-utils", "dist");
    const desktopCli = path.join(packageRoot, "desktop-cli.js");

    try {
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(desktopCli, "console.log('fake desktop cli');\n", "utf8");

      const env = await ensureRudderCliInPath(moduleDir, {
        PATH: "",
      });
      const firstPathEntry = readPathValue(env).split(path.delimiter)[0];
      const shimPath = path.join(firstPathEntry!, shimName());
      const shim = await fs.readFile(shimPath, "utf8");

      expect(shim).toContain(desktopCli);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("selectPromptTemplate", () => {
  it("keeps issue assignment prompts neutral for non-code work", () => {
    const context = {
      wakeReason: "issue_assigned",
      issue: {
        id: "issue-screenshot",
        title: "Can you see this screen?",
        status: "todo",
        priority: "medium",
        description: "![](/api/assets/screenshot/content)",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-1", name: "Operator" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("understand what kind of work it asks for");
    expect(rendered).toContain("Do not assume every issue is a codebase task.");
    expect(rendered).toContain("If the issue is a question, screenshot check, review, planning request, coordination task");
    expect(rendered).toContain("Inspect the codebase and implement a change only when");
    expect(rendered).not.toContain("Use the available tools to explore the codebase");
    expect(rendered).not.toContain("implement a solution.");
  });

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
    expect(rendered).toContain("- Original Run ID: run-123");
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
    expect(rendered).toContain("- Original Run ID: run-456");
    expect(rendered).toContain("- Failure Kind: process_lost");
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
    expect(rendered).toContain("- Origin Run ID: run-origin");
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

  it("renders issue document references in issue-aware prompts without inlining bodies", () => {
    const issueDocumentsPrompt = buildIssueDocumentsPrompt({
      planDocument: {
        issueId: "issue-3",
        key: "plan",
        title: "Execution Plan",
        body: "# Plan\n\nCheck the document-backed requirements.",
      },
      documentSummaries: [
        {
          issueId: "issue-3",
          key: "design",
          title: "Design Notes",
          latestRevisionNumber: 2,
        },
      ],
    });
    const context = {
      wakeReason: "issue_assigned",
      issueDocumentsPrompt,
      issue: {
        id: "issue-3",
        title: "Use issue docs",
        status: "todo",
        priority: "medium",
        description: "Short description.",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-4", name: "Builder" },
      context,
      issue: context.issue,
    });

    expect(issueDocumentsPrompt).toContain("## Legacy Issue Documents");
    expect(issueDocumentsPrompt).toContain("These legacy issue documents are not inlined automatically.");
    expect(issueDocumentsPrompt).toContain("library:projects/<project-name>/");
    expect(issueDocumentsPrompt).toContain("rudder issue documents get issue-3 plan --json");
    expect(issueDocumentsPrompt).toContain("rudder issue documents get issue-3 design --json");
    expect(issueDocumentsPrompt).not.toContain("Check the document-backed requirements.");
    expect(rendered).toContain("Use issue docs");
    expect(rendered).toContain("## Legacy Issue Documents");
    expect(rendered).not.toContain("Check the document-backed requirements.");
  });

  it("renders reviewer changes-requested comment context before generic assignment prompts", () => {
    const context = {
      wakeSource: "assignment",
      wakeReason: "issue_changes_requested",
      issue: {
        id: "issue-4",
        title: "Fix reviewer feedback",
        status: "in_progress",
        priority: "high",
        description: "Address the review notes.",
      },
      comment: {
        id: "comment-4",
        authorKind: "agent",
        authorLabel: "Riley Reviewer",
        body: "Please add coverage for the todo return path.",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-5", name: "Builder" },
      context,
      issue: context.issue,
      comment: context.comment,
    });

    expect(rendered).toContain("A reviewer requested changes on an issue you own.");
    expect(rendered).toContain("Fix reviewer feedback");
    expect(rendered).toContain("From: Riley Reviewer (agent)");
    expect(rendered).toContain("Please add coverage for the todo return path.");
    expect(rendered).not.toContain("You have been assigned to work on an issue.");
  });

  it("renders comment attribution for assignee and mention wake prompts", () => {
    const issue = {
      id: "issue-5",
      title: "Clarify comment ownership",
      status: "todo",
      priority: "medium",
      description: "Make comment-triggered runs show who commented.",
    };
    const comment = {
      id: "comment-5",
      authorKind: "user",
      authorLabel: "Alex Operator",
      body: "@builder please use the compact interaction pattern.",
    };

    const assigneePrompt = renderTemplate(
      selectPromptTemplate(undefined, { wakeReason: "issue_commented", issue, comment }),
      {
        agent: { id: "agent-6", name: "Builder" },
        context: { wakeReason: "issue_commented", issue, comment },
        issue,
        comment,
      },
    );
    const mentionPrompt = renderTemplate(
      selectPromptTemplate(undefined, { wakeReason: "issue_comment_mentioned", issue, comment }),
      {
        agent: { id: "agent-7", name: "Mentioned Builder" },
        context: { wakeReason: "issue_comment_mentioned", issue, comment },
        issue,
        comment,
      },
    );

    expect(assigneePrompt).toContain("There is a new comment on an issue you own.");
    expect(assigneePrompt).toContain("From: Alex Operator (user)");
    expect(assigneePrompt).toContain("@builder please use the compact interaction pattern.");
    expect(mentionPrompt).toContain("You were mentioned in a comment and your attention is needed.");
    expect(mentionPrompt).toContain("From: Alex Operator (user)");
    expect(mentionPrompt).toContain("@builder please use the compact interaction pattern.");
    expect(mentionPrompt).toContain("An @mention is an explicit request for attention or collaboration");
    expect(mentionPrompt).toContain("not an automatic transfer of issue ownership");
  });
});

describe("loadAgentInstructionsPrefix", () => {
  it("loads the runtime operating contract without an instruction file", async () => {
    const loaded = await loadAgentInstructionsPrefix({
      instructionsFilePath: "",
      onLog: async () => {},
    });

    expect(loaded.prefix).toContain("# Rudder Agent Operating Contract");
    expect(loaded.prefix).toContain(RUDDER_AGENT_OPERATING_CONTRACT);
    expect(loaded.prefix).toContain("installed but not enabled");
    expect(loaded.prefix).toContain("library:projects/<project-name>/");
    expect(loaded.prefix).toContain("always include a user-visible Markdown link");
    expect(loaded.prefix).toContain("library-file://file?p=<url-encoded-relative-path>&t=<url-encoded-title>");
    expect(loaded.prefix).toContain("Use `/tmp` only for transient scratch files");
    expect(loaded.prefix).toContain("Local trusted runtimes may expose the host operator home as `$RUDDER_OPERATOR_HOME`");
    expect(loaded.prefix).toContain("structured markdown link like `[@AgentName](agent://agent-id)`");
    expect(loaded.prefix).toContain("attach the image with the Rudder CLI `--image <path>` option");
    expect(loaded.commandNotes).toEqual(["Loaded Rudder agent operating contract from runtime code"]);
    expect(loaded.readFailed).toBe(false);
    expect(loaded.memoryFilePath).toBeNull();
    expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
    expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
    expect(loaded.metrics.instructionEntryChars).toBe(0);
    expect(loaded.metrics.memoryChars).toBe(0);
  });

  it("loads the operating contract and entry instructions when no sibling memory file exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-entry-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(loaded.prefix).toContain("# Rudder Agent Operating Contract");
      expect(loaded.prefix).toContain("# Agent Instructions");
      expect(loaded.prefix).toContain("loaded from $AGENT_HOME/instructions/AGENTS.md");
      expect(loaded.prefix).toContain("relative file references from $AGENT_HOME/instructions/");
      expect(loaded.prefix).not.toContain("Tacit Memory");
      expect(loaded.commandNotes).toEqual([
        "Loaded Rudder agent operating contract from runtime code",
        "Loaded agent instructions from $AGENT_HOME/instructions/AGENTS.md",
      ]);
      expect(loaded.memoryFilePath).toBeNull();
      expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
      expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
      expect(loaded.metrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loaded.metrics.memoryChars).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining("[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md"),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads the entry instructions file plus sibling SOUL.md, TOOLS.md, and MEMORY.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-memory-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    const heartbeatPath = path.join(root, "instructions", "HEARTBEAT.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(soulPath, "# Persona\n\nYou are QA.\n", "utf8");
    await fs.writeFile(toolsPath, "# Tools\n\n- Use rudder.\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Prefer concise updates.\n", "utf8");
    await fs.writeFile(heartbeatPath, "# Heartbeat\n\n- Check assignments.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain("# Agent Instructions");
      expect(loaded.prefix).toContain("# Persona");
      expect(loaded.prefix).toContain("# Tools");
      expect(loaded.prefix).toContain("# Tacit Memory");
      expect(loaded.prefix).not.toContain("# Heartbeat");
      expect(loaded.commandNotes).toContain("Loaded agent instructions from $AGENT_HOME/instructions/AGENTS.md");
      expect(loaded.commandNotes).toContain("Loaded agent soul instructions from $AGENT_HOME/instructions/SOUL.md");
      expect(loaded.commandNotes).toContain("Loaded agent tool notes from $AGENT_HOME/instructions/TOOLS.md");
      expect(loaded.commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(loaded.commandNotes).not.toContain("Loaded agent heartbeat instructions from $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(loaded.soulFilePath).toBe(soulPath);
      expect(loaded.toolsFilePath).toBe(toolsPath);
      expect(loaded.memoryFilePath).toBe(memoryPath);
      expect(loaded.heartbeatFilePath).toBeNull();
      expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
      expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
      expect(loaded.metrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loaded.metrics.soulChars).toBeGreaterThan(0);
      expect(loaded.metrics.toolsChars).toBeGreaterThan(0);
      expect(loaded.metrics.memoryChars).toBeGreaterThan(0);
      expect(loaded.metrics.heartbeatChars).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads sibling HEARTBEAT.md only when heartbeat instructions are requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-heartbeat-"));
    const instructionsPath = path.join(root, "instructions", "SOUL.md");
    const heartbeatPath = path.join(root, "instructions", "HEARTBEAT.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Persona\n\nYou are QA.\n", "utf8");
    await fs.writeFile(heartbeatPath, "# Heartbeat\n\n- Check assignments.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        includeHeartbeatInstructions: true,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain("# Persona");
      expect(loaded.prefix).toContain("# Heartbeat");
      expect(loaded.commandNotes).toContain("Loaded agent heartbeat instructions from $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(loaded.heartbeatFilePath).toBe(heartbeatPath);
      expect(loaded.metrics.heartbeatChars).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the existing warning behavior when the entry file is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-missing-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        warningStream: "stderr",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(loaded.prefix).toContain("# Rudder Agent Operating Contract");
      expect(loaded.prefix).not.toContain("# Agent Instructions");
      expect(loaded.readFailed).toBe(true);
      expect(loaded.commandNotes).toContain(
        "Configured instructionsFilePath $AGENT_HOME/instructions/AGENTS.md, but file could not be read; continuing without injected instructions.",
      );
      expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
      expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
      expect(loaded.metrics.instructionEntryChars).toBe(0);
      expect(loaded.metrics.memoryChars).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        stream: "stderr",
        chunk: expect.stringContaining(`could not read agent instructions file "${instructionsPath}"`),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runChildProcess", () => {
  it("preserves explicit blank Git identity env overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-git-env-"));
    const capturePath = path.join(root, "env.json");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  authorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,",
        "  committerEmail: process.env.GIT_COMMITTER_EMAIL ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    process.env.GIT_AUTHOR_EMAIL = "host@machine.local";
    process.env.GIT_COMMITTER_EMAIL = "host@machine.local";

    try {
      const result = await runChildProcess("run-child-process-git-env", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: { GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_EMAIL: "" },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        authorEmail: string | null;
        committerEmail: string | null;
      };
      expect(capture.authorEmail).toBe("");
      expect(capture.committerEmail).toBe("");
    } finally {
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_EMAIL;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

describe("syncLocalCliCredentialHomeEntries", () => {
  it("uses explicit operator home when the source env HOME is already isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-operator-"));
    const operatorHome = path.join(root, "operator-home");
    const isolatedHome = path.join(root, "isolated-home");
    const targetHome = path.join(root, "agent-home");
    const operatorGh = path.join(operatorHome, ".config", "gh");
    await fs.mkdir(operatorGh, { recursive: true });
    await fs.writeFile(path.join(operatorGh, "hosts.yml"), "github.com:\n  oauth_token: operator\n", "utf8");
    await fs.mkdir(path.join(isolatedHome, ".config", "gh"), { recursive: true });

    try {
      const resolvedSourceHome = resolveLocalOperatorHome({
        HOME: isolatedHome,
        RUDDER_OPERATOR_HOME: operatorHome,
      } as NodeJS.ProcessEnv);
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome: resolvedSourceHome,
        targetHome,
        entries: [".config/gh"],
      });

      expect(resolvedSourceHome).toBe(operatorHome);
      expect(result).toEqual({ linked: [".config/gh"], skipped: [] });
      expect(await fs.realpath(path.join(targetHome, ".config", "gh"))).toBe(await fs.realpath(operatorGh));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("links selected host CLI credential entries into a managed runtime home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-"));
    const sourceHome = path.join(root, "host-home");
    const targetHome = path.join(root, "agent-home");
    const ghHosts = path.join(sourceHome, ".config", "gh", "hosts.yml");
    const sshKey = path.join(sourceHome, ".ssh", "id_ed25519");
    await fs.mkdir(path.dirname(ghHosts), { recursive: true });
    await fs.mkdir(path.dirname(sshKey), { recursive: true });
    await fs.writeFile(ghHosts, "github.com:\n  oauth_token: redacted\n", "utf8");
    await fs.writeFile(sshKey, "redacted-key\n", "utf8");

    try {
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome,
        targetHome,
        entries: [".config/gh", ".ssh"],
      });

      expect(result.linked.sort()).toEqual([".config/gh", ".ssh"]);
      const linkedGh = await fs.readlink(path.join(targetHome, ".config", "gh"));
      const linkedSsh = await fs.readlink(path.join(targetHome, ".ssh"));
      expect(path.resolve(path.join(targetHome, ".config"), linkedGh)).toBe(path.join(sourceHome, ".config", "gh"));
      expect(path.resolve(targetHome, linkedSsh)).toBe(path.join(sourceHome, ".ssh"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("repairs empty pre-existing credential directories into host symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-repair-"));
    const sourceHome = path.join(root, "host-home");
    const targetHome = path.join(root, "agent-home");
    const sourceGh = path.join(sourceHome, ".config", "gh");
    const targetGh = path.join(targetHome, ".config", "gh");
    await fs.mkdir(sourceGh, { recursive: true });
    await fs.writeFile(path.join(sourceGh, "hosts.yml"), "github.com:\n  oauth_token: redacted\n", "utf8");
    await fs.mkdir(targetGh, { recursive: true });

    try {
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome,
        targetHome,
        entries: [".config/gh"],
      });

      expect(result).toEqual({ linked: [".config/gh"], skipped: [] });
      const linkedGh = await fs.readlink(targetGh);
      expect(path.resolve(path.dirname(targetGh), linkedGh)).toBe(sourceGh);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace non-empty credential directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-non-empty-"));
    const sourceHome = path.join(root, "host-home");
    const targetHome = path.join(root, "agent-home");
    const sourceGh = path.join(sourceHome, ".config", "gh");
    const targetGh = path.join(targetHome, ".config", "gh");
    await fs.mkdir(sourceGh, { recursive: true });
    await fs.writeFile(path.join(sourceGh, "hosts.yml"), "github.com:\n  oauth_token: redacted\n", "utf8");
    await fs.mkdir(targetGh, { recursive: true });
    await fs.writeFile(path.join(targetGh, "hosts.yml"), "stale-but-user-owned\n", "utf8");

    try {
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome,
        targetHome,
        entries: [".config/gh"],
      });

      expect(result).toEqual({ linked: [], skipped: [".config/gh"] });
      await expect(fs.readFile(path.join(targetGh, "hosts.yml"), "utf8")).resolves.toBe("stale-but-user-owned\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureLocalCliCredentialShimsInPath", () => {
  it("does not shim default commands when managed HOME credentials work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-shims-managed-"));
    const operatorHome = path.join(root, "operator-home");
    const targetHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const fakeVercel = path.join(binDir, "vercel");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.join(operatorHome, ".config", "vercel"), { recursive: true });
    await fs.mkdir(path.join(targetHome, ".config", "vercel"), { recursive: true });
    await fs.writeFile(path.join(targetHome, ".config", "vercel", "auth.json"), "{}\n", "utf8");
    await fs.writeFile(
      fakeVercel,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"whoami\" ] && [ -f \"$HOME/.config/vercel/auth.json\" ]; then exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeVercel, 0o755);

    try {
      const env = await ensureLocalCliCredentialShimsInPath({
        operatorHome,
        targetHome,
        env: {
          HOME: targetHome,
          PATH: binDir,
        },
      });

      expect(env.HOME).toBe(targetHome);
      expect(env.PATH?.split(":")[0]).toBe(binDir);
      await expect(fs.lstat(path.join(targetHome, ".rudder", "local-cli-shims", "vercel"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs selected host CLI commands with operator HOME when managed HOME auth fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-shims-"));
    const operatorHome = path.join(root, "operator-home");
    const targetHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const capturePath = path.join(root, "capture.json");
    const fakeGh = path.join(binDir, "gh");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(operatorHome, { recursive: true });
    await fs.mkdir(targetHome, { recursive: true });
    await fs.writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
        "  test -f \"$HOME/auth-ok\"",
        "  exit $?",
        "fi",
        `printf '{"home":"%s","userProfile":"%s"}\\n' "$HOME" "$USERPROFILE" > ${JSON.stringify(capturePath)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeGh, 0o755);
    await fs.writeFile(path.join(operatorHome, "auth-ok"), "yes\n", "utf8");

    try {
      const env = await ensureLocalCliCredentialShimsInPath({
        operatorHome,
        targetHome,
        env: {
          HOME: targetHome,
          PATH: binDir,
        },
        commands: [{ command: "gh", authCheckArgs: ["auth", "status"] }],
      });

      expect(env.HOME).toBe(targetHome);
      expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(targetHome, ".rudder", "local-cli-shims"));

      await new Promise<void>((resolve, reject) => {
        const child = spawn("gh", [], { env });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`gh shim exited ${code}`));
        });
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string;
        userProfile: string;
      };
      expect(capture.home).toBe(operatorHome);
      expect(capture.userProfile).toBe(operatorHome);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("shims commands when bridged credential files exist but managed HOME auth still fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-shims-bridged-auth-fail-"));
    const operatorHome = path.join(root, "operator-home");
    const targetHome = path.join(root, "agent-home");
    const operatorGh = path.join(operatorHome, ".config", "gh");
    const targetGh = path.join(targetHome, ".config", "gh");
    const binDir = path.join(root, "bin");
    const capturePath = path.join(root, "capture.json");
    const fakeGh = path.join(binDir, "gh");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(operatorGh, { recursive: true });
    await fs.mkdir(path.dirname(targetGh), { recursive: true });
    await fs.writeFile(path.join(operatorGh, "hosts.yml"), "github.com:\n  oauth_token: keyring-backed\n", "utf8");
    await fs.symlink(operatorGh, targetGh);
    await fs.writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
        `  test "$HOME" = ${JSON.stringify(operatorHome)}`,
        "  exit $?",
        "fi",
        `printf '{"home":"%s","userProfile":"%s"}\\n' "$HOME" "$USERPROFILE" > ${JSON.stringify(capturePath)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeGh, 0o755);

    try {
      expect(await fs.realpath(targetGh)).toBe(await fs.realpath(operatorGh));

      const env = await ensureLocalCliCredentialShimsInPath({
        operatorHome,
        targetHome,
        env: {
          HOME: targetHome,
          PATH: binDir,
        },
        commands: [{
          command: "gh",
          authCheckArgs: ["auth", "status"],
          credentialEntries: [".config/gh"],
        }],
      });

      expect(env.HOME).toBe(targetHome);
      expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(targetHome, ".rudder", "local-cli-shims"));

      await new Promise<void>((resolve, reject) => {
        const child = spawn("gh", [], { env });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`gh shim exited ${code}`));
        });
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string;
        userProfile: string;
      };
      expect(capture.home).toBe(operatorHome);
      expect(capture.userProfile).toBe(operatorHome);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
