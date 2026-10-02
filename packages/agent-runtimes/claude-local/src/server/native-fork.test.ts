import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateClaudeResumeSession } from "./execute.js";
import {
  createClaudeLocalProviderCapabilities,
  parseClaudeSessionJsonl,
  resolveClaudeSessionFilePath,
  type ClaudeLocalProfileTransport,
  type ClaudeProviderBindingRef,
  type ClaudeProviderSessionRef,
} from "./native-capabilities.js";

const spawnControl = vi.hoisted(() => ({
  implementation: null as ((args: unknown[]) => unknown) | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    if (spawnControl.implementation) return spawnControl.implementation(args as unknown[]);
    return actual.spawn(...args);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const binding: ClaudeProviderBindingRef = {
  id: "binding-claude-fork-1",
  orgId: "org-claude-fork-1",
  hostId: "host-claude-fork-1",
  profileId: "profile-claude-fork-1",
  capabilityRevision: "claude-agent-sdk-0.3.216",
};
const sessionId = "1c68e7f1-929c-4a29-98b0-d0f36ec80401";
const userOne = "31344594-8471-46b8-a4ab-74ecf755fa01";
const assistantOne = "31344594-8471-46b8-a4ab-74ecf755fa02";
const userTwo = "31344594-8471-46b8-a4ab-74ecf755fa03";
const assistantTwo = "31344594-8471-46b8-a4ab-74ecf755fa04";
const userThree = "31344594-8471-46b8-a4ab-74ecf755fa05";
const assistantThree = "31344594-8471-46b8-a4ab-74ecf755fa06";
const userFour = "31344594-8471-46b8-a4ab-74ecf755fa07";
const partialAssistant = "31344594-8471-46b8-a4ab-74ecf755fa08";
const orphanSessionId = "1c68e7f1-929c-4a29-98b0-d0f36ec80402";
const orphanMessageId = "31344594-8471-46b8-a4ab-74ecf755fa09";

const fixtureRoots: string[] = [];

function sourceRecords(): Record<string, unknown>[] {
  return [
    {
      type: "user",
      uuid: userOne,
      sessionId,
      timestamp: "2026-09-28T08:00:00.000Z",
      message: { role: "user", content: "First prompt." },
    },
    {
      type: "assistant",
      uuid: assistantOne,
      parentUuid: userOne,
      sessionId,
      timestamp: "2026-09-28T08:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
    },
    {
      type: "user",
      uuid: userTwo,
      parentUuid: assistantOne,
      sessionId,
      timestamp: "2026-09-28T08:01:00.000Z",
      message: { role: "user", content: "Second prompt." },
    },
    {
      type: "assistant",
      uuid: assistantTwo,
      parentUuid: userTwo,
      sessionId,
      timestamp: "2026-09-28T08:01:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Selected answer." }], stop_reason: "end_turn" },
    },
    {
      type: "user",
      uuid: userThree,
      parentUuid: assistantTwo,
      sessionId,
      timestamp: "2026-09-28T08:02:00.000Z",
      message: { role: "user", content: "Later prompt must not be copied." },
    },
    {
      type: "assistant",
      uuid: assistantThree,
      parentUuid: userThree,
      sessionId,
      timestamp: "2026-09-28T08:02:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Later answer must not be copied." }], stop_reason: "end_turn" },
    },
    {
      type: "user",
      uuid: userFour,
      parentUuid: assistantThree,
      sessionId,
      timestamp: "2026-09-28T08:03:00.000Z",
      message: { role: "user", content: "An in-flight prompt." },
    },
    {
      type: "assistant",
      uuid: partialAssistant,
      parentUuid: userFour,
      sessionId,
      timestamp: "2026-09-28T08:03:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Partial answer." }] },
    },
  ];
}

async function makeFixture(records = sourceRecords()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-native-fork-test-"));
  fixtureRoots.push(root);
  const cwd = path.join(root, "workspace");
  const configDir = path.join(root, "authorized-claude-profile");
  const cliCalledPath = path.join(root, "cli-was-called");
  const poisonCli = path.join(root, "poison-claude");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  const canonicalCwd = await fs.realpath(cwd);
  await fs.writeFile(poisonCli, `#!/bin/sh\nprintf called > '${cliCalledPath}'\nexit 91\n`);
  await fs.chmod(poisonCli, 0o755);

  const profile: ClaudeLocalProfileTransport = {
    binding,
    command: poisonCli,
    cwd: canonicalCwd,
    configDir,
    providerVersion: "2.1.216",
  };
  const session: ClaudeProviderSessionRef = {
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: {
      sessionId,
      cwd: canonicalCwd,
      claudeConfigDir: configDir,
      sessionFilePath: resolveClaudeSessionFilePath(configDir, canonicalCwd, sessionId),
      profileHostId: binding.hostId,
      profileId: binding.profileId,
      profileBindingId: binding.id,
      profileOrgId: binding.orgId,
      capabilityRevision: binding.capabilityRevision,
      transport: "claude-cli-jsonl",
    },
  };
  const parentPath = resolveClaudeSessionFilePath(configDir, canonicalCwd, sessionId);
  await fs.mkdir(path.dirname(parentPath), { recursive: true });
  const parentBytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await fs.writeFile(parentPath, parentBytes);
  return { root, cwd: canonicalCwd, configDir, profile, session, parentPath, parentBytes, cliCalledPath };
}

function mockForkWorkerThatLeavesUnreportedChild() {
  let temporaryHome: string | null = null;
  let spawnCalls = 0;
  spawnControl.implementation = (args) => {
    spawnCalls += 1;
    const options = args[2] as { cwd: string; env: Record<string, string> };
    temporaryHome = options.env.HOME;
    if (temporaryHome) fixtureRoots.push(temporaryHome);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        input += chunk.toString();
        callback();
      },
      final(callback) {
        const request = JSON.parse(input) as { sessionId: string };
        const childPath = resolveClaudeSessionFilePath(options.env.CLAUDE_CONFIG_DIR!, options.cwd, orphanSessionId);
        void fs.mkdir(path.dirname(childPath), { recursive: true })
          .then(() => fs.writeFile(childPath, `${JSON.stringify({
            type: "user",
            uuid: orphanMessageId,
            sessionId: orphanSessionId,
            forkedFrom: { sessionId: request.sessionId, messageUuid: userOne },
          })}\n`))
          .then(() => {
            callback();
            child.stderr.end("simulated worker failure after writing child without returning its ID");
            child.stdout.end();
            child.emit("close", 1);
          })
          .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            callback(failure);
            child.emit("error", failure);
          });
      },
    });
    return child as unknown;
  };
  return { spawnCalls: () => spawnCalls, temporaryHome: () => temporaryHome };
}

afterEach(async () => {
  spawnControl.implementation = null;
  vi.restoreAllMocks();
  await Promise.all(fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Claude exact assistant-boundary native fork", () => {
  it("forks an exact historical chain from legacy alias metadata in the same canonical profile", async () => {
    const fixture = await makeFixture();
    const alias = path.join(fixture.root, "workspace-alias");
    await fs.symlink(fixture.cwd, alias, "dir");
    const legacyPath = path.join(fixture.configDir, "projects", path.resolve(alias).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
    const session = { ...fixture.session, sessionParams: { ...fixture.session.sessionParams, cwd: alias, sessionFilePath: legacyPath } };
    const snapshot = structuredClone(session);
    const result = await createClaudeLocalProviderCapabilities({ ...fixture.profile, cwd: alias }).fork.fork({
      runtimeType: "claude_local", session, binding, boundary: assistantTwo,
      selector: { kind: "claude_chain", sessionId, throughInclusiveUuid: assistantTwo, boundaryStatus: "exact" },
    });
    expect(result.continuity).toBe("native");
    const resumeInput = {
      sessionId: result.session.sessionId,
      sessionParams: result.session.sessionParams,
      cwd: alias,
      configDir: fixture.configDir,
      profile: {
        hostId: binding.hostId, profileId: binding.profileId,
        profileBindingId: binding.id, profileOrgId: binding.orgId,
        capabilityRevision: binding.capabilityRevision,
      },
    };
    expect(validateClaudeResumeSession(resumeInput)).toBeNull();
    expect(validateClaudeResumeSession({ ...resumeInput, cwd: fixture.root })).not.toBeNull();
    expect(validateClaudeResumeSession({ ...resumeInput, configDir: fixture.root })).not.toBeNull();
    expect(validateClaudeResumeSession({ ...resumeInput, profile: { ...resumeInput.profile, profileId: "other-profile" } })).not.toBeNull();
    expect(Object.keys(result.identityMap)).toEqual([userOne, assistantOne, userTwo, assistantTwo]);
    const child = await fs.readFile(resolveClaudeSessionFilePath(fixture.configDir, fixture.cwd, result.session.sessionId), "utf8");
    expect(child).not.toContain(userThree);
    expect(child).not.toContain(assistantThree);
    expect(await fs.readFile(fixture.parentPath)).toEqual(fixture.parentBytes);
    expect(session).toEqual(snapshot);
  });

  it("copies exactly through the completed assistant, remaps identities, and leaves the authorized parent unchanged", async () => {
    const fixture = await makeFixture();
    const adapter = createClaudeLocalProviderCapabilities(fixture.profile);

    const result = await adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary: assistantTwo,
      selector: {
        kind: "claude_chain",
        sessionId,
        throughInclusiveUuid: assistantTwo,
        boundaryStatus: "exact",
      },
    });

    expect(result).toMatchObject({
      sourceBoundary: assistantTwo,
      continuity: "native",
      session: {
        sessionParams: {
          transport: "claude_cli",
          forkTransport: "claude-agent-sdk-0.3.216",
          forkedFromSessionId: sessionId,
          lastAssistantUuid: result.boundary,
        },
      },
    });
    expect(result.session.sessionId).not.toBe(sessionId);
    expect(validateClaudeResumeSession({
      sessionId: result.session.sessionId,
      sessionParams: result.session.sessionParams,
      cwd: fixture.cwd,
      configDir: fixture.configDir,
      profile: {
        hostId: binding.hostId,
        profileId: binding.profileId,
        profileBindingId: binding.id,
        profileOrgId: binding.orgId,
        capabilityRevision: binding.capabilityRevision,
      },
    })).toBeNull();
    expect(result.boundary).toBe(result.identityMap[assistantTwo]);
    expect(Object.keys(result.identityMap)).toEqual([userOne, assistantOne, userTwo, assistantTwo]);
    expect(Object.values(result.identityMap)).not.toContain(assistantTwo);

    const childPath = resolveClaudeSessionFilePath(fixture.configDir, fixture.cwd, result.session.sessionId);
    const childRaw = await fs.readFile(childPath, "utf8");
    const child = parseClaudeSessionJsonl(childRaw);
    expect(child.malformed).toBe(false);
    const transcript = child.records.filter(({ record }) => ["user", "assistant"].includes(String(record.type)));
    expect(transcript.map(({ record }) => record.forkedFrom && (record.forkedFrom as Record<string, unknown>).messageUuid))
      .toEqual([userOne, assistantOne, userTwo, assistantTwo]);
    expect(transcript.map(({ record }) => record.uuid)).toEqual([
      result.identityMap[userOne],
      result.identityMap[assistantOne],
      result.identityMap[userTwo],
      result.identityMap[assistantTwo],
    ]);
    expect(transcript.at(-1)?.record.message).toMatchObject({
      content: [{ type: "text", text: "Selected answer." }],
      stop_reason: "end_turn",
    });
    expect(childRaw).not.toContain(userThree);
    expect(childRaw).not.toContain(assistantThree);
    expect(childRaw).not.toContain(userFour);
    expect(childRaw).not.toContain(partialAssistant);
    expect(await fs.readFile(fixture.parentPath)).toEqual(fixture.parentBytes);
    await expect(fs.access(fixture.cliCalledPath)).rejects.toThrow();
  });

  it("fails closed when a same-session content replacement follows the selected assistant boundary", async () => {
    const records = sourceRecords();
    records.splice(4, 0, {
      type: "content-replacement",
      uuid: "31344594-8471-46b8-a4ab-74ecf755fa10",
      sessionId,
      replacements: [{ uuid: assistantOne, content: [{ type: "text", text: "replacement after boundary" }] }],
    });
    const fixture = await makeFixture(records);
    const adapter = createClaudeLocalProviderCapabilities(fixture.profile);
    const beforeFiles = await fs.readdir(path.dirname(fixture.parentPath));

    await expect(adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary: assistantTwo,
      selector: { kind: "claude_chain", sessionId, throughInclusiveUuid: assistantTwo, boundaryStatus: "exact" },
    })).rejects.toThrow("content-replacement record after the selected assistant boundary");

    expect(await fs.readdir(path.dirname(fixture.parentPath))).toEqual(beforeFiles);
    expect(await fs.readFile(fixture.parentPath)).toEqual(fixture.parentBytes);
  });

  it("removes a staged child when the SDK worker fails before returning its session ID", async () => {
    const fixture = await makeFixture();
    const worker = mockForkWorkerThatLeavesUnreportedChild();
    const adapter = createClaudeLocalProviderCapabilities(fixture.profile);

    await expect(adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary: assistantTwo,
    })).rejects.toThrow("simulated worker failure after writing child");

    expect(worker.spawnCalls()).toBe(1);
    expect(worker.temporaryHome()).not.toBeNull();
    await expect(fs.access(worker.temporaryHome()!)).rejects.toThrow();
    expect(await fs.readFile(fixture.parentPath)).toEqual(fixture.parentBytes);
    expect(await fs.readdir(path.dirname(fixture.parentPath))).toEqual([path.basename(fixture.parentPath)]);
  });

  it("reports the staging path when cleanup fails after an unidentified child was written", async () => {
    const fixture = await makeFixture();
    const worker = mockForkWorkerThatLeavesUnreportedChild();
    const adapter = createClaudeLocalProviderCapabilities(fixture.profile);
    const remove = fs.rm.bind(fs);
    const cleanupSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (worker.temporaryHome() && path.resolve(String(target)) === path.resolve(worker.temporaryHome()!)) {
        throw new Error("simulated staging cleanup denial");
      }
      return remove(target, options);
    });

    const failure = await adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary: assistantTwo,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain(`staging cleanup failed at ${worker.temporaryHome()}`);
    expect(message).toContain("Inspect or reconcile files under");
    const orphanPath = resolveClaudeSessionFilePath(
      path.join(worker.temporaryHome()!, "claude-profile"),
      fixture.cwd,
      orphanSessionId,
    );
    expect(message).toContain(orphanPath);
    expect(cleanupSpy).toHaveBeenCalledWith(worker.temporaryHome(), { recursive: true, force: true });
    expect(worker.temporaryHome()).not.toBeNull();
    await expect(fs.readFile(orphanPath, "utf8")).resolves.toContain(orphanMessageId);
  });

  it.each([
    { name: "a missing UUID", boundary: "31344594-8471-46b8-a4ab-74ecf755fa09" },
    { name: "a user message", boundary: userTwo },
    { name: "an incomplete assistant message", boundary: partialAssistant },
  ])("rejects $name before creating a child session", async ({ boundary }) => {
    const fixture = await makeFixture();
    const adapter = createClaudeLocalProviderCapabilities(fixture.profile);
    const beforeFiles = await fs.readdir(path.dirname(fixture.parentPath));

    await expect(adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary,
      selector: { kind: "claude_chain", sessionId, throughInclusiveUuid: boundary, boundaryStatus: "exact" },
    })).rejects.toThrow();

    expect(await fs.readdir(path.dirname(fixture.parentPath))).toEqual(beforeFiles);
    expect(await fs.readFile(fixture.parentPath)).toEqual(fixture.parentBytes);
    await expect(fs.access(fixture.cliCalledPath)).rejects.toThrow();
  });

  it("rejects mismatched host binding, selector, and CLI version without touching profile files", async () => {
    const fixture = await makeFixture();
    const beforeFiles = await fs.readdir(path.dirname(fixture.parentPath));
    const adapter = createClaudeLocalProviderCapabilities(fixture.profile);

    await expect(adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding: { ...binding, hostId: "different-host" },
      boundary: assistantTwo,
    })).rejects.toThrow("host-authorized profile binding");
    await expect(adapter.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary: assistantTwo,
      selector: { kind: "claude_chain", sessionId, throughInclusiveUuid: assistantThree },
    })).rejects.toThrow("does not match the persisted Run selector");

    const mismatched = createClaudeLocalProviderCapabilities({ ...fixture.profile, providerVersion: "2.1.217" });
    await expect(mismatched.fork.fork({
      runtimeType: "claude_local",
      session: fixture.session,
      binding,
      boundary: assistantTwo,
    })).rejects.toThrow("verified only for Claude Code 2.1.216");

    expect(await fs.readdir(path.dirname(fixture.parentPath))).toEqual(beforeFiles);
    expect(await fs.readFile(fixture.parentPath)).toEqual(fixture.parentBytes);
    await expect(fs.access(fixture.cliCalledPath)).rejects.toThrow();
  });
});
