import { chatConversations, chatMessages, heartbeatRunEvents, heartbeatRuns, nativeSegments, runRuntimeSpans, runtimeBindings } from "@rudderhq/db";
import { readOpenCodeNativeTranscript } from "@rudderhq/agent-runtime-opencode-local/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptReader } from "./transcript-reader.js";

const directories: string[] = [];

function persistedDatabase(rows: { run: Record<string, unknown>; span: Record<string, unknown>; binding: Record<string, unknown>; segment: Record<string, unknown> }) {
  const tables = new Map<unknown, Record<string, unknown>[]>([
    [heartbeatRuns, [rows.run]], [runRuntimeSpans, [rows.span]],
    [runtimeBindings, [rows.binding]], [nativeSegments, [rows.segment]],
    [chatConversations, []], [chatMessages, []], [heartbeatRunEvents, []],
  ]);
  return {
    select: () => {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        where() { return query; },
        orderBy() { return query; },
        innerJoin() { return query; },
        limit() { return query; },
        then(resolve: (value: Record<string, unknown>[]) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve(tables.get(table) ?? []).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("OpenCode partial Run through restarted unified Reader", () => {
  it("returns only observed R1 entries after old config deletion, never the unobserved tail or R2", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-reader-restart-"));
    directories.push(directory);
    const command = path.join(directory, "opencode-fixture.mjs");
    const exportPath = path.join(directory, "export.json");
    await fs.writeFile(command, `#!/usr/bin/env node\nimport fs from "node:fs";\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(exportPath)}, "utf8"));\n`, { mode: 0o755 });
    await fs.writeFile(exportPath, JSON.stringify({
      info: { id: "session-1" },
      messages: [
        { info: { id: "user-r1", role: "user", sessionID: "session-1" }, parts: [{ type: "text", text: "R1 input" }] },
        { info: { id: "assistant-r1", role: "assistant", parentID: "user-r1", sessionID: "session-1" }, parts: [{ type: "text", text: "observed R1" }] },
        { info: { id: "assistant-tail", role: "assistant", parentID: "assistant-r1", sessionID: "session-1" }, parts: [{ type: "text", text: "unobserved tail" }] },
        { info: { id: "user-r2", role: "user", parentID: "assistant-tail", sessionID: "session-1" }, parts: [{ type: "text", text: "R2 input" }] },
        { info: { id: "assistant-r2", role: "assistant", parentID: "user-r2", sessionID: "session-1" }, parts: [{ type: "text", text: "R2 output" }] },
      ],
    }));
    const managedHome = path.join(directory, "managed-home");
    const oldConfig = path.join(managedHome, "runtime-tmp", randomUUID(), "opencode.json");
    const exportEnv = {
      HOME: directory, XDG_CONFIG_HOME: path.join(managedHome, ".config"),
      XDG_DATA_HOME: path.join(managedHome, ".local", "share"),
      XDG_CACHE_HOME: path.join(managedHome, ".cache"), OPENCODE_CONFIG: oldConfig,
    };
    await fs.mkdir(path.dirname(oldConfig), { recursive: true });
    await fs.writeFile(oldConfig, "{}");
    const session = {
      sessionId: "session-1", sessionDisplayId: "session-1",
      sessionParams: {
        sessionId: "session-1", cwd: directory, serverUrl: "http://127.0.0.1:19281",
        serverCommand: command, exportCommand: command, exportEnv,
        transport: "opencode-managed-server-http", hostId: "local", profileId: "profile-1",
        profileBindingId: "profile-binding-1", profileOrgId: "org-1",
      },
    };
    const selector = {
      kind: "opencode_input", sessionId: "session-1", userMessageId: "user-r1",
      terminalMessageIds: [], observedAssistantMessageIds: ["assistant-r1"], completeness: "partial",
    };
    const timestamp = new Date("2026-09-24T00:00:00.000Z");
    const rows = {
      run: { id: "run-r1", orgId: "org-1", chatConversationId: null, startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, resultJson: null, contextSnapshot: null },
      span: { id: "span-r1", runId: "run-r1", bindingId: "binding-r1", segmentId: "segment-r1", ordinal: 0, selectorJson: selector, state: "sealed", completeness: "partial", visibilityCutoffRef: null, supplementalObjectRef: null, updatedAt: timestamp },
      binding: { id: "binding-r1", orgId: "org-1", conversationId: null, principalScopeRef: "user:user-1", runtimeType: "opencode_local", continuity: "native" },
      segment: { id: "segment-r1", orgId: "org-1", bindingId: "binding-r1", runtimeType: "opencode_local", nativeSessionId: "session-1" },
    };
    await fs.rm(oldConfig);
    const newReader = () => createTranscriptReader(persistedDatabase(rows) as never, {
      nativeReader: { readRange: async (input) => readOpenCodeNativeTranscript({
        runtimeType: "opencode_local", session, selector: input.selector,
        binding: { id: "profile-binding-1", orgId: "org-1", hostId: "local", profileId: "profile-1" },
        range: input.range, signal: input.signal,
      }) },
    });
    const page = await newReader().readRun({
      orgId: "org-1", runId: "run-r1", principal: { type: "board", orgId: "org-1", authorized: true },
    });
    expect(page).toMatchObject({ availability: "available", completeness: "partial", source: "native" });
    expect(page.items.map((item) => item.sourceEntryId)).toEqual(["user-r1", "assistant-r1"]);
    expect(page.items.map((item) => item.text)).toEqual(["R1 input", "observed R1"]);
    expect((await newReader().readRun({
      orgId: "org-1", runId: "run-r1", principal: { type: "board", orgId: "org-1", authorized: true },
    })).items.map((item) => item.sourceEntryId)).toEqual(["user-r1", "assistant-r1"]);
  });
});
