import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HermesProductHistoryError,
  HERMES_PRODUCT_HISTORY_HELPER_VERSION,
  readHermesProductHistory,
  type HermesProductHistoryProfile,
} from "./product-history.js";

const FAKE_SESSION_DB = String.raw`
import json
from pathlib import Path

class SessionDB:
    def __init__(self, db_path=None, read_only=False):
        if not read_only:
            raise AssertionError("history helper must open SessionDB read-only")
        self.state = json.loads(Path(db_path).read_text(encoding="utf-8"))

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

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Hermes product history", () => {
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
});
