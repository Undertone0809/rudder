import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HERMES_PRODUCT_HISTORY_HELPER_VERSION,
  readHermesProductHistory,
  readHermesProductHistoryExecutionSpan,
  type HermesProductHistoryProfile
} from "./product-history.js";

const FAKE_SESSION_DB = String.raw`
import json
from pathlib import Path
from contextlib import contextmanager

class SessionDB:
    def __init__(self, db_path=None, read_only=False):
        if not read_only:
            raise AssertionError("history helper must open SessionDB read-only")
        self.state = json.loads(Path(db_path).read_text(encoding="utf-8"))

    def _read_ctx(self):
        import sqlite3
        @contextmanager
        def context():
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            sessions = list(self.state.get("sessions", {}).values())
            messages = [row for rows in self.state.get("messages", {}).values() for row in rows]
            for table, rows, required in [
                ("sessions", sessions, ["id","source","parent_session_id","profile_name","cwd","started_at","ended_at","end_reason","message_count","tool_call_count"]),
                ("messages", messages, ["id","session_id","role","content"])]:
                columns = list(dict.fromkeys(required + [key for row in rows for key in row]))
                conn.execute("CREATE TABLE " + table + " (" + ",".join('"' + col + '"' for col in columns) + ")")
                for row in rows:
                    values = [json.dumps(row.get(col), ensure_ascii=False) if isinstance(row.get(col), (dict,list)) else row.get(col) for col in columns]
                    conn.execute("INSERT INTO " + table + " VALUES (" + ",".join("?" for _ in columns) + ")", values)
            conn.commit()
            try:
                yield conn
            finally:
                conn.close()
        return context()

    def _row_to_message_dict(self, row, **kwargs):
        result = dict(row)
        for key in ["content", "tool_calls", "display_metadata"]:
            if isinstance(result.get(key), str):
                try:
                    result[key] = json.loads(result[key])
                except ValueError:
                    pass
        return result

    def get_session(self, session_id):
        return self.state.get("sessions", {}).get(session_id)

    def get_messages(self, session_id, include_inactive=False, include_compacted=False,
                     limit=None, offset=0, latest=False, after_id=None):
        if include_compacted:
            raise AssertionError("after_id pagination must not use include_compacted")
        rows = list(self.state.get("messages", {}).get(session_id, []))
        if not include_inactive:
            rows = [row for row in rows if row.get("active", 1) == 1]
        if after_id is not None:
            rows = [row for row in rows if row["id"] > after_id]
        if latest:
            rows = list(reversed(rows))
        if limit is not None:
            rows = rows[:limit]
        if latest:
            rows = list(reversed(rows))
        return rows

    def get_compression_tip(self, session_id):
        return self.state.get("tips", {}).get(session_id, session_id)

    def resolve_resume_session_id(self, session_id):
        return self.state.get("resume", {}).get(session_id, session_id)

    def close(self):
        return None
`;

const pythonCommand = (() => {
  try {
    return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const cleanupRoots: string[] = [];

function profile(root: string, profileId = "profile-hermes-test"): HermesProductHistoryProfile {
  if (!pythonCommand) throw new Error("python3 is unavailable for the helper fixture");
  return {
    pythonCommand,
    sourcePath: path.join(root, "source"),
    hermesHome: path.join(root, "home"),
    providerVersion: "0.21.0",
    hostId: "host-hermes-test",
    profileId,
  };
}

async function fixture(): Promise<{ root: string; profile: HermesProductHistoryProfile; sessionId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-product-history-"));
  cleanupRoots.push(root);
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  await fs.mkdir(source);
  await fs.mkdir(home);
  await fs.writeFile(path.join(source, "hermes_state.py"), FAKE_SESSION_DB, "utf8");
  await fs.writeFile(path.join(home, "state.db"), JSON.stringify({
    sessions: {
      "session-old": {
        id: "session-old",
        source: "acp",
        parent_session_id: null,
        profile_name: "profile-hermes-test",
        cwd: "/workspace/hermes",
        started_at: 100,
        ended_at: 200,
        end_reason: "compression",
        message_count: 4,
        tool_call_count: 1,
      },
      "session-tip": {
        id: "session-tip",
        source: "acp",
        parent_session_id: "session-old",
        profile_name: "profile-hermes-test",
        cwd: "/workspace/hermes",
        started_at: 201,
        ended_at: null,
        end_reason: null,
        message_count: 1,
        tool_call_count: 0,
      },
      "session-other": {
        id: "session-other",
        source: "acp",
        parent_session_id: null,
        profile_name: "profile-hermes-test",
        cwd: "/workspace/other",
        started_at: 300,
        ended_at: null,
        end_reason: null,
        message_count: 1,
        tool_call_count: 0,
      },
    },
    messages: {
      "session-old": [
        { id: 1, session_id: "session-old", role: "user", content: "第一轮 🐕", timestamp: 101, active: 1, compacted: 0 },
        {
          id: 2,
          session_id: "session-old",
          role: "assistant",
          content: "调用工具：中文输出",
          tool_call_id: "call-1",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "读取", arguments: '{"文字":"你好🐕"}' } }],
          tool_name: "读取",
          timestamp: 102,
          active: 1,
          compacted: 0,
        },
        { id: 3, session_id: "session-old", role: "assistant", content: "压缩前保留记录", timestamp: 103, active: 0, compacted: 1, _compressed_summary: true },
        { id: 4, session_id: "session-old", role: "tool", content: "tail", timestamp: 104, active: 1, compacted: 0 },
      ],
      "session-tip": [
        { id: 5, session_id: "session-tip", role: "user", content: "tip only", timestamp: 202, active: 1, compacted: 0 },
      ],
      "session-other": [
        { id: 6, session_id: "session-other", role: "user", content: "other", timestamp: 301, active: 1, compacted: 0 },
      ],
    },
    tips: { "session-old": "session-tip" },
    resume: { "session-old": "session-tip" },
  }), "utf8");
  return { root, profile: profile(root), sessionId: "session-old" };
}

function executionProof(
  sessionId: string,
  range: { startExclusive: number | null; endInclusive: number },
  freshSessionVerified = false,
) {
  return {
    version: 1 as const,
    orgId: "org-history-test",
    runId: "run-history-test",
    spanId: "span-history-test",
    bindingId: "binding-history-test",
    segmentId: "segment-history-test",
    sessionId,
    providerExecutionRef: "execution-history-test",
    sourceRangeRef: JSON.stringify({ version: 1, status: "exact", sessionId, ...range }),
    freshSessionVerified,
  };
}

async function replaceSessionRows(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  rows: Array<Record<string, unknown>>,
  stateUpdates: Record<string, unknown> = {},
) {
  const statePath = path.join(fixtureData.root, "home", "state.db");
  const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
    messages: Record<string, Array<Record<string, unknown>>>;
    [key: string]: unknown;
  };
  state.messages[fixtureData.sessionId] = rows.map((row) => ({
    ...row,
    session_id: fixtureData.sessionId,
    active: row.active ?? 1,
    compacted: row.compacted ?? 0,
  }));
  Object.assign(state, stateUpdates);
  await fs.writeFile(statePath, JSON.stringify(state), "utf8");
}

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Hermes product history", () => {
  it.skipIf(!pythonCommand)("enforces per-item and projected page byte budgets", async () => {
    const fixtureData = await fixture();
    const itemLimited = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      maxItemBytes: 64,
    });
    const pageLimited = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      maxBytes: 256,
      maxItemBytes: 4096,
    });

    expect(itemLimited).toMatchObject({ items: [], nextCursor: null, completeness: "partial", limitReached: { reason: "item_bytes", maximum: 64 } });
    expect(pageLimited).toMatchObject({ items: [], nextCursor: null, completeness: "partial", limitReached: { reason: "page_bytes", maximum: 256 } });
  });

  it.skipIf(!pythonCommand)("keeps bounded closed-range pagination revision stable across unrelated tail appends", async () => {
    const fixtureData = await fixture();
    const input = {
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      range: { startExclusive: 1, endInclusive: 3 },
      limit: 1,
    };
    const first = await readHermesProductHistory(input);
    const statePath = path.join(fixtureData.root, "home", "state.db");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      messages: Record<string, Array<Record<string, unknown>>>;
      sessions: Record<string, Record<string, unknown>>;
    };
    state.messages[fixtureData.sessionId]!.push({
      id: 99,
      session_id: fixtureData.sessionId,
      role: "assistant",
      content: "outside the closed source range",
      timestamp: 999,
      active: 1,
      compacted: 0,
    });
    state.sessions[fixtureData.sessionId]!.message_count = 99;
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    const second = await readHermesProductHistory({ ...input, cursor: first.nextCursor });

    expect(first.items.map((item) => item.rowId)).toEqual([2]);
    expect(second.items.map((item) => item.rowId)).toEqual([3]);
    expect(second.nextCursor).toBeNull();
    expect(second.metadata.tailRowId).toBe(99);
    expect(second.revision).toBe(first.revision);
  });

  it.skipIf(!pythonCommand)("returns rows only for a verified exact span and requires fresh-session evidence for an open start", async () => {
    const fixtureData = await fixture();
    await replaceSessionRows(fixtureData, [
      { id: 2, role: "user", content: "owned input", timestamp: 2 },
      { id: 5, role: "assistant", content: "owned output", timestamp: 5 },
    ], {
      tips: { [fixtureData.sessionId]: fixtureData.sessionId },
      resume: { [fixtureData.sessionId]: fixtureData.sessionId },
    });
    const range = { startExclusive: 1, endInclusive: 5 };
    const proof = executionProof(fixtureData.sessionId, range);
    const result = await readHermesProductHistoryExecutionSpan({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      range,
      proof,
    });
    const unproven = await readHermesProductHistoryExecutionSpan({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      range,
    });
    const freshRange = { startExclusive: null, endInclusive: 5 };
    const freshUnproven = await readHermesProductHistoryExecutionSpan({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      range: freshRange,
      proof: executionProof(fixtureData.sessionId, freshRange),
    });

    expect(result).toMatchObject({ availability: "available", completeness: "complete", revision: expect.stringMatching(/^execution-span:/) });
    expect(result.items.map((item) => item.rowId)).toEqual([2, 5]);
    expect(unproven).toMatchObject({ availability: "available", completeness: "unknown", revision: "execution-boundary-unknown", items: [] });
    expect(freshUnproven).toMatchObject({ availability: "available", completeness: "unknown", revision: "execution-boundary-unknown", items: [] });
  });

  it("rejects a different runtime without invoking a provider fallback", async () => {
    const result = await readHermesProductHistory({
      runtimeType: "codex_local",
      sessionId: "session-old",
      profile: {
        pythonCommand: "/missing/python",
        sourcePath: "/missing/source",
        hermesHome: "/missing/home",
      },
    });
    expect(result).toMatchObject({ availability: "incompatible", items: [], nextCursor: null });
  });

  it("requires absolute host-owned interpreter, source, and home paths", async () => {
    await expect(readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: "session-old",
      profile: { pythonCommand: "python3", sourcePath: "/tmp/source", hermesHome: "/tmp/home" },
    })).rejects.toMatchObject({ name: "HermesProductHistoryError", code: "invalid_profile" });
  });

  it.skipIf(!pythonCommand)("reports an absent session as missing instead of an available empty history", async () => {
    const fixtureData = await fixture();
    const result = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: "session-not-persisted",
      profile: fixtureData.profile,
    });

    expect(result).toMatchObject({
      availability: "missing",
      completeness: "unknown",
      items: [],
      nextCursor: null,
      metadata: { tailRowId: null, session: null },
    });
  });
});

const providerDescribe = pythonCommand ? describe : describe.skip;

providerDescribe("with the versioned read-only Python helper", () => {
  it("reads exact row ranges with raw tool payloads, Unicode, inactive rows, and compression metadata", async () => {
    const fixtureData = await fixture();
    const first = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      range: { startExclusive: 1, endInclusive: 3 },
      limit: 1,
    });

    expect(first.availability).toBe("available");
    expect(first.completeness).toBe("complete");
    expect(first.metadata.helperVersion).toBe(HERMES_PRODUCT_HISTORY_HELPER_VERSION);
    expect(first.metadata.tailRowId).toBe(4);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ rowId: 2, sessionId: "session-old", text: "调用工具：中文输出" });
    expect(first.items[0].raw.tool_calls).toEqual([{ id: "call-1", type: "function", function: { name: "读取", arguments: '{"文字":"你好🐕"}' } }]);
    expect(first.items[0].entry.toolCalls).toEqual(first.items[0].raw.tool_calls);
    expect(first.items[0].entry.toolCallId).toBe("call-1");
    expect(first.nextCursor).toBeTruthy();
    expect(first.metadata.lineage).toMatchObject({
      requestedSessionId: "session-old",
      readSessionId: "session-old",
      compressionTipSessionId: "session-tip",
      resolvedResumeSessionId: "session-tip",
      successorSessionId: "session-tip",
      relation: "compression",
      rebound: false,
    });
    expect(first.metadata.successor?.id).toBe("session-tip");

    const second = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      range: { startExclusive: 1, endInclusive: 3 },
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.rowId)).toEqual([3]);
    expect(second.items[0].entry.active).toBe(false);
    expect(second.items[0].entry.compacted).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(second.items.some((item) => item.sessionId === "session-tip")).toBe(false);
  });

  it("rejects cursors reused across sessions or host profiles", async () => {
    const fixtureData = await fixture();
    const page = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      limit: 1,
    });
    expect(page.nextCursor).toBeTruthy();

    await expect(readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: "session-other",
      profile: fixtureData.profile,
      cursor: page.nextCursor,
      limit: 1,
    })).rejects.toMatchObject({ code: "cursor_scope_mismatch" });

    await expect(readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: { ...fixtureData.profile, profileId: "profile-other" },
      cursor: page.nextCursor,
      limit: 1,
    })).rejects.toMatchObject({ code: "cursor_scope_mismatch" });
  });

  it("invalidates pagination when an existing source row payload changes", async () => {
    const fixtureData = await fixture();
    const first = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      limit: 1,
    });
    expect(first.items[0]?.rowId).toBe(1);
    expect(first.nextCursor).toBeTruthy();

    const statePath = path.join(fixtureData.root, "home", "state.db");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      messages: Record<string, Array<Record<string, unknown>>>;
    };
    state.messages[fixtureData.sessionId]![0]!.content = "mutated after page one";
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");

    const changed = await readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      limit: 1,
    });
    expect(changed.revision).not.toBe(first.revision);
    await expect(readHermesProductHistory({
      runtimeType: "hermes_gateway",
      sessionId: fixtureData.sessionId,
      profile: fixtureData.profile,
      limit: 1,
      cursor: first.nextCursor,
    })).rejects.toMatchObject({ code: "cursor_snapshot_mismatch" });
  });
});
