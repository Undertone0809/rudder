import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { resolveClaudeSessionFilePath, type ClaudeDeferredForkIntent } from "./native-capabilities.js";

const orgId = "claude-fork-test-org";
const sourceSessionId = "source-session-1";
const prompt = "Inspect this branch and continue from the selected answer.";

function fakeClaudeCliScript(reportedSessionId: string | null): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const reportedSessionId = ${JSON.stringify(reportedSessionId)};
const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const capture = { argv: process.argv.slice(2), prompts: [] };
const writeCapture = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
const writeEvent = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
writeCapture();
writeEvent({ type: "system", subtype: "init", ...(reportedSessionId ? { session_id: reportedSessionId } : {}) });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message?.type !== "user") return;
  const text = message.message?.content?.filter((item) => item?.type === "text").map((item) => item.text).join("\\n") ?? "";
  capture.prompts.push(text);
  writeCapture();
  const identity = reportedSessionId ? { session_id: reportedSessionId } : {};
  writeEvent({ type: "user", isReplay: true, uuid: message.uuid, ...identity });
  if (process.env.RUDDER_TEST_UNKNOWN_SESSION === "1") {
    process.exitCode = 1;
    writeEvent({
      type: "result",
      uuid: "fork-error-result",
      subtype: "error",
      result: "No conversation found with session id source-session-1",
    });
    return;
  }
  writeEvent({
    type: "assistant",
    uuid: "child-assistant-1",
    ...identity,
    message: { content: [{ type: "text", text: "Forked reply." }] },
  });
  writeEvent({
    type: "result",
    uuid: "child-result-1",
    ...identity,
    subtype: "success",
    result: "Forked reply.",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
});
`;
}

async function runDeferredFork(reportedSessionId: string | null, unknownSession = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-deferred-fork-"));
  const cwd = path.join(root, "workspace");
  const command = path.join(root, "fake-claude");
  const capturePath = path.join(root, "capture.json");
  const rudderHome = path.join(root, ".rudder");
  const configDir = path.join(
    rudderHome,
    "instances",
    "default",
    "organizations",
    orgId,
    "claude-home",
    ".claude",
  );
  const sourceSessionPath = resolveClaudeSessionFilePath(configDir, cwd, sourceSessionId);
  const previousHome = process.env.HOME;
  const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.dirname(sourceSessionPath), { recursive: true });
  await fs.writeFile(command, fakeClaudeCliScript(reportedSessionId), "utf8");
  await fs.chmod(command, 0o755);
  await fs.writeFile(sourceSessionPath, [
    { type: "user", uuid: "source-user-1", sessionId: sourceSessionId },
    {
      type: "assistant",
      uuid: "source-assistant-1",
      parentUuid: "source-user-1",
      sessionId: sourceSessionId,
      message: { stop_reason: "end_turn", content: [{ type: "text", text: "Selected answer." }] },
    },
    { type: "result", uuid: "source-result-1", parentUuid: "source-assistant-1", sessionId: sourceSessionId },
  ].map((record) => JSON.stringify(record)).join("\n"), "utf8");
  process.env.HOME = root;
  process.env.RUDDER_OPERATOR_HOME = root;

  try {
    const intent: ClaudeDeferredForkIntent = {
      version: 1,
      kind: "claude_fork_on_first_input",
      sourceBindingId: "source-binding-1",
      sourceSession: {
        sessionId: sourceSessionId,
        sessionDisplayId: sourceSessionId,
        sessionParams: {
          sessionId: sourceSessionId,
          cwd,
          claudeConfigDir: configDir,
          sessionFilePath: sourceSessionPath,
          lastUuid: "source-result-1",
          profileHostId: "local",
          profileId: "default",
          profileBindingId: "source-binding-1",
          profileOrgId: orgId,
          transport: "claude_cli",
        },
      },
      sourceSelector: {
        kind: "claude_chain",
        sessionId: sourceSessionId,
        throughInclusiveUuid: "source-assistant-1",
      },
    };
    const result = await execute({
      runId: "claude-deferred-fork-test",
      agent: {
        id: "claude-fork-agent",
        orgId,
        name: "Claude Fork Test",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd,
        providerBindingId: "target-binding-1",
        providerOrgId: orgId,
        env: {
          RUDDER_HOME: rudderHome,
          RUDDER_TEST_CAPTURE_PATH: capturePath,
          ...(unknownSession ? { RUDDER_TEST_UNKNOWN_SESSION: "1" } : {}),
        },
        promptTemplate: "This synthetic template must not be sent.",
      },
      context: {
        chatMode: true,
        chatPrompt: prompt,
        rudderNativeForkIntent: intent,
      },
      onLog: async () => {},
    });
    const captureText = await fs.readFile(capturePath, "utf8").catch(() => {
      throw new Error(`Claude CLI was not invoked: ${JSON.stringify(result)}`);
    });
    const capture = JSON.parse(captureText) as {
      argv: string[];
      prompts: string[];
    };
    return { result, capture };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
    else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fakeContinuationCliScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const capturePath = process.env.RUDDER_TEST_CAPTURE_PATH;
const capture = fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : { calls: [] };
const callIndex = capture.calls.length + 1;
const call = { argv: process.argv.slice(2), prompt: null };
capture.calls.push(call);
const writeCapture = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
const writeEvent = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
writeCapture();
writeEvent({ type: "system", subtype: "init", session_id: "resume-session-1" });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message?.type !== "user") return;
  call.prompt = message.message?.content?.filter((item) => item?.type === "text").map((item) => item.text).join("\\n") ?? "";
  writeCapture();
  writeEvent({ type: "user", isReplay: true, uuid: "user-turn-" + callIndex, session_id: "resume-session-1" });
  writeEvent({
    type: "assistant",
    uuid: "assistant-turn-" + callIndex,
    session_id: "resume-session-1",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "Turn " + callIndex }] },
  });
  writeEvent({
    type: "result",
    uuid: "result-turn-" + callIndex,
    session_id: "resume-session-1",
    subtype: "success",
    result: "Turn " + callIndex,
  });
});
`;
}

async function runClaudeContinuations() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-continuation-"));
  const cwd = path.join(root, "workspace");
  const command = path.join(root, "fake-claude");
  const capturePath = path.join(root, "capture.json");
  const rudderHome = path.join(root, ".rudder");
  const previousHome = process.env.HOME;
  const previousOperatorHome = process.env.RUDDER_OPERATOR_HOME;
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(command, fakeContinuationCliScript(), "utf8");
  await fs.chmod(command, 0o755);
  process.env.HOME = root;
  process.env.RUDDER_OPERATOR_HOME = root;

  try {
    const config = {
      command,
      cwd,
      providerBindingId: "continuation-binding-1",
      providerOrgId: orgId,
      env: {
        RUDDER_HOME: rudderHome,
        RUDDER_TEST_CAPTURE_PATH: capturePath,
      },
    };
    const run = (runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null; sessionDisplayId: string | null; taskKey: string | null }, chatPrompt: string) => execute({
      runId: `claude-continuation-${chatPrompt}`,
      agent: {
        id: "claude-continuation-agent",
        orgId,
        name: "Claude Continuation Test",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      },
      runtime,
      config: { ...config, promptTemplate: chatPrompt },
      context: { chatMode: true, chatPrompt },
      onLog: async () => {},
    });
    const first = await run({ sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, "First prompt.");
    const second = await run({
      sessionId: first.sessionId ?? null,
      sessionParams: first.sessionParams ?? null,
      sessionDisplayId: first.sessionDisplayId ?? null,
      taskKey: null,
    }, "Second prompt.");
    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
      calls: Array<{ argv: string[]; prompt: string | null }>;
    };
    return { first, second, capture };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOperatorHome === undefined) delete process.env.RUDDER_OPERATOR_HOME;
    else process.env.RUDDER_OPERATOR_HOME = previousOperatorHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Claude deferred native fork", () => {
  it("submits the real first prompt with resume and fork flags, then returns the provider child", async () => {
    const childSessionId = "child-session-1";
    const { result, capture } = await runDeferredFork(childSessionId);

    expect(capture.argv).toContain("--fork-session");
    const resumeIndex = capture.argv.indexOf("--resume");
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(capture.argv[resumeIndex + 1]).toBe(sourceSessionId);
    expect(capture.prompts).toEqual([prompt]);
    expect(result).toMatchObject({
      exitCode: 0,
      submissionPhase: "accepted",
      sessionId: childSessionId,
      sessionParams: {
        sessionId: childSessionId,
        lastUuid: "child-result-1",
        lastAssistantUuid: "child-assistant-1",
      },
      resultJson: {
        fork: {
          status: "accepted",
          sourceAssistantUuid: "source-assistant-1",
          childSessionId,
        },
      },
    });
  });

  it("does not return the source as a child when the CLI omits its child session ID", async () => {
    const { result, capture } = await runDeferredFork(null);

    expect(capture.prompts).toEqual([prompt]);
    expect(result).toMatchObject({
      submissionPhase: "indeterminate",
      errorCode: "claude_fork_acceptance_unknown",
      sessionId: null,
      sessionParams: null,
      resultJson: {
        fork: {
          status: "unknown",
          sourceSessionId,
          childSessionId: null,
        },
      },
    });
  });

  it("keeps an unknown provider resume result indeterminate after the prompt was submitted", async () => {
    const { result, capture } = await runDeferredFork(null, true);

    expect(capture.prompts).toEqual([prompt]);
    expect(result).toMatchObject({
      submissionPhase: "indeterminate",
      errorCode: "claude_fork_acceptance_unknown",
      sessionId: null,
      sessionParams: null,
      resultJson: {
        fork: {
          status: "unknown",
          sourceSessionId,
          childSessionId: null,
          reason: "provider_unknown_session",
        },
        submissionPhase: "indeterminate",
      },
    });
  });
});

describe("Claude native Run continuation boundary", () => {
  it("resumes the explicit session and advances from the prior assistant UUID, not its result marker", async () => {
    const { first, second, capture } = await runClaudeContinuations();

    expect(capture.calls).toHaveLength(2);
    expect(capture.calls.map((call) => call.prompt)).toEqual(["First prompt.", "Second prompt."]);
    expect(first.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(second.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    const resumeIndex = capture.calls[1]!.argv.indexOf("--resume");
    expect(capture.calls[1]!.argv[resumeIndex + 1]).toBe("resume-session-1");
    expect(first.sessionParams).toMatchObject({
      lastUuid: "result-turn-1",
      lastAssistantUuid: "assistant-turn-1",
    });
    expect(second.resultJson).toMatchObject({
      startExclusiveUuid: "assistant-turn-1",
      transcriptBoundary: {
        status: "bounded",
        startExclusiveUuid: "assistant-turn-1",
      },
    });
    expect(second.sessionParams).toMatchObject({
      lastUuid: "result-turn-2",
      lastAssistantUuid: "assistant-turn-2",
    });
  });
});
