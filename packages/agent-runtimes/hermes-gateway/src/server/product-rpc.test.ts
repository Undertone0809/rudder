import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlHandle,
} from "@rudderhq/agent-runtime-utils";
import { hasConfirmedNativeWriterQuiescence } from "@rudderhq/agent-runtime-utils";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHermesNativeRpcClient, HermesNativeProcessCloseError } from "./native-protocol.js";
import {
  HERMES_PRODUCT_RPC_MCP_READY_NONCE_ENV,
  HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV,
  waitForHermesProductRpcMcpReady,
} from "./product-rpc-mcp-bootstrap.js";
import {
  buildHermesProductRpcSessionParams,
  deriveHermesProductRpcTranscriptBoundary,
  executeHermesProductRpcChat,
  forkHermesProductRpcNativeSession,
  HERMES_PRODUCT_RPC_BOOTSTRAP_MODULE,
  HERMES_PRODUCT_RPC_TRANSPORT,
  HermesProductRpcForkError,
  prepareHermesProductRpcMcpOverlay,
  type HermesProductRpcClient,
  type HermesProductRpcClientFactory,
  type HermesProductRpcProfile,
} from "./product-rpc.js";

const pythonCommand = (() => {
  try {
    return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();
const HISTORY_FENCE_SEED_SCRIPT = [
  "import sqlite3, sys",
  "connection = sqlite3.connect(sys.argv[1])",
  "connection.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY)')",
  "connection.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL)')",
  "connection.execute('INSERT INTO sessions (id) VALUES (?)', (sys.argv[2],))",
  "connection.execute('INSERT INTO messages (id, session_id) VALUES (?, ?)', (40, sys.argv[2]))",
  "connection.commit()",
  "connection.close()",
].join("\n");

const HISTORY_FENCE_EMPTY_DB_SCRIPT = [
  "import sqlite3, sys",
  "connection = sqlite3.connect(sys.argv[1])",
  "connection.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY)')",
  "connection.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL)')",
  "connection.commit()",
  "connection.close()",
].join("\n");

const HISTORY_FENCE_PERSIST_SESSION_SCRIPT = [
  "import sqlite3, sys",
  "connection = sqlite3.connect(sys.argv[1])",
  "connection.execute('INSERT INTO sessions (id) VALUES (?)', (sys.argv[2],))",
  "connection.execute('INSERT INTO messages (id, session_id) VALUES (?, ?)', (1, sys.argv[2]))",
  "connection.commit()",
  "connection.close()",
].join("\n");

const HISTORY_FENCE_INSERT_SCRIPT = [
  "import sqlite3, sys",
  "connection = sqlite3.connect(sys.argv[1], timeout=0.05)",
  "try:",
  "    connection.execute('BEGIN IMMEDIATE')",
  "    connection.execute('INSERT INTO messages (id, session_id) VALUES (?, ?)', (int(sys.argv[3]), sys.argv[2]))",
  "    connection.commit()",
  "    print('inserted')",
  "except sqlite3.OperationalError as error:",
  "    if 'locked' not in str(error).lower(): raise",
  "    print('blocked')",
  "finally:",
  "    connection.close()",
].join("\n");

const HISTORY_FENCE_READ_TAIL_SCRIPT = [
  "import sqlite3, sys",
  "connection = sqlite3.connect(sys.argv[1])",
  "row = connection.execute('SELECT MAX(id) FROM messages WHERE session_id = ?', (sys.argv[2],)).fetchone()",
  "print('null' if row[0] is None else row[0])",
  "connection.close()",
].join("\n");

const FORK_FAKE_SESSION_DB = [
  "import json",
  "import sqlite3",
  "",
  "class SessionDB:",
  "    def __init__(self, db_path=None, read_only=False):",
  "        self.read_only = read_only",
  "        self.connection = sqlite3.connect(('file:' + str(db_path) + '?mode=ro') if read_only else str(db_path), timeout=10, uri=read_only)",
  "        self.connection.row_factory = sqlite3.Row",
  "        if not read_only:",
  "            self.connection.executescript('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT, parent_session_id TEXT, cwd TEXT, profile_name TEXT, title TEXT); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, fields TEXT); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);')",
  "            self.connection.commit()",
  "",
  "    def get_session(self, session_id):",
  "        row = self.connection.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()",
  "        if row is None:",
  "            return None",
  "        value = dict(row)",
  "        value['model_config'] = json.loads(value['model_config'] or '{}')",
  "        return value",
  "",
  "    def get_resume_conversations(self, session_id):",
  "        rows = self.connection.execute('SELECT * FROM messages WHERE session_id = ? ORDER BY id', (session_id,)).fetchall()",
  "        display = []",
  "        for row in rows:",
  "            value = json.loads(row['fields'])",
  "            value.update({'_row_id': row['id'], 'role': row['role'], 'content': json.loads(row['content'])})",
  "            display.append(value)",
  "        mode = self.connection.execute('SELECT value FROM settings WHERE key = \"mode\"').fetchone()",
  "        if mode and mode['value'] == 'malformed' and session_id == 'hermes-fork-parent' and len(display) > 1:",
  "            display[1]['_row_id'] = display[0]['_row_id']",
  "        if mode and mode['value'] == 'incomplete' and session_id == 'hermes-fork-parent':",
  "            for row in display:",
  "                if row.get('content') == 'selected answer': row.pop('finish_reason', None)",
  "        return display, display",
  "",
  "    def create_session(self, session_id, source, **kwargs):",
  "        if self.read_only: raise RuntimeError('write attempted through read-only SessionDB')",
  "        self.connection.execute('INSERT INTO sessions (id, source, model, model_config, parent_session_id, cwd, profile_name, title) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', (session_id, source, kwargs.get('model'), json.dumps(kwargs.get('model_config') or {}), kwargs.get('parent_session_id'), kwargs.get('cwd'), kwargs.get('profile_name')))",
  "        self.connection.commit()",
  "        return session_id",
  "",
  "    def append_messages_batch(self, session_id, messages, chunk_rows=None):",
  "        if self.read_only: raise RuntimeError('write attempted through read-only SessionDB')",
  "        mode = self.connection.execute('SELECT value FROM settings WHERE key = \"mode\"').fetchone()",
  "        mode = mode['value'] if mode else ''",
  "        for index, message in enumerate(messages):",
  "            content = message.get('content')",
  "            if mode == 'mismatch' and session_id != 'hermes-fork-parent' and index == 0:",
  "                content = 'altered child copy'",
  "            fields = {key: value for key, value in message.items() if key not in ('role', 'content')}",
  "            if mode == 'metadata_loss' and session_id != 'hermes-fork-parent': fields.pop('api_content', None)",
  "            self.connection.execute('INSERT INTO messages (session_id, role, content, fields) VALUES (?, ?, ?, ?)', (session_id, message.get('role'), json.dumps(content, ensure_ascii=False), json.dumps(fields, ensure_ascii=False)))",
  "            if mode == 'partial' and session_id != 'hermes-fork-parent':",
  "                self.connection.commit()",
  "                raise RuntimeError('simulated partial batch write')",
  "        self.connection.commit()",
  "        return len(messages)",
  "",
  "    def delete_session(self, session_id, sessions_dir=None):",
  "        if self.read_only: raise RuntimeError('write attempted through read-only SessionDB')",
  "        self.connection.execute('DELETE FROM messages WHERE session_id = ?', (session_id,))",
  "        cursor = self.connection.execute('DELETE FROM sessions WHERE id = ?', (session_id,))",
  "        self.connection.commit()",
  "        return cursor.rowcount > 0",
  "",
  "    def get_session_title(self, session_id):",
  "        row = self.connection.execute('SELECT title FROM sessions WHERE id = ?', (session_id,)).fetchone()",
  "        return row['title'] if row else None",
  "",
  "    def get_next_title_in_lineage(self, title):",
  "        return title + ' (branch)'",
  "",
  "    def set_session_title(self, session_id, title):",
  "        if self.read_only: raise RuntimeError('write attempted through read-only SessionDB')",
  "        self.connection.execute('UPDATE sessions SET title = ? WHERE id = ?', (title, session_id))",
  "        self.connection.commit()",
  "",
  "    def set_test_mode(self, value):",
  "        if self.read_only: raise RuntimeError('write attempted through read-only SessionDB')",
  "        self.connection.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ('mode', value))",
  "        self.connection.commit()",
  "",
  "    def close(self):",
  "        self.connection.close()",
].join("\n");

const FORK_SEED_SCRIPT = [
  "import json, os, sys",
  "from pathlib import Path",
  "from hermes_state import SessionDB",
  "home = Path(os.environ['HERMES_HOME'])",
  "request = json.loads(sys.stdin.read() or '{}')",
  "db = SessionDB(db_path=home / 'state.db')",
  "db.create_session('hermes-fork-parent', source='acp', model='fixture-model', model_config={'max_iterations': 42, 'reasoning_config': {'effort': 'high'}}, cwd=str(home), profile_name=home.name)",
  "db.set_session_title('hermes-fork-parent', 'native chat')",
  "db.append_messages_batch('hermes-fork-parent', [",
  "    {'role': 'user', 'content': 'first question', 'timestamp': 1, 'api_content': '<context>exact wire</context>first question'},",
  "    {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'call-1', 'type': 'function', 'function': {'name': 'lookup', 'arguments': '{}'}}], 'timestamp': 2, 'finish_reason': 'tool_calls', 'reasoning': 'kept', 'reasoning_content': 'native reasoning', 'reasoning_details': [{'type': 'reasoning', 'text': 'kept'}]},",
  "    {'role': 'tool', 'content': 'tool result', 'timestamp': 3, 'tool_call_id': 'call-1', 'tool_name': 'lookup'},",
  "    {'role': 'user', 'content': 'second question', 'timestamp': 4},",
  "    {'role': 'assistant', 'content': 'selected answer', 'timestamp': 5, 'finish_reason': 'stop'},",
  "    {'role': 'user', 'content': 'later input', 'timestamp': 6},",
  "    {'role': 'assistant', 'content': 'later answer', 'timestamp': 7, 'finish_reason': 'stop'},",
  "])",
  "db.set_test_mode(request.get('mode', ''))",
  "db.close()",
].join("\n");

const FORK_READ_SCRIPT = [
  "import json, os, sys",
  "from pathlib import Path",
  "from hermes_state import SessionDB",
  "db = SessionDB(db_path=Path(os.environ['HERMES_HOME']) / 'state.db')",
  "session_id = sys.stdin.read().strip()",
  "session = db.get_session(session_id)",
  "rows = db.get_resume_conversations(session_id)[1] if session else []",
  "print(json.dumps({'session': session, 'rows': rows}, ensure_ascii=False, sort_keys=True, default=str))",
  "db.close()",
].join("\n");

type ForkFixture = {
  profile: HermesProductRpcProfile;
  root: string;
  readSession: (sessionId: string) => { session: Record<string, unknown> | null; rows: Array<Record<string, unknown>> };
  cleanup: () => Promise<void>;
};

async function makeForkFixture(mode = ""): Promise<ForkFixture> {
  if (!pythonCommand) throw new Error("python3 is unavailable for the isolated Hermes SessionDB fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-native-fork-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(source, "hermes_cli"), { recursive: true });
  await fs.mkdir(path.join(source, "tui_gateway"), { recursive: true });
  await fs.mkdir(home);
  await fs.writeFile(path.join(source, "hermes_cli", "__init__.py"), "__version__ = '0.21.0'\n", "utf8");
  await fs.writeFile(path.join(source, "hermes_state.py"), FORK_FAKE_SESSION_DB, "utf8");
  await fs.writeFile(path.join(source, "tui_gateway", "entry.py"), "# isolated test fixture\n", "utf8");
  const env = {
    ...process.env,
    HERMES_HOME: home,
    PYTHONPATH: source,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  execFileSync(pythonCommand, ["-c", FORK_SEED_SCRIPT], {
    cwd: source,
    env,
    input: JSON.stringify({ mode }),
    encoding: "utf8",
  });
  const binding = {
    hostId: "host-hermes-test",
    profileId: "profile-hermes-test",
    id: "binding-hermes-test",
    orgId: "org-hermes-test",
    workspaceBindingId: "workspace-hermes-test",
    capabilityRevision: "capability-hermes-test",
  };
  const profile: HermesProductRpcProfile = {
    binding,
    command: process.execPath,
    args: [],
    cwd: root,
    hermesPythonCommand: pythonCommand,
    hermesSourcePath: source,
    hermesHome: home,
    providerVersion: "0.21.0",
  };
  return {
    profile,
    root,
    readSession(sessionId) {
      const output = execFileSync(pythonCommand!, ["-c", FORK_READ_SCRIPT], {
        cwd: source,
        env,
        input: sessionId,
        encoding: "utf8",
      });
      return JSON.parse(output) as { session: Record<string, unknown> | null; rows: Array<Record<string, unknown>> };
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

const installedHermes021SourcePath = process.env.RUDDER_HERMES_021_SOURCE_PATH;
const installedHermes021PythonCommand = process.env.RUDDER_HERMES_021_PYTHON_COMMAND;
const installedHermes021Describe = installedHermes021SourcePath && installedHermes021PythonCommand ? describe : describe.skip;
const installedHermes021ProductRpcDescribe = installedHermes021SourcePath
  && installedHermes021PythonCommand
  && process.env.RUDDER_HERMES_021_PRODUCT_RPC_INTEGRATION === "1"
  ? describe
  : describe.skip;

const INSTALLED_HERMES_SEED_SCRIPT = [
  "import os",
  "from pathlib import Path",
  "from hermes_cli import __version__",
  "from hermes_state import SessionDB",
  "assert __version__ == '0.21.0', __version__",
  "home = Path(os.environ['HERMES_HOME'])",
  "db = SessionDB(db_path=home / 'state.db')",
  "db.create_session('hermes-fork-parent', source='acp', model='integration-model', model_config={'max_iterations': 42, 'reasoning_config': {'effort': 'high'}}, cwd=os.environ['RUDDER_TEST_CWD'], profile_name=home.name)",
  "db.set_session_title('hermes-fork-parent', 'native chat')",
  "db.append_messages_batch('hermes-fork-parent', [",
  "    {'role': 'user', 'content': 'first question', 'timestamp': 1, 'api_content': '<context>exact wire</context>first question'},",
  "    {'role': 'assistant', 'content': '', 'timestamp': 2, 'finish_reason': 'tool_calls', 'tool_calls': [{'id': 'call-1', 'type': 'function', 'function': {'name': 'lookup', 'arguments': '{}'}}], 'reasoning': 'kept', 'reasoning_content': 'native reasoning', 'reasoning_details': [{'type': 'reasoning', 'text': 'kept'}]},",
  "    {'role': 'tool', 'content': 'tool result', 'timestamp': 3, 'tool_call_id': 'call-1', 'tool_name': 'lookup'},",
  "    {'role': 'assistant', 'content': 'selected assistant boundary', 'timestamp': 4, 'finish_reason': 'stop'},",
  "    {'role': 'user', 'content': 'later input', 'timestamp': 5},",
  "    {'role': 'assistant', 'content': 'later answer', 'timestamp': 6, 'finish_reason': 'stop'},",
  "])",
  "db.close()",
].join("\n");

async function makeInstalledHermes021Fixture(): Promise<ForkFixture> {
  if (!installedHermes021SourcePath || !installedHermes021PythonCommand) {
    throw new Error("Installed Hermes 0.21.0 source fixture was not configured");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-021-fork-"));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const env = {
    ...process.env,
    HERMES_HOME: home,
    PYTHONPATH: installedHermes021SourcePath,
    PYTHONDONTWRITEBYTECODE: "1",
    RUDDER_TEST_CWD: root,
  };
  execFileSync(installedHermes021PythonCommand, ["-c", INSTALLED_HERMES_SEED_SCRIPT], {
    cwd: installedHermes021SourcePath,
    env,
    encoding: "utf8",
  });
  const binding = {
    hostId: "host-hermes-021-integration",
    profileId: "profile-hermes-021-integration",
  };
  const profile: HermesProductRpcProfile = {
    binding,
    command: process.execPath,
    args: [],
    cwd: root,
    hermesPythonCommand: installedHermes021PythonCommand,
    hermesSourcePath: installedHermes021SourcePath,
    hermesHome: home,
    providerVersion: "0.21.0",
  };
  return {
    profile,
    root,
    readSession(sessionId) {
      const output = execFileSync(installedHermes021PythonCommand!, ["-c", FORK_READ_SCRIPT], {
        cwd: installedHermes021SourcePath,
        env,
        input: sessionId,
        encoding: "utf8",
      });
      return JSON.parse(output) as { session: Record<string, unknown> | null; rows: Array<Record<string, unknown>> };
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function forkInput(fixture: ForkFixture, boundaryRowId = 5) {
  const sessionId = "hermes-fork-parent";
  return {
    runtimeType: "hermes_gateway",
    profile: fixture.profile,
    session: {
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: buildHermesProductRpcSessionParams({ sessionId, profile: fixture.profile }),
    },
    boundary: "hermes:db:" + sessionId + ":" + boundaryRowId,
    binding: fixture.profile.binding,
  };
}

describe("Hermes Product Gateway native Fork", () => {
  it("copies the full native prefix including tool linkage and restore state at an old exact assistant boundary", async () => {
    const fixture = await makeForkFixture();
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const input = forkInput(fixture);
      const result = await forkHermesProductRpcNativeSession(input);
      const parentAfter = fixture.readSession("hermes-fork-parent");
      const child = fixture.readSession(result.session.sessionId);
      const sourceBoundary = "hermes:db:hermes-fork-parent:5";

      expect(result).toMatchObject({
        sourceBoundary: input.boundary,
        continuity: "native",
        session: { sessionId: result.session.sessionId, sessionDisplayId: result.session.sessionId },
      });
      expect(result.boundary).toBe(result.identityMap[sourceBoundary]);
      expect(Object.keys(result.identityMap)).toEqual([
        "hermes:db:hermes-fork-parent:1",
        "hermes:db:hermes-fork-parent:2",
        "hermes:db:hermes-fork-parent:3",
        "hermes:db:hermes-fork-parent:4",
        sourceBoundary,
      ]);
      expect(parentAfter).toEqual(parentBefore);
      expect(child.session).toMatchObject({
        parent_session_id: "hermes-fork-parent",
        model_config: { _branched_from: "hermes-fork-parent", max_iterations: 42, reasoning_config: { effort: "high" } },
        title: "native chat (branch)",
      });
      expect(child.rows.map((row) => row.content)).toEqual([
        "first question",
        "",
        "tool result",
        "second question",
        "selected answer",
      ]);
      expect(child.rows.map((row) => row.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
      const withoutIds = (rows: Array<Record<string, unknown>>) => rows.map(({ _row_id, ...row }) => row);
      expect(withoutIds(child.rows)).toEqual(withoutIds(parentBefore.rows.slice(0, 5)));
      expect(child.rows.map((row) => "hermes:db:" + result.session.sessionId + ":" + row._row_id)).toEqual(
        Object.values(result.identityMap),
      );
      expect(child.rows.some((row) => row.content === "later answer")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a missing or non-assistant boundary without creating a child", async () => {
    for (const boundaryRowId of [2, 3, 4, 99]) {
      const fixture = await makeForkFixture();
      try {
        const parentBefore = fixture.readSession("hermes-fork-parent");
        const failure = await forkHermesProductRpcNativeSession(forkInput(fixture, boundaryRowId))
          .then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(HermesProductRpcForkError);
        expect(failure).toMatchObject({ status: "unsupported", details: { rolledBack: true } });
        const childSessionId = (failure as HermesProductRpcForkError).details.childSessionId;
        expect(childSessionId).toBeTruthy();
        expect(fixture.readSession(childSessionId!).session).toBeNull();
        expect(fixture.readSession("hermes-fork-parent")).toEqual(parentBefore);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("rejects a visible assistant row without persisted completion evidence", async () => {
    const fixture = await makeForkFixture("incomplete");
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const failure = await forkHermesProductRpcNativeSession(forkInput(fixture))
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HermesProductRpcForkError);
      expect(failure).toMatchObject({
        status: "unsupported",
        message: expect.stringContaining("not a completed assistant message"),
        details: { rolledBack: true },
      });
      const childSessionId = (failure as HermesProductRpcForkError).details.childSessionId;
      expect(childSessionId).toBeTruthy();
      expect(fixture.readSession(childSessionId!).session).toBeNull();
      expect(fixture.readSession("hermes-fork-parent")).toEqual(parentBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it("compensates a child whose append_messages_batch committed a partial prefix before failing", async () => {
    const fixture = await makeForkFixture("partial");
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const failure = await forkHermesProductRpcNativeSession(forkInput(fixture))
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HermesProductRpcForkError);
      expect(failure).toMatchObject({
        status: "unknown",
        details: { sessionId: "hermes-fork-parent", rolledBack: true },
      });
      const childSessionId = (failure as HermesProductRpcForkError).details.childSessionId;
      expect(childSessionId).toBeTruthy();
      expect(fixture.readSession(childSessionId!).session).toBeNull();
      expect(fixture.readSession("hermes-fork-parent")).toEqual(parentBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["mismatch", "metadata_loss"])("compensates a child when exact copy verification fails: %s", async (mode) => {
    const fixture = await makeForkFixture(mode);
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const failure = await forkHermesProductRpcNativeSession(forkInput(fixture))
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HermesProductRpcForkError);
      expect(failure).toMatchObject({
        status: "unknown",
        message: expect.stringContaining("differs from the selected parent prefix"),
        details: { rolledBack: true },
      });
      const childSessionId = (failure as HermesProductRpcForkError).details.childSessionId;
      expect(childSessionId).toBeTruthy();
      expect(fixture.readSession(childSessionId!).session).toBeNull();
      expect(fixture.readSession("hermes-fork-parent")).toEqual(parentBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when the parent display projection has malformed row identities", async () => {
    const fixture = await makeForkFixture("malformed");
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const failure = await forkHermesProductRpcNativeSession(forkInput(fixture))
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HermesProductRpcForkError);
      expect(failure).toMatchObject({
        status: "unknown",
        message: expect.stringContaining("duplicate, or unordered global _row_id"),
        details: { rolledBack: true },
      });
      expect(fixture.readSession("hermes-fork-parent")).toEqual(parentBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed before the helper for profile, session, and boundary mismatches", async () => {
    const fixture = await makeForkFixture();
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const base = forkInput(fixture);
      const mismatches = [
        { ...base, profile: { ...base.profile, providerVersion: "0.22.0" } },
        { ...base, session: { ...base.session, sessionParams: { ...base.session.sessionParams, profileId: "other-profile" } } },
        { ...base, boundary: "hermes:db:other-session:5" },
      ];
      for (const input of mismatches) {
        await expect(forkHermesProductRpcNativeSession(input)).rejects.toBeInstanceOf(HermesProductRpcForkError);
      }
      expect(fixture.readSession("hermes-fork-parent")).toEqual(parentBefore);
    } finally {
      await fixture.cleanup();
    }
  });
});

installedHermes021Describe("installed Hermes 0.21.0 SessionDB native Fork: " + installedHermes021SourcePath, () => {
  it("creates and reopens an exact child in an isolated HERMES_HOME without mutating its parent", async () => {
    const fixture = await makeInstalledHermes021Fixture();
    try {
      const parentBefore = fixture.readSession("hermes-fork-parent");
      const boundary = parentBefore.rows.find((row) => (
        row.role === "assistant" && row.content === "selected assistant boundary"
      ));
      expect(boundary?._row_id).toBeTypeOf("number");
      const result = await forkHermesProductRpcNativeSession(forkInput(fixture, Number(boundary?._row_id)));
      const parentAfter = fixture.readSession("hermes-fork-parent");
      const child = fixture.readSession(result.session.sessionId);
      const childModelConfig = typeof child.session?.model_config === "string"
        ? JSON.parse(child.session.model_config)
        : child.session?.model_config;

      expect(parentAfter).toEqual(parentBefore);
      expect(child.session).toMatchObject({ parent_session_id: "hermes-fork-parent" });
      expect(childModelConfig).toMatchObject({ _branched_from: "hermes-fork-parent", max_iterations: 42, reasoning_config: { effort: "high" } });
      expect(child.rows.map((row) => row.content)).toEqual([
        "first question",
        "",
        "tool result",
        "selected assistant boundary",
      ]);
      const withoutIds = (rows: Array<Record<string, unknown>>) => rows.map(({ _row_id, ...row }) => row);
      expect(withoutIds(child.rows)).toEqual(withoutIds(parentBefore.rows.slice(0, 4)));
      expect(result.boundary).toBe(result.identityMap[
        "hermes:db:hermes-fork-parent:" + boundary?._row_id
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

type GatewayEvent = (type: string, payload?: Record<string, unknown>, sessionId?: string | null) => void;
type GatewayHandler = (
  method: string,
  params: Record<string, unknown>,
  emit: GatewayEvent,
) => unknown | Promise<unknown>;

async function makeProfile(): Promise<{ profile: HermesProductRpcProfile; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-product-rpc-"));
  const source = path.join(root, "source");
  const hermesHome = path.join(root, "home");
  await fs.mkdir(path.join(source, "tui_gateway"), { recursive: true });
  await fs.mkdir(hermesHome, { recursive: true });
  await fs.writeFile(path.join(source, "tui_gateway", "entry.py"), "# test fixture\n");
  return {
    profile: {
      binding: { hostId: "host-hermes-test", profileId: "profile-hermes-test" },
      command: process.execPath,
      args: [],
      cwd: root,
      hermesPythonCommand: process.execPath,
      hermesSourcePath: source,
      hermesHome,
      providerVersion: "0.21.0",
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function addJsonYamlFixture(profile: HermesProductRpcProfile): Promise<void> {
  const source = [
    "import json",
    "def safe_load(stream): return json.load(stream)",
    "def safe_dump(data, stream, sort_keys=False, allow_unicode=True): json.dump(data, stream, ensure_ascii=not allow_unicode)",
    "",
  ].join("\n");
  await fs.writeFile(path.join(profile.hermesSourcePath, "yaml.py"), source, { flag: "wx" });
}

function mockGateway(
  handler: GatewayHandler = () => undefined,
  options: { writeMcpReadyReceipt?: boolean } = {},
) {
  let notify: ((method: string, params: Record<string, unknown>) => void) | null = null;
  let activeSessionId = "hermes-product-runtime-1";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const timeline: string[] = [];
  const emit: GatewayEvent = (type, payload = {}, sessionId = activeSessionId) => {
    notify?.("event", {
      type,
      ...(sessionId ? { session_id: sessionId } : {}),
      payload,
    });
  };
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      timeline.push(method);
      const handled = await handler(method, params, emit);
      if (handled !== undefined) return handled;
      if (method === "ping") return { pong: true };
      if (method === "gateway.capabilities") return { per_session_exclusive_submit: true };
      if (method === "session.create") return { session_id: activeSessionId, stored_session_id: "hermes-product-session" };
      if (method === "session.resume") {
        activeSessionId = "hermes-product-runtime-resumed";
        return { session_id: activeSessionId, session_key: params.session_id, auto_continue: false, running: false, status: "idle" };
      }
      if (method === "session.info") return { info: { running: false, model: "hermes-test-model" } };
      if (method === "session.redirect") return { status: "redirected" };
      if (method === "session.interrupt") return { status: "interrupted" };
      return { status: "ok" };
    },
    async close() {
      timeline.push("close");
    },
  };
  const createClient = async ({
    profile,
    onNotification,
    onSpawn,
  }: {
    profile: { env?: Record<string, string> };
    onNotification: (method: string, params: Record<string, unknown>) => void;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }) => {
    const readyPath = profile.env?.[HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV];
    const readyNonce = profile.env?.[HERMES_PRODUCT_RPC_MCP_READY_NONCE_ENV];
    if (options.writeMcpReadyReceipt !== false && readyPath && readyNonce) {
      await fs.writeFile(readyPath, JSON.stringify({
        version: 1,
        nonce: readyNonce,
        serverName: "rudder-tools",
        status: "ready",
        toolNames: ["mcp__rudder_tools__rudder_agent_me"],
      }), { mode: 0o600 });
    }
    notify = onNotification;
    await onSpawn?.({ pid: process.pid, startedAt: new Date().toISOString() });
    queueMicrotask(() => emit("gateway.ready", {}, null));
    return client as never;
  };
  return { calls, timeline, client, createClient };
}

function emitTurnComplete(emit: GatewayEvent, status = "complete") {
  emit("message.complete", {
    text: "Hermes product response",
    status,
    model: "hermes-test-model",
    usage: { inputTokens: 8, outputTokens: 3 },
  });
  emit("session.info", { running: false, model: "hermes-test-model" });
}

function runInput(
  profile: HermesProductRpcProfile,
  createClient: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["createClient"]>,
  readHistoryTail?: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]>,
  overrides: Pick<Parameters<typeof executeHermesProductRpcChat>[0], "acquireHistoryFence" | "waitForSessionLease"> = {},
) {
  const tails = [40, 44];
  return {
    profile,
    sessionId: null,
    sessionParams: null,
    prompt: "Use the native Hermes session.",
    timeoutMs: 2_000,
    onLog: async () => undefined,
    createClient,
    readHistoryTail: readHistoryTail ?? (async () => ({
      availability: "available",
      tailRowId: tails.shift() ?? 44,
      relation: "none",
      successorSessionId: null,
    })),
    acquireHistoryFence: async () => null,
    ...overrides,
  };
}

describe("Hermes Product Gateway RPC", () => {
  it.skipIf(!pythonCommand)("keeps Rudder MCP identity per Run while resuming one native session", async () => {
    const fixture = await makeProfile();
    const configPath = path.join(fixture.profile.hermesHome, "config.yaml");
    const statePath = path.join(fixture.profile.hermesHome, "state.db");
    const originalConfig = JSON.stringify({
      model: "local-test",
      mcp_servers: { "external-local": { type: "stdio", command: "existing-server" } },
    });
    await fs.writeFile(configPath, originalConfig, { mode: 0o600 });
    await fs.writeFile(statePath, "native session database");
    await addJsonYamlFixture(fixture.profile);
    const profile = { ...fixture.profile, hermesPythonCommand: pythonCommand! };
    const command = {
      command: process.execPath,
      args: ["mcp-server"],
      env: { RUDDER_MCP_RUDDER_BIN: "/tmp/rudder-cli" },
      provenance: "repo" as const,
    };
    const firstIdentity = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "run-token-first",
      RUDDER_ORG_ID: "org-first",
      RUDDER_AGENT_ID: "agent-first",
      RUDDER_RUN_ID: "run-first",
    };
    const secondIdentity = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "run-token-second",
      RUDDER_ORG_ID: "org-second",
      RUDDER_AGENT_ID: "agent-second",
      RUDDER_RUN_ID: "run-second",
    };
    let first: Awaited<ReturnType<typeof prepareHermesProductRpcMcpOverlay>> | null = null;
    let second: Awaited<ReturnType<typeof prepareHermesProductRpcMcpOverlay>> | null = null;
    try {
      first = await prepareHermesProductRpcMcpOverlay({ profile, mcp: { command, identity: firstIdentity } });
      second = await prepareHermesProductRpcMcpOverlay({ profile, mcp: { command, identity: secondIdentity } });

      const firstConfig = await fs.readFile(path.join(first.home, "config.yaml"), "utf8");
      const secondConfig = await fs.readFile(path.join(second.home, "config.yaml"), "utf8");
      const firstServer = JSON.parse(firstConfig).mcp_servers as Record<string, Record<string, unknown>>;
      const secondServer = JSON.parse(secondConfig).mcp_servers as Record<string, Record<string, unknown>>;
      const firstEnv = firstServer["rudder-tools"].env as Record<string, string>;
      const secondEnv = secondServer["rudder-tools"].env as Record<string, string>;
      const firstAlias = firstEnv.RUDDER_API_KEY.match(/^\$\{(.+)\}$/u)?.[1];
      const secondAlias = secondEnv.RUDDER_API_KEY.match(/^\$\{(.+)\}$/u)?.[1];
      const firstBootstrap = await fs.readFile(path.join(first.home, "rudder_product_rpc_bootstrap.py"), "utf8");

      expect(first.home).not.toBe(second.home);
      expect(await fs.realpath(path.join(first.home, "state.db"))).toBe(await fs.realpath(statePath));
      expect(await fs.realpath(path.join(second.home, "state.db"))).toBe(await fs.realpath(statePath));
      const durableRuntime = path.join(fixture.profile.hermesHome, "runtime");
      expect(await fs.realpath(path.join(first.home, "runtime"))).toBe(await fs.realpath(durableRuntime));
      expect(await fs.realpath(path.join(second.home, "runtime"))).toBe(await fs.realpath(durableRuntime));
      const registry = path.join(first.home, "runtime", "active_sessions.json");
      const pendingRegistry = `${registry}.pending`;
      await fs.writeFile(pendingRegistry, JSON.stringify({ entries: [{ session_id: "native-session-shared" }] }), { mode: 0o600 });
      await fs.rename(pendingRegistry, registry);
      expect(await fs.readFile(path.join(durableRuntime, "active_sessions.json"), "utf8"))
        .toContain("native-session-shared");
      expect(firstServer).toHaveProperty("external-local");
      expect(secondServer).toHaveProperty("external-local");
      expect(firstAlias).toBeTruthy();
      expect(secondAlias).toBeTruthy();
      expect(firstAlias).not.toBe(secondAlias);
      expect(first.env[firstAlias!]).toBe(firstIdentity.RUDDER_API_KEY);
      expect(second.env[secondAlias!]).toBe(secondIdentity.RUDDER_API_KEY);
      expect(firstConfig).not.toContain(firstIdentity.RUDDER_API_KEY);
      expect(firstConfig).not.toContain(secondIdentity.RUDDER_API_KEY);
      expect(secondConfig).not.toContain(firstIdentity.RUDDER_API_KEY);
      expect(secondConfig).not.toContain(secondIdentity.RUDDER_API_KEY);
      expect(firstBootstrap).toContain("mcp_startup.set_mcp_server_filter([SERVER_NAME])");
      expect(firstBootstrap).toContain("mcp_tool_discovery.discover_mcp_tools = _discover_rudder_tools");
      expect(firstBootstrap).toContain("entry.main()");
      expect(firstBootstrap.indexOf("mcp_startup.set_mcp_server_filter([SERVER_NAME])"))
        .toBeLessThan(firstBootstrap.indexOf("entry.main()"));
      expect(firstBootstrap.indexOf("mcp_tool_discovery.discover_mcp_tools = _discover_rudder_tools"))
        .toBeLessThan(firstBootstrap.indexOf("from tui_gateway import entry"));
      expect(firstBootstrap.indexOf("returned_names = _original_discover_rudder_tools(*args, **kwargs)"))
        .toBeLessThan(firstBootstrap.indexOf("for key in ENV_KEYS:"));

      const sessionParams = buildHermesProductRpcSessionParams({ sessionId: "native-session-shared", profile });
      expect(sessionParams.hermesSessionId).toBe("native-session-shared");
      expect(JSON.stringify(sessionParams)).not.toContain(firstIdentity.RUDDER_API_KEY);
      expect(JSON.stringify(sessionParams)).not.toContain(secondIdentity.RUDDER_API_KEY);
      expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
      expect(await fs.readdir(fixture.profile.hermesHome)).not.toContain("rudder_product_rpc_bootstrap.py");
      expect(await fs.readdir(durableRuntime)).toEqual(["active_sessions.json"]);
      await first.cleanup();
      expect(await fs.readFile(path.join(durableRuntime, "active_sessions.json"), "utf8"))
        .toContain("native-session-shared");
      expect(await fs.stat(first.home).catch(() => null)).toBeNull();
    } finally {
      await first?.cleanup();
      await second?.cleanup();
      await fixture.cleanup();
    }
  });

  it.skipIf(!pythonCommand)("does not create a session or submit a prompt before typed Rudder tools are ready", async () => {
    const fixture = await makeProfile();
    const configPath = path.join(fixture.profile.hermesHome, "config.yaml");
    await fs.writeFile(configPath, JSON.stringify({ model: "local-test" }), { mode: 0o600 });
    await addJsonYamlFixture(fixture.profile);
    const profile = { ...fixture.profile, hermesPythonCommand: pythonCommand! };
    const gateway = mockGateway(() => undefined, { writeMcpReadyReceipt: false });
    try {
      const result = await executeHermesProductRpcChat({
        ...runInput(profile, gateway.createClient),
        timeoutMs: 1_000,
        rudderMcp: {
          command: { command: process.execPath, args: ["mcp-server"], provenance: "repo" },
          identity: {
            RUDDER_API_URL: "http://127.0.0.1:1",
            RUDDER_API_KEY: "readiness-test-only-token",
            RUDDER_ORG_ID: "org-readiness-test",
            RUDDER_AGENT_ID: "agent-readiness-test",
            RUDDER_RUN_ID: "run-readiness-test",
          },
        },
      });

      expect(result).toMatchObject({ exitCode: 1, submissionPhase: "pre_submission" });
      expect(result.errorMessage).toMatch(/did not register typed rudder-tools/u);
      expect(gateway.calls.map(({ method }) => method)).toEqual(["ping", "gateway.capabilities"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["empty tool set", [], "ready", "non-empty typed Rudder MCP tool set"],
    ["missing rudder_agent_me", ["mcp__rudder_tools__rudder_probe"], "ready", "including rudder_agent_me"],
    ["failed discovery", [], "failed", "discovery failed (no_typed_rudder_tools_registered)"],
  ] as const)("rejects an invalid readiness receipt: %s", async (_case, toolNames, status, expectedMessage) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-ready-receipt-"));
    const readyReceiptPath = path.join(root, "ready.json");
    const readyNonce = "test-ready-nonce";
    try {
      await fs.writeFile(readyReceiptPath, JSON.stringify({
        version: 1,
        nonce: readyNonce,
        serverName: "rudder-tools",
        status,
        toolNames,
        ...(status === "failed" ? { errorCode: "no_typed_rudder_tools_registered" } : {}),
      }));

      await expect(waitForHermesProductRpcMcpReady({
        overlay: { readyReceiptPath, readyNonce },
        timeoutMs: 100,
      })).rejects.toThrow(expectedMessage);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!pythonCommand)("launches the trusted MCP bootstrap and persists fresh native data in the original home", async () => {
    const fixture = await makeProfile();
    const originalConfig = JSON.stringify({
      model: "local-test",
      mcp_servers: { "external-local": { type: "stdio", command: "existing-server" } },
    });
    const configPath = path.join(fixture.profile.hermesHome, "config.yaml");
    await fs.writeFile(configPath, originalConfig, { mode: 0o600 });
    await addJsonYamlFixture(fixture.profile);
    const profile = { ...fixture.profile, hermesPythonCommand: pythonCommand! };
    const identity = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "run-scoped-secret-never-persist",
      RUDDER_ORG_ID: "org-product-rpc",
      RUDDER_AGENT_ID: "agent-product-rpc",
      RUDDER_RUN_ID: "run-product-rpc",
    };
    const command = {
      command: process.execPath,
      args: ["mcp-server"],
      env: { RUDDER_MCP_RUDDER_BIN: "/tmp/rudder-cli" },
      provenance: "repo" as const,
    };
    const gateway = mockGateway((method, _params, emit) => {
      if (method !== "prompt.submit") return undefined;
      emit("message.start");
      emitTurnComplete(emit);
      return { status: "streaming" };
    });
    let launchHome: string | null = null;
    let launchHomeField: string | null = null;
    let launchArgs: readonly string[] | null = null;
    const createClient: HermesProductRpcClientFactory = async (input) => {
      launchHome = String(input.profile.env?.HERMES_HOME ?? "");
      launchHomeField = input.profile.hermesHome ?? null;
      launchArgs = input.profile.args;
      const launchedHome = launchHome;
      const nativeWrite = [
        "import os, sqlite3",
        "home = os.environ['HERMES_HOME']",
        "db = sqlite3.connect(os.path.join(home, 'state.db'))",
        "db.execute('CREATE TABLE native_proof (value TEXT NOT NULL)')",
        "db.execute('INSERT INTO native_proof VALUES (?)', ('persisted',))",
        "db.commit()",
        "db.close()",
      ].join("\n");
      execFileSync(pythonCommand!, ["-c", nativeWrite], {
        cwd: profile.hermesSourcePath,
        env: { ...process.env, ...input.profile.env },
      });
      await fs.writeFile(path.join(launchedHome, "sessions", "fresh-session.jsonl"), "native transcript\n");
      await fs.writeFile(path.join(launchedHome, "memories", "fresh-memory.md"), "native memory\n");
      return gateway.createClient(input);
    };

    try {
      const result = await executeHermesProductRpcChat({
        ...runInput(profile, createClient),
        rudderMcp: { command, identity },
      });

      expect(result).toMatchObject({ exitCode: 0, resultJson: { backend: "native_product_rpc" } });
      expect(launchHome).not.toBe(fixture.profile.hermesHome);
      expect(launchHomeField).toBe(launchHome);
      expect(launchHomeField).not.toBe(fixture.profile.hermesHome);
      expect(launchArgs).toEqual(["-m", HERMES_PRODUCT_RPC_BOOTSTRAP_MODULE]);
      expect(JSON.stringify(result)).not.toContain(identity.RUDDER_API_KEY);
      await expect(fs.stat(launchHome!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(fixture.profile.hermesHome, "sessions", "fresh-session.jsonl"), "utf8"))
        .toBe("native transcript\n");
      expect(await fs.readFile(path.join(fixture.profile.hermesHome, "memories", "fresh-memory.md"), "utf8"))
        .toBe("native memory\n");
      const persisted = execFileSync(pythonCommand!, [
        "-c",
        "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT value FROM native_proof').fetchone()[0]); db.close()",
        path.join(fixture.profile.hermesHome, "state.db"),
      ], { encoding: "utf8" }).trim();
      expect(persisted).toBe("persisted");
      expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(!pythonCommand)("retains the MCP overlay when the native process close is unconfirmed", async () => {
    const fixture = await makeProfile();
    const configPath = path.join(fixture.profile.hermesHome, "config.yaml");
    await fs.writeFile(configPath, JSON.stringify({ model: "local-test" }), { mode: 0o600 });
    await addJsonYamlFixture(fixture.profile);
    const profile = { ...fixture.profile, hermesPythonCommand: pythonCommand! };
    const identity = {
      RUDDER_API_URL: "http://127.0.0.1:3100",
      RUDDER_API_KEY: "run-scoped-close-test-secret",
      RUDDER_ORG_ID: "org-close-test",
      RUDDER_AGENT_ID: "agent-close-test",
      RUDDER_RUN_ID: "run-close-test",
    };
    const gateway = mockGateway((method, _params, emit) => {
      if (method !== "prompt.submit") return undefined;
      emit("message.start");
      emitTurnComplete(emit);
      return { status: "streaming" };
    });
    let overlayHome: string | null = null;
    try {
      await expect(executeHermesProductRpcChat({
        ...runInput(profile, gateway.createClient),
        rudderMcp: {
          command: { command: process.execPath, args: ["mcp-server"], provenance: "repo" },
          identity,
        },
        createClient: async (input) => {
          overlayHome = String(input.profile.env?.HERMES_HOME ?? "");
          const client = await gateway.createClient(input) as unknown as HermesProductRpcClient;
          return {
            ...client,
            async close() {
              throw new HermesNativeProcessCloseError({
                processExited: false,
                exitCode: null,
                signal: null,
                closeAcknowledged: false,
                stderr: "close-ack-sentinel",
              });
            },
          };
        },
      })).rejects.toThrow(/close was not acknowledged/u);

      expect(overlayHome).toBeTruthy();
      const overlayStats = await fs.stat(overlayHome!);
      expect(overlayStats.isDirectory()).toBe(true);
    } finally {
      if (overlayHome) await fs.rm(overlayHome, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it.each(["timeout", "abort"] as const)("kills and waits for the MCP config helper on %s before overlay cleanup", async (mode) => {
    const fixture = await makeProfile();
    const fixtureRoot = path.dirname(fixture.profile.hermesHome);
    const markerPath = path.join(fixtureRoot, `helper-${mode}.txt`);
    const helperPath = path.join(fixtureRoot, `slow-python-${mode}`);
    await fs.writeFile(
      helperPath,
      `#!/bin/sh\nprintf '%s' "$4" > '${markerPath}'\ntrap '' TERM\nexec /bin/sleep 30\n`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeoutMs = mode === "timeout" ? 6_000 : 5_000;
    const preparation = prepareHermesProductRpcMcpOverlay({
      profile: { ...fixture.profile, hermesPythonCommand: helperPath },
      mcp: {
        command: { command: process.execPath, args: [], provenance: "repo" },
        identity: {
          RUDDER_API_URL: "http://127.0.0.1:3100",
          RUDDER_API_KEY: "run-scoped-helper-secret",
          RUDDER_ORG_ID: "org-helper",
          RUDDER_AGENT_ID: "agent-helper",
          RUDDER_RUN_ID: "run-helper",
        },
      },
      timeoutMs,
      ...(mode === "abort" ? { signal: controller.signal } : {}),
    });
    const settledPreparation = preparation.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      let targetPath: string | null = null;
      // Overlay setup and process scheduling happen before the helper timeout starts.
      const markerDeadline = Date.now() + timeoutMs + 1_500;
      while (!targetPath && Date.now() < markerDeadline) {
        targetPath = await fs.readFile(markerPath, "utf8").catch(() => null);
        if (targetPath) break;
        const earlyOutcome = await Promise.race([
          settledPreparation,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
        ]);
        if (earlyOutcome) {
          const detail = earlyOutcome.status === "rejected"
            ? earlyOutcome.error instanceof Error ? earlyOutcome.error.message : String(earlyOutcome.error)
            : "resolved before the helper startup marker";
          throw new Error(`MCP config helper settled before writing its startup marker: ${detail}`);
        }
      }
      expect(targetPath, "MCP config helper did not write its startup marker before the timeout window").toContain("config.yaml");
      if (mode === "abort") {
        controller.abort();
      }
      const outcome = await settledPreparation;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toMatch(mode === "timeout" ? /timed out/u : /cancelled/u);
      }
      targetPath = await fs.readFile(markerPath, "utf8");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(mode === "timeout" ? timeoutMs + 800 : 800);
      await expect(fs.stat(path.dirname(targetPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      await fixture.cleanup();
    }
  }, 12_000);

  it("submits through a native session and round-trips the correlated approval choice", async () => {
    const fixture = await makeProfile();
    try {
      let approvalRequest: AgentRuntimeApprovalRequest | null = null;
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("approval.request", {
            request_id: "approval-provider-17",
            description: "Run the requested command?",
            command: "npm test",
            choices: ["once", "session", "always", "deny"],
          });
          return { status: "streaming" };
        }
        if (method === "approval.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestApproval: async (request) => {
          approvalRequest = request;
          return { id: "rudder-approval-17", status: "pending" };
        },
        waitForApproval: async (id) => ({
          id,
          status: "approved",
          inputResponse: { answers: [{ questionId: "hermes_product_approval", optionIds: ["hermes_choice_1"] }] },
        } satisfies AgentRuntimeApprovalDecision),
      });

      expect(result).toMatchObject({
        exitCode: 0,
        provider: "hermes",
        nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
        sessionId: "hermes-product-session",
        sessionParams: { transport: HERMES_PRODUCT_RPC_TRANSPORT },
        usage: { inputTokens: 8, outputTokens: 3 },
        summary: "Hermes product response",
        resultJson: { backend: "native_product_rpc", nativeSession: true },
      });
      expect(hasConfirmedNativeWriterQuiescence(result)).toBe(true);
      // A settled turn can release its writer without claiming an exact range.
      expect(result.resultJson?.executionRef).toBeNull();
      expect(gateway.calls.map(({ method }) => method)).toEqual(expect.arrayContaining([
        "gateway.capabilities",
        "session.create",
        "prompt.submit",
        "approval.respond",
      ]));
      expect(gateway.calls.find(({ method }) => method === "approval.respond")?.params).toMatchObject({
        session_id: "hermes-product-runtime-1",
        request_id: "approval-provider-17",
        choice: "once",
      });
      expect(approvalRequest).toMatchObject({
        type: "agent_runtime",
        payload: { protocol: "native_product_rpc", requestId: "approval-provider-17" },
        inputRequest: { questions: [{ id: "hermes_product_approval" }] },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(!pythonCommand)("proves an empty first-turn baseline from the native fence before Hermes persists the session", async () => {
    const fixture = await makeProfile();
    try {
      const sessionId = "hermes-product-session";
      const statePath = path.join(fixture.profile.hermesHome, "state.db");
      execFileSync(pythonCommand!, ["-c", HISTORY_FENCE_EMPTY_DB_SCRIPT, statePath], { encoding: "utf8" });
      const profile = { ...fixture.profile, hermesPythonCommand: pythonCommand! };
      let historyReadCount = 0;
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async (_profile, requestedSessionId) => {
        expect(requestedSessionId).toBe(sessionId);
        if (historyReadCount++ === 0) {
          return { availability: "missing", tailRowId: null, relation: "unknown", successorSessionId: null };
        }
        const tailRowId = Number(execFileSync(pythonCommand!, [
          "-c",
          HISTORY_FENCE_READ_TAIL_SCRIPT,
          statePath,
          sessionId,
        ], { encoding: "utf8" }).trim());
        return { availability: "available", tailRowId, relation: "none", successorSessionId: null };
      };
      const gateway = mockGateway(async (method, _params, emit) => {
        if (method !== "prompt.submit") return undefined;
        const registryPath = path.join(profile.hermesHome, "runtime", "active_sessions.json");
        await fs.mkdir(path.dirname(registryPath), { recursive: true });
        await fs.writeFile(registryPath, JSON.stringify({ entries: [{
          lease_id: "test-lease",
          session_id: sessionId,
          surface: "desktop",
          pid: process.pid,
          metadata: { live_session_id: "hermes-product-runtime-1" },
        }] }), "utf8");
        await new Promise((resolve) => setTimeout(resolve, 50));
        execFileSync(pythonCommand!, ["-c", HISTORY_FENCE_PERSIST_SESSION_SCRIPT, statePath, sessionId], { encoding: "utf8" });
        emit("message.start");
        emitTurnComplete(emit);
        return { status: "streaming" };
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(profile, gateway.createClient, readHistoryTail, { acquireHistoryFence: undefined }),
      });

      expect(result).toMatchObject({
        exitCode: 0,
        resultJson: {
          transcriptBoundary: {
            status: "exact",
            sessionId,
            startExclusive: null,
            endInclusive: 1,
            sourceRangeRef: JSON.stringify({
              version: 1,
              status: "exact",
              sessionId,
              startExclusive: null,
              endInclusive: 1,
            }),
          },
          executionRef: `hermes:db:${sessionId}:1`,
        },
      });
      expect(hasConfirmedNativeWriterQuiescence(result)).toBe(true);
      expect(historyReadCount).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["an older fence mock without the session flag", undefined],
    ["a fence that reports a session row", true],
  ] as const)("does not infer an empty first-turn baseline from %s", async (_case, sessionExists) => {
    const fixture = await makeProfile();
    try {
      const tails = [
        { availability: "missing" as const, tailRowId: null, relation: "unknown" as const, successorSessionId: null },
        { availability: "available" as const, tailRowId: 1, relation: "none" as const, successorSessionId: null },
      ];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => tails.shift() ?? null;
      const gateway = mockGateway((method, _params, emit) => {
        if (method !== "prompt.submit") return undefined;
        emit("message.start");
        emitTurnComplete(emit);
        return { status: "streaming" };
      });
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail, {
          acquireHistoryFence: async () => ({
            tailRowId: null,
            ...(sessionExists === undefined ? {} : { sessionExists }),
            isHeld: () => true,
            release: async () => undefined,
          }),
        }),
      });

      expect(result).toMatchObject({ exitCode: 0, resultJson: { transcriptBoundary: { status: "unknown", sourceRangeRef: null } } });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not apply the fresh-session exception when a resumed session is missing", async () => {
    const fixture = await makeProfile();
    try {
      const sessionId = "hermes-product-session";
      const tails = [
        { availability: "missing" as const, tailRowId: null, relation: "unknown" as const, successorSessionId: null },
        { availability: "available" as const, tailRowId: 1, relation: "none" as const, successorSessionId: null },
      ];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => tails.shift() ?? null;
      const gateway = mockGateway((method, _params, emit) => {
        if (method !== "prompt.submit") return undefined;
        emit("message.start");
        emitTurnComplete(emit);
        return { status: "streaming" };
      });
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail, {
          acquireHistoryFence: async () => ({
            tailRowId: null,
            sessionExists: false,
            isHeld: () => true,
            release: async () => undefined,
          }),
        }),
        sessionId,
        sessionParams: buildHermesProductRpcSessionParams({ sessionId, profile: fixture.profile }),
      });

      expect(result).toMatchObject({ exitCode: 0, resultJson: { transcriptBoundary: { status: "unknown", sourceRangeRef: null } } });
      expect(gateway.calls.some(({ method }) => method === "session.resume")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a fresh first-turn boundary unknown when the read-only tail disagrees with the fence", async () => {
    const fixture = await makeProfile();
    try {
      const tails = [
        { availability: "available" as const, tailRowId: 40, relation: "none" as const, successorSessionId: null },
        { availability: "available" as const, tailRowId: 41, relation: "none" as const, successorSessionId: null },
      ];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => tails.shift() ?? null;
      const gateway = mockGateway((method, _params, emit) => {
        if (method !== "prompt.submit") return undefined;
        emit("message.start");
        emitTurnComplete(emit);
        return { status: "streaming" };
      });
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail, {
          acquireHistoryFence: async () => ({
            tailRowId: null,
            sessionExists: false,
            isHeld: () => true,
            release: async () => undefined,
          }),
        }),
      });

      expect(result).toMatchObject({ exitCode: 0, resultJson: { transcriptBoundary: { status: "unknown", sourceRangeRef: null } } });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a fresh first-turn boundary unknown when the writer fence expires before lease proof", async () => {
    const fixture = await makeProfile();
    try {
      let held = true;
      const tails = [
        { availability: "missing" as const, tailRowId: null, relation: "unknown" as const, successorSessionId: null },
        { availability: "available" as const, tailRowId: 1, relation: "none" as const, successorSessionId: null },
      ];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => tails.shift() ?? null;
      const gateway = mockGateway(async (method, _params, emit) => {
        if (method !== "prompt.submit") return undefined;
        await new Promise((resolve) => setTimeout(resolve, 50));
        emit("message.start");
        emitTurnComplete(emit);
        return { status: "streaming" };
      });
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail, {
          acquireHistoryFence: async () => ({
            tailRowId: null,
            sessionExists: false,
            isHeld: () => held,
            release: async () => { held = false; },
          }),
          waitForSessionLease: async () => {
            held = false;
            return true;
          },
        }),
      });

      expect(result).toMatchObject({ exitCode: 0, resultJson: { transcriptBoundary: { status: "unknown", sourceRangeRef: null } } });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the Product Gateway Run boundary unknown when the SessionDB writer fence is unavailable", async () => {
    const fixture = await makeProfile();
    try {
      const tails = [40, 44];
      const reads: string[] = [];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async (_profile, sessionId) => {
        reads.push(sessionId);
        return {
          availability: "available",
          tailRowId: tails.shift() ?? null,
          relation: "none",
          successorSessionId: null,
        };
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      expect(result).toMatchObject({
        exitCode: 0,
        resultJson: {
          transcriptBoundary: {
            status: "unknown",
            sessionId: "hermes-product-session",
            sourceRangeRef: null,
          },
        },
      });
      expect((result.resultJson?.transcriptBoundary as Record<string, unknown>).reason).toContain("could not hold a SessionDB writer fence");
      expect(reads).toEqual(["hermes-product-session", "hermes-product-session"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the span unknown when a foreign writer appends after the before-snapshot and releases before submit admission", async () => {
    const fixture = await makeProfile();
    try {
      const order: string[] = [];
      const runLogs: string[] = [];
      let readCount = 0;
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => {
        order.push(readCount === 0 ? "before-history-snapshot" : "after-history-snapshot");
        const tailRowId = readCount++ === 0 ? 40 : 44;
        return { availability: "available", tailRowId, relation: "none", successorSessionId: null };
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          // Models an old owner writing after Rudder's snapshot, then releasing
          // the runtime lease before this handler acquires it.
          order.push("foreign-writer-appends-and-releases-lease");
          order.push("prompt-submit-acquires-exclusive-lease");
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
        onLog: async (_stream, chunk) => { runLogs.push(chunk); },
      });

      expect(order).toEqual([
        "before-history-snapshot",
        "foreign-writer-appends-and-releases-lease",
        "prompt-submit-acquires-exclusive-lease",
        "after-history-snapshot",
      ]);
      expect(result).toMatchObject({
        exitCode: 0,
        resultJson: {
          transcriptBoundary: { status: "unknown", sourceRangeRef: null },
          transcriptSupplement: {
            source: "rudder_run_log",
            completeness: "complete",
            eventCount: 3,
            truncated: false,
            writeFailed: false,
          },
        },
      });
      const runLogText = runLogs.join("");
      expect(runLogText).toContain('"event":"message.start"');
      expect(runLogText).toContain('"event":"message.complete"');
      expect(runLogText).toContain('"event":"session.info"');
      expect(runLogText).not.toContain("foreign-writer");
      expect(result.resultJson).not.toHaveProperty("events");
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(!pythonCommand)("attributes an accepted Product Gateway turn to the fenced native SessionDB row interval", async () => {
    const fixture = await makeProfile();
    try {
      const sessionId = "hermes-product-session";
      await fs.writeFile(path.join(fixture.profile.hermesHome, "config.yaml"), JSON.stringify({ model: "local-test" }), { mode: 0o600 });
      await addJsonYamlFixture(fixture.profile);
      execFileSync(pythonCommand!, ["-c", HISTORY_FENCE_SEED_SCRIPT, path.join(fixture.profile.hermesHome, "state.db"), sessionId], {
        encoding: "utf8",
      });
      const profile = { ...fixture.profile, hermesPythonCommand: pythonCommand! };
      const order: string[] = [];
      let historyReadCount = 0;
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => {
        order.push(historyReadCount++ === 0 ? "before-history-tail" : "after-history-tail");
        const tailRowId = historyReadCount === 1
          ? 40
          : Number(execFileSync(pythonCommand!, [
            "-c",
            HISTORY_FENCE_READ_TAIL_SCRIPT,
            path.join(profile.hermesHome, "state.db"),
            sessionId,
          ], { encoding: "utf8" }).trim());
        return { availability: "available", tailRowId, relation: "none", successorSessionId: null };
      };
      let interleavedWriterResult: string | null = null;
      let nativePromptWriteResult: string | null = null;
      let overlayHome: string | null = null;
      const gateway = mockGateway(async (method, _params, emit) => {
        if (method !== "prompt.submit") return undefined;
        order.push("prompt-submit");
        interleavedWriterResult = execFileSync(pythonCommand!, [
          "-c",
          HISTORY_FENCE_INSERT_SCRIPT,
          path.join(profile.hermesHome, "state.db"),
          sessionId,
          "41",
        ], { encoding: "utf8" }).trim();
        if (!overlayHome) throw new Error("Hermes Run overlay was not created");
        const registryPath = path.join(overlayHome, "runtime", "active_sessions.json");
        await fs.writeFile(registryPath, JSON.stringify({ entries: [{
          lease_id: "test-lease",
          session_id: sessionId,
          surface: "desktop",
          pid: process.pid,
          metadata: { live_session_id: "hermes-product-runtime-1" },
        }] }), "utf8");
        await new Promise((resolve) => setTimeout(resolve, 50));
        nativePromptWriteResult = execFileSync(pythonCommand!, [
          "-c",
          HISTORY_FENCE_INSERT_SCRIPT,
          path.join(profile.hermesHome, "state.db"),
          sessionId,
          "44",
        ], { encoding: "utf8" }).trim();
        emit("message.start");
        emitTurnComplete(emit);
        return { status: "streaming" };
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(profile, async (input) => {
          overlayHome = input.profile.env?.HERMES_HOME ?? null;
          return gateway.createClient(input);
        }, readHistoryTail, {
          acquireHistoryFence: undefined,
        }),
        rudderMcp: {
          command: { command: process.execPath, args: ["mcp-server"], provenance: "repo" },
          identity: {
            RUDDER_API_URL: "http://127.0.0.1:3100",
            RUDDER_API_KEY: "run-scoped-fence-secret",
            RUDDER_ORG_ID: "org-fence-test",
            RUDDER_AGENT_ID: "agent-fence-test",
            RUDDER_RUN_ID: "run-fence-test",
          },
        },
      });

      const expectedRangeRef = JSON.stringify({
        version: 1,
        status: "exact",
        sessionId,
        startExclusive: 40,
        endInclusive: 44,
      });
      expect(result).toMatchObject({
        exitCode: 0,
        resultJson: {
          transcriptBoundary: {
            status: "exact",
            sessionId,
            startExclusive: 40,
            endInclusive: 44,
            sourceRangeRef: expectedRangeRef,
          },
          executionRef: `hermes:db:${sessionId}:44`,
        },
      });
      expect(hasConfirmedNativeWriterQuiescence(result)).toBe(true);
      expect(overlayHome).toBeTruthy();
      expect(await fs.stat(overlayHome!).catch(() => null)).toBeNull();
      expect(await fs.readFile(path.join(profile.hermesHome, "runtime", "active_sessions.json"), "utf8"))
        .toContain(sessionId);
      expect(await fs.readdir(profile.hermesHome)).not.toContain("rudder_product_rpc_bootstrap.py");
      expect(interleavedWriterResult).toBe("blocked");
      expect(nativePromptWriteResult).toBe("inserted");
      expect(order).toEqual(["before-history-tail", "prompt-submit", "after-history-tail"]);
      expect(execFileSync(pythonCommand!, [
        "-c",
        HISTORY_FENCE_INSERT_SCRIPT,
        path.join(profile.hermesHome, "state.db"),
        sessionId,
        "45",
      ], { encoding: "utf8" }).trim()).toBe("inserted");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a Run span unknown and submission indeterminate when prompt acceptance is unknown", async () => {
    const fixture = await makeProfile();
    try {
      const tails = [40, 44];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => ({
        availability: "available",
        tailRowId: tails.shift() ?? null,
        relation: "none",
        successorSessionId: null,
      });
      const gateway = mockGateway((method) => method === "prompt.submit" ? { status: "unknown" } : undefined);

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        submissionPhase: "indeterminate",
        errorMessage: expect.stringContaining("unexpected status unknown"),
        resultJson: {
          transcriptBoundary: { status: "unknown", sourceRangeRef: null },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the exact row interval unknown when native prompt acceptance is not proven", () => {
    const boundary = deriveHermesProductRpcTranscriptBoundary({
      sessionId: "hermes-product-session",
      historyProfileAvailable: true,
      before: { availability: "available", tailRowId: 40, relation: "none", successorSessionId: null },
      after: { availability: "available", tailRowId: 44, relation: "none", successorSessionId: null },
      lockedTailRowId: 40,
      historyFenceHeldThroughLease: true,
      promptAcceptanceProven: false,
    });

    expect(boundary).toMatchObject({
      status: "unknown",
      startExclusive: null,
      endInclusive: null,
      sourceRangeRef: null,
      reason: "Hermes Product Gateway did not positively acknowledge this prompt as an active streaming turn.",
    });
  });

  it.each([
    ["false", { per_session_exclusive_submit: false }],
    ["missing", {}],
  ])("refuses Product RPC ownership when per_session_exclusive_submit is %s", async (_case, capabilities) => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method) => method === "gateway.capabilities" ? capabilities : undefined);

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorMessage: expect.stringContaining("per_session_exclusive_submit=true"),
      });
      expect(gateway.calls.some(({ method }) => ["session.create", "session.resume", "prompt.submit"].includes(method))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["no new history rows", [40, 40]],
    ["no trustworthy pre-prompt snapshot", [null, 44]],
  ] as const)("does not claim a complete transcript boundary for %s", async (_case, tails) => {
    const fixture = await makeProfile();
    try {
      const historyTails = [...tails];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => {
        const tailRowId = historyTails.shift();
        return tailRowId === null || tailRowId === undefined
          ? null
          : { availability: "available", tailRowId, relation: "none", successorSessionId: null };
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      expect(result).toMatchObject({
        exitCode: 0,
      });
      expect(result.resultJson).toMatchObject({
        transcriptBoundary: { status: "unknown", sourceRangeRef: null },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a provider-failed execution failed while its persisted span remains unknown", async () => {
    const fixture = await makeProfile();
    try {
      const tails = [40, 42];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => ({
        availability: "available",
        tailRowId: tails.shift() ?? null,
        relation: "none",
        successorSessionId: null,
      });
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("message.complete", { text: "", status: "error", error: "provider rejected the turn" });
          emit("session.info", { running: false });
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_turn_failed",
        resultJson: { transcriptBoundary: { status: "unknown", sourceRangeRef: null } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not mark a settled turn complete when Hermes returned no assistant text", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("message.complete", { text: "  ", status: "complete" });
          emit("session.info", { running: false });
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_empty_output",
        resultJson: { transcriptBoundary: { status: "unknown", sourceRangeRef: null } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to submit a fresh turn without Hermes' persisted session key", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method) => method === "session.create"
        ? { session_id: "hermes-product-runtime-1" }
        : undefined);
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorMessage: "Hermes Product Gateway session.create returned no persisted stored_session_id.",
      });
      expect(gateway.calls.some(({ method }) => method === "prompt.submit")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("resumes only a session pinned to the same Product Gateway profile", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });
      const sessionParams = buildHermesProductRpcSessionParams({
        sessionId: "hermes-product-session",
        profile: fixture.profile,
      });
      const resumed = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        sessionId: "hermes-product-session",
        sessionParams,
      });

      expect(resumed).toMatchObject({ exitCode: 0, sessionId: "hermes-product-session" });
      expect(gateway.calls.find(({ method }) => method === "session.resume")?.params).toEqual({
        session_id: "hermes-product-session",
        lazy: true,
      });
      expect(gateway.calls.some(({ method }) => method === "session.info")).toBe(false);
      expect(gateway.calls.find(({ method }) => method === "prompt.submit")?.params).toMatchObject({
        session_id: "hermes-product-runtime-resumed",
      });
      expect(resumed.resultJson).toMatchObject({
        transcriptBoundary: { status: "unknown", sessionId: "hermes-product-session", sourceRangeRef: null },
      });

      const otherGateway = mockGateway();
      const rejected = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, otherGateway.createClient),
        sessionId: "hermes-product-session",
        sessionParams: { ...sessionParams, transport: "hermes-acp-stdio" },
      });
      expect(rejected.errorMessage).toContain("transport is not the Product Gateway");
      expect(otherGateway.calls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { name: "running", running: true, expectedMessage: "session is already running" },
    { name: "unknown running state", expectedMessage: "did not report the session running state" },
  ])("does not submit a resumed turn when Gateway reports $name", async ({ running, expectedMessage }) => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, params) => method === "session.resume"
        ? {
          session_id: "hermes-product-runtime-resumed",
          session_key: params.session_id,
          ...(running === undefined ? {} : { running }),
        }
        : undefined);
      const sessionParams = buildHermesProductRpcSessionParams({
        sessionId: "hermes-product-session",
        profile: fixture.profile,
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        sessionId: "hermes-product-session",
        sessionParams,
      });

      expect(result.errorMessage).toContain(expectedMessage);
      expect(gateway.calls.some(({ method }) => method === "prompt.submit")).toBe(false);
      expect(gateway.calls.some(({ method }) => method === "session.info")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("bridges clarify answers without exposing them", async () => {
    const fixture = await makeProfile();
    try {
      let clarification: AgentRuntimeApprovalRequest | null = null;
      const logs: string[] = [];
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("clarify.request", {
            request_id: "clarify-provider-21",
            questions: [{ qid: "provider-q1", question: "Which mode?", choices: ["fast", "safe"] }],
          });
          return { status: "streaming" };
        }
        if (method === "clarify.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestApproval: async (request) => {
          clarification = request;
          return { id: "rudder-clarify-21", status: "pending" };
        },
        waitForApproval: async (id) => ({
          id,
          status: "approved",
          inputResponse: { answers: [{ questionId: "hermes_clarify_1", optionIds: ["hermes_clarify_1_option_2"], freeformText: "Keep cache off" }] },
        } satisfies AgentRuntimeApprovalDecision),
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });

      expect(result).toMatchObject({
        exitCode: 0,
        resultJson: { interactions: { clarificationStatus: "resolved" } },
      });
      expect(clarification).toMatchObject({ payload: { interactionKind: "clarify" } });
      expect(gateway.calls.find(({ method }) => method === "clarify.respond")?.params).toMatchObject({
        session_id: "hermes-product-runtime-1",
        request_id: "clarify-provider-21",
        question_id: "provider-q1",
        answer: "safe\nKeep cache off",
      });
      expect(logs.join("\n")).not.toContain("Keep cache off");
    } finally {
      await fixture.cleanup();
    }
  });

  it("sends provided secret and sudo values through the transient channel and redacts echoes", async () => {
    const fixture = await makeProfile();
    try {
      for (const interaction of [
        { kind: "secret" as const, event: "secret.request", method: "secret.respond", field: "value", requestId: "secret-provider-provided" },
        { kind: "sudo" as const, event: "sudo.request", method: "sudo.respond", field: "password", requestId: "sudo-provider-provided" },
      ]) {
        const secretValue = `transient-hermes-${interaction.kind}-private-value`;
        const logs: string[] = [];
        const transientRequests: Array<{ kind: "secret" | "sudo" }> = [];
        const gateway = mockGateway((method, params, emit) => {
          if (method === "prompt.submit") {
            emit("message.start");
            emit(interaction.event, {
              request_id: interaction.requestId,
              prompt: "Enter a private value",
              env_var: "PRIVATE_VALUE",
              value: secretValue,
              password: secretValue,
              nested: { bearerToken: secretValue },
            });
            return { status: "streaming" };
          }
          if (method === interaction.method) {
            expect(params).toEqual({ request_id: interaction.requestId, [interaction.field]: secretValue });
            emit("message.complete", { text: secretValue, status: "complete", model: "hermes-test-model" });
            emit("session.info", { running: false, model: "hermes-test-model" });
            return { status: "ok" };
          }
          return undefined;
        });

        const result = await executeHermesProductRpcChat({
          ...runInput(fixture.profile, gateway.createClient),
          requestTransientInput: async (request) => {
            transientRequests.push(request);
            return { status: "provided", value: secretValue };
          },
          onLog: async (_stream, chunk) => { logs.push(chunk); },
        });

        expect(transientRequests).toEqual([{ kind: interaction.kind }]);
        expect(result).toMatchObject({
          exitCode: 0,
          summary: "[REDACTED]",
          resultJson: {
            interactions: {
              sensitiveInputCancelled: false,
              sensitiveInputStatuses: [{ kind: interaction.kind, status: "provided" }],
              sensitiveInputError: null,
            },
          },
        });
        expect(JSON.stringify(result)).not.toContain(secretValue);
        expect(logs.join("\n")).not.toContain(secretValue);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("explains cancelled, timed out, aborted, and empty transient input", async () => {
    const fixture = await makeProfile();
    try {
      const scenarios = [
        { name: "cancelled", result: { status: "cancelled" as const }, expectedStatus: "cancelled", message: "cancelled" },
        { name: "timed_out", result: { status: "timed_out" as const }, expectedStatus: "timed_out", message: "timed out" },
        { name: "aborted", result: { status: "aborted" as const }, expectedStatus: "aborted", message: "interrupted" },
        { name: "empty", result: { status: "provided" as const, value: "" }, expectedStatus: "cancelled", message: "No value was provided" },
      ];
      for (const interaction of [
        { kind: "secret" as const, event: "secret.request", method: "secret.respond", field: "value" },
        { kind: "sudo" as const, event: "sudo.request", method: "sudo.respond", field: "password" },
      ]) {
        for (const scenario of scenarios) {
          const requestId = `${interaction.kind}-provider-${scenario.name}`;
          const eventSecret = `event-${interaction.kind}-${scenario.name}-private-value`;
          const logs: string[] = [];
          const gateway = mockGateway((method, params, emit) => {
            if (method === "prompt.submit") {
              emit("message.start");
              emit(interaction.event, { request_id: requestId, value: eventSecret, password: eventSecret });
              return { status: "streaming" };
            }
            if (method === interaction.method) {
              expect(params).toEqual({ request_id: requestId, [interaction.field]: "" });
              emitTurnComplete(emit);
              return { status: "ok" };
            }
            return undefined;
          });
          const result = await executeHermesProductRpcChat({
            ...runInput(fixture.profile, gateway.createClient),
            requestTransientInput: async () => scenario.result,
            onLog: async (_stream, chunk) => { logs.push(chunk); },
          });

          expect(result).toMatchObject({
            exitCode: 1,
            errorCode: `hermes_product_rpc_sensitive_input_${scenario.expectedStatus}`,
            resultJson: {
              interactions: {
                sensitiveInputCancelled: true,
                sensitiveInputStatuses: [{ kind: interaction.kind, status: scenario.expectedStatus }],
              },
            },
          });
          expect(result.errorMessage).toContain(scenario.message);
          expect(JSON.stringify(result)).not.toContain(eventSecret);
          expect(logs.join("\n")).not.toContain(eventSecret);
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("sends a secret cancellation before interrupting an aborted turn", async () => {
    const fixture = await makeProfile();
    try {
      const controller = new AbortController();
      const requestId = "secret-provider-aborted-run";
      const gateway = mockGateway((method, params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("secret.request", { request_id: requestId });
          return { status: "streaming" };
        }
        if (method === "secret.respond") {
          expect(params).toEqual({ request_id: requestId, value: "" });
          emitTurnComplete(emit, "interrupted");
          return { status: "ok" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        signal: controller.signal,
        requestTransientInput: async () => {
          setTimeout(() => controller.abort(), 0);
          return new Promise(() => {});
        },
      });

      expect(gateway.calls.find(({ method }) => method === "secret.respond")?.params).toEqual({
        request_id: requestId,
        value: "",
      });
      expect(gateway.calls.some(({ method }) => method === "session.interrupt")).toBe(true);
      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_sensitive_input_aborted",
        errorMessage: expect.stringContaining("was interrupted; no value was sent"),
        resultJson: { interactions: { sensitiveInputStatuses: [{ kind: "secret", status: "aborted" }] } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("discards a transient value that arrives after Hermes expires the request", async () => {
    const fixture = await makeProfile();
    try {
      const lateValue = "late-hermes-secret-must-never-be-sent";
      const requestId = "secret-provider-expired";
      const logs: string[] = [];
      const transient = { resolve: null as ((result: { status: "provided"; value: string }) => void) | null };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("secret.request", { request_id: requestId });
          queueMicrotask(() => {
            emit("secret.expire", { request_id: requestId });
            emitTurnComplete(emit);
          });
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestTransientInput: async () => new Promise((resolve) => { transient.resolve = resolve; }),
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });
      transient.resolve?.({ status: "provided", value: lateValue });
      await new Promise((resolve) => setImmediate(resolve));

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_sensitive_input_timed_out",
        errorMessage: expect.stringContaining("any late value was discarded"),
        resultJson: { interactions: { sensitiveInputStatuses: [{ kind: "secret", status: "timed_out" }] } },
      });
      expect(gateway.calls.some(({ method }) => method === "secret.respond")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(lateValue);
      expect(logs.join("\n")).not.toContain(lateValue);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when clarification input exceeds the Host contract", async () => {
    const fixture = await makeProfile();
    try {
      const requestApproval = vi.fn(async () => ({ id: "rudder-clarify-oversized", status: "pending" }));
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("clarify.request", {
            request_id: "clarify-provider-oversized",
            questions: Array.from({ length: 5 }, (_value, index) => ({
              qid: `provider-q${index + 1}`,
              question: `Question ${index + 1}?`,
              choices: ["one", "two"],
            })),
          });
          return { status: "streaming" };
        }
        if (method === "clarify.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestApproval,
        waitForApproval: async (id) => ({ id, status: "approved" }),
      });

      expect(requestApproval).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_interaction_unresolved",
        resultJson: { interactions: { clarificationStatus: "unavailable" } },
      });
      expect(gateway.calls.find(({ method }) => method === "clarify.respond")?.params).toMatchObject({ answer: "" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not claim secret cancellation when Hermes rejects the empty response", async () => {
    const fixture = await makeProfile();
    try {
      const secretValue = "private-sudo-password-value";
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("sudo.request", { request_id: "sudo-provider-reject", password: secretValue });
          return { status: "streaming" };
        }
        if (method === "sudo.respond") {
          emitTurnComplete(emit);
          return { status: "error" };
        }
        return undefined;
      });
      const logs: string[] = [];

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_sensitive_input_cancel_unverified",
        resultJson: {
          interactions: {
            sensitiveInputCancelled: false,
            sensitiveInputCancellationFailed: true,
            sensitiveInputKinds: ["sudo"],
            sensitiveInputStatuses: [{ kind: "sudo", status: "failed" }],
          },
        },
        errorMessage: expect.stringContaining("could not confirm cancellation"),
      });
      expect(JSON.stringify({ result, calls: gateway.calls, logs })).not.toContain(secretValue);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not report a clarification as successful when Host input is absent, pending, or declined", async () => {
    const fixture = await makeProfile();
    try {
      for (const scenario of [
        { name: "absent", provideCallbacks: false, decisionStatus: "pending", expectedStatus: "unavailable" },
        { name: "pending", provideCallbacks: true, decisionStatus: "pending", expectedStatus: "unresolved" },
        { name: "declined", provideCallbacks: true, decisionStatus: "rejected", expectedStatus: "cancelled" },
      ] as const) {
        const gateway = mockGateway((method, _params, emit) => {
          if (method === "prompt.submit") {
            emit("message.start");
            emit("clarify.request", {
              request_id: `clarify-${scenario.name}`,
              questions: [{ qid: "provider-q1", question: "Choose?", choices: ["one", "two"] }],
            });
            return { status: "streaming" };
          }
          if (method === "clarify.respond") {
            emitTurnComplete(emit);
            return { status: "ok" };
          }
          return undefined;
        });
        const interactionCallbacks = scenario.provideCallbacks ? {
          requestApproval: async () => ({ id: `rudder-${scenario.name}`, status: "pending" }),
          waitForApproval: async (id: string) => ({ id, status: scenario.decisionStatus }) as AgentRuntimeApprovalDecision,
        } : {};
        const result = await executeHermesProductRpcChat({
          ...runInput(fixture.profile, gateway.createClient),
          ...interactionCallbacks,
        });

        expect(result).toMatchObject({
          exitCode: 1,
          errorCode: "hermes_product_rpc_interaction_unresolved",
          resultJson: { interactions: { clarificationStatus: scenario.expectedStatus } },
        });
        expect(gateway.calls.find(({ method }) => method === "clarify.respond")?.params).toMatchObject({ answer: "" });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("never turns freeform approval input into an arbitrary Hermes permission choice", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("approval.request", {
            request_id: "approval-provider-freeform",
            description: "Run this command?",
            choices: ["once", "deny"],
          });
          return { status: "streaming" };
        }
        if (method === "approval.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestApproval: async () => ({ id: "rudder-approval-freeform", status: "pending" }),
        waitForApproval: async (id) => ({
          id,
          status: "approved",
          inputResponse: { answers: [{ questionId: "hermes_product_approval", optionIds: [], freeformText: "always" }] },
        } satisfies AgentRuntimeApprovalDecision),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_approval_unresolved",
        resultJson: { interactions: { approvalStatus: "denied" } },
      });
      expect(gateway.calls.find(({ method }) => method === "approval.respond")?.params).toMatchObject({ choice: "deny" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses native redirect and waits for terminal state after Stop", async () => {
    const fixture = await makeProfile();
    try {
      let publishHandle!: (handle: AgentRuntimeControlHandle) => void;
      let markStarted!: () => void;
      const handleReady = new Promise<AgentRuntimeControlHandle>((resolve) => { publishHandle = resolve; });
      const promptStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      const controlAttempt: AgentRuntimeControlAttemptLease = {
        attemptEpoch: 1,
        ownerToken: "hermes-product-rpc-test",
        async register(handle) {
          publishHandle(handle);
          return { isCurrent: () => true, release: async () => handle.dispose() };
        },
        async complete() {},
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          markStarted();
          return { status: "streaming" };
        }
        if (method === "session.interrupt") {
          setTimeout(() => emitTurnComplete(emit, "interrupted"), 0);
          return { status: "interrupted" };
        }
        return undefined;
      });
      const execution = executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        controlAttempt,
      });
      const handle = await handleReady;
      await promptStarted;

      await expect(handle.steer({ text: "Focus on the failing test.", clientMessageId: "message-1" })).resolves.toMatchObject({
        disposition: "accepted_current",
        providerThreadId: "hermes-product-session",
      });
      await expect(handle.interrupt("operator_stop")).resolves.toBe("waiting_safe_boundary");
      const result = await execution;

      expect(gateway.calls.find(({ method }) => method === "session.redirect")?.params).toEqual({
        session_id: "hermes-product-runtime-1",
        text: "Focus on the failing test.",
      });
      expect(result).toMatchObject({
        exitCode: 1,
        signal: "SIGTERM",
        errorCode: "hermes_product_rpc_interrupted",
        resultJson: { control: { interruptRequested: true, stopConfirmed: true } },
        nativeWriterQuiescence: { status: "confirmed", source: "provider_stop_ack" },
      });
      expect(hasConfirmedNativeWriterQuiescence(result)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not report Stop confirmed when interrupt is acknowledged but the timed-out turn never settles", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          return { status: "streaming" };
        }
        if (method === "session.interrupt") return { status: "interrupted" };
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        timeoutMs: 25,
      });

      expect(result).toMatchObject({
        exitCode: 1,
        timedOut: true,
        errorCode: "hermes_product_rpc_cancel_unverified",
        nativeWriterQuiescence: { status: "unconfirmed", reason: expect.any(String) },
        resultJson: {
          transcriptBoundary: { status: "unknown", sourceRangeRef: null },
          transcriptSupplement: { completeness: "partial", eventCount: 1 },
          control: { interruptRequested: true, stopConfirmed: false },
        },
      });
      expect(hasConfirmedNativeWriterQuiescence(result)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not label a normally completed turn interrupted when Stop was only requested", async () => {
    const fixture = await makeProfile();
    const controller = new AbortController();
    try {
      let markPromptStarted!: () => void;
      const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          markPromptStarted();
          return { status: "streaming" };
        }
        if (method === "session.interrupt") {
          setTimeout(() => emitTurnComplete(emit, "complete"), 0);
          return { status: "interrupted" };
        }
        return undefined;
      });

      const execution = executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        signal: controller.signal,
      });
      await promptStarted;
      controller.abort();
      const result = await execution;

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_cancel_unverified",
        errorMessage: expect.stringContaining("stop was requested but not confirmed"),
        resultJson: {
          providerStatus: "complete",
          control: { interruptRequested: true, stopConfirmed: false },
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not close the Gateway immediately when the execution is aborted", async () => {
    const fixture = await makeProfile();
    try {
      const controller = new AbortController();
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          return { status: "streaming" };
        }
        if (method === "session.interrupt") {
          setTimeout(() => emitTurnComplete(emit, "interrupted"), 0);
          return { status: "interrupted" };
        }
        return undefined;
      });
      const resultPromise = executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(gateway.calls.some(({ method }) => method === "prompt.submit")).toBe(true));
      controller.abort();
      const result = await resultPromise;

      expect(result).toMatchObject({
        exitCode: 1,
        signal: "SIGTERM",
        errorCode: "hermes_product_rpc_interrupted",
      });
      expect(gateway.timeline.indexOf("session.interrupt")).toBeLessThan(gateway.timeline.indexOf("close"));
      expect(gateway.timeline.indexOf("session.info")).toBeLessThan(gateway.timeline.indexOf("close"));
    } finally {
      await fixture.cleanup();
    }
  });
});

installedHermes021ProductRpcDescribe("installed Hermes 0.21 Product Gateway bootstrap", () => {
  it("keeps gateway.ready responsive during cold MCP discovery and withholds the prompt until typed tools register", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-021-ready-probe-"));
    const home = path.join(root, "home");
    const stubPath = path.join(root, "stdio-mcp-stub.cjs");
    const pidPath = path.join(root, "stdio-mcp-stub-pid.json");
    const startedPath = path.join(root, "discovery-started.json");
    const releasePath = path.join(root, "release-discovery");
    const stopPath = path.join(root, "stop-stub");
    const nonce = `${process.pid}-${Date.now()}`;
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(stubPath, String.raw`
const fs = require("node:fs");
const pidPath = process.argv[2];
const startedPath = process.argv[3];
const releasePath = process.argv[4];
const stopPath = process.argv[5];
const nonce = process.argv[6];
let buffer = "";
fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function exitWhenStopped() { if (fs.existsSync(stopPath)) process.exit(0); }
setInterval(exitWhenStopped, 25).unref();
process.on("SIGTERM", () => process.exit(0));
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ id: request.id, result: {
        protocolVersion: request.params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rudder-stdio-ready-probe", version: "1" }
      }});
    } else if (request.method === "tools/list") {
      fs.writeFileSync(startedPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce }), { mode: 0o600 });
      const poll = setInterval(() => {
        if (fs.existsSync(releasePath)) {
          clearInterval(poll);
          send({ id: request.id, result: { tools: [
            { name: "rudder_agent_me", description: "Probe only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
            { name: "rudder_probe", description: "Probe only", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
          ] }});
        } else {
          exitWhenStopped();
        }
      }, 25);
    } else if (request.method === "ping") {
      send({ id: request.id, result: {} });
    }
  }
});
`, { mode: 0o600 });

    const profile: HermesProductRpcProfile = {
      binding: { hostId: "host-hermes-021-ready-probe", profileId: "profile-hermes-021-ready-probe" },
      command: installedHermes021PythonCommand!,
      args: [],
      cwd: root,
      hermesPythonCommand: installedHermes021PythonCommand!,
      hermesSourcePath: installedHermes021SourcePath!,
      hermesHome: home,
      providerVersion: "0.21.0",
    };
    const controller = new AbortController();
    const requestMethods: string[] = [];
    const wireMethods: string[] = [];
    let readyReceiptPath: string | null = null;
    let launchHermesHome: string | null = null;
    let gatewayReadyObserved = false;
    let promptWasInterceptedAfterReady = false;
    const probeState: {
      nativeClient: Awaited<ReturnType<typeof createHermesNativeRpcClient>> | null;
      executionOutcome: { status: "resolved" | "rejected"; message: string } | null;
    } = { nativeClient: null, executionOutcome: null };
    let execution: ReturnType<typeof executeHermesProductRpcChat> | null = null;
    const createClient: HermesProductRpcClientFactory = async (input) => {
      readyReceiptPath = input.profile.env?.[HERMES_PRODUCT_RPC_MCP_READY_PATH_ENV] ?? null;
      launchHermesHome = input.profile.env?.HERMES_HOME ?? null;
      const activeNativeClient = await createHermesNativeRpcClient(
        input.profile,
        (method, params) => {
          if (method === "event" && params.type === "gateway.ready") gatewayReadyObserved = true;
          input.onNotification(method, params);
        },
        async () => ({}),
        input.onSpawn,
      );
      probeState.nativeClient = activeNativeClient;
      return {
        processExit: activeNativeClient.processExit,
        getProcessDiagnostics: () => activeNativeClient.getProcessDiagnostics(),
        close: () => activeNativeClient.close(),
        async request(method, params, timeoutMs) {
          requestMethods.push(method);
          if (method === "session.create") {
            return { session_id: "installed-ready-probe-session", stored_session_id: "installed-ready-probe-native-session" };
          }
          if (method === "prompt.submit") {
            const receipt = readyReceiptPath ? JSON.parse(await fs.readFile(readyReceiptPath, "utf8")) as Record<string, unknown> : null;
            const names = Array.isArray(receipt?.toolNames) ? receipt.toolNames : [];
            promptWasInterceptedAfterReady = receipt?.status === "ready"
              && names.includes("mcp__rudder_tools__rudder_agent_me");
            throw new Error("Installed Hermes probe blocked prompt.submit before native transport; model call count remains zero.");
          }
          wireMethods.push(method);
          return activeNativeClient.request(method, params, timeoutMs);
        },
      };
    };

    try {
      execution = executeHermesProductRpcChat({
        ...runInput(profile, createClient, async () => ({
          availability: "missing",
          tailRowId: null,
          relation: "unknown",
          successorSessionId: null,
        }), { waitForSessionLease: async () => false }),
        timeoutMs: 45_000,
        signal: controller.signal,
        rudderMcp: {
          command: {
            command: process.execPath,
            args: [stubPath, pidPath, startedPath, releasePath, stopPath, nonce],
            provenance: "repo",
          },
          identity: {
            RUDDER_API_URL: "http://127.0.0.1:1",
            RUDDER_API_KEY: "installed-hermes-probe-only-token",
            RUDDER_ORG_ID: "org-installed-ready-probe",
            RUDDER_AGENT_ID: "agent-installed-ready-probe",
            RUDDER_RUN_ID: "run-installed-ready-probe",
          },
        },
      });
      void execution.then(
        (result) => { probeState.executionOutcome = { status: "resolved", message: result.errorMessage ?? `exitCode=${result.exitCode}` }; },
        (error: unknown) => { probeState.executionOutcome = { status: "rejected", message: error instanceof Error ? error.message : String(error) }; },
      );

      const markerDeadline = Date.now() + 20_000;
      let marker: { pid: number; startedAt: number; nonce: string } | null = null;
      while (Date.now() < markerDeadline) {
        const contents = await fs.readFile(startedPath, "utf8").catch(() => null);
        if (contents) {
          marker = JSON.parse(contents) as { pid: number; startedAt: number; nonce: string };
          break;
        }
        if (probeState.executionOutcome) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!marker) {
        const child = await fs.readFile(pidPath, "utf8").catch(() => "");
        const diagnostics = probeState.nativeClient?.getProcessDiagnostics();
        throw new Error([
          "Installed Hermes MCP discovery did not reach tools/list.",
          `gateway_ready=${gatewayReadyObserved}`,
          `wire_methods=${wireMethods.join(",") || "none"}`,
          `stub_pid=${child ? String((JSON.parse(child) as { pid?: number }).pid ?? "unknown") : "not_started"}`,
          `execution=${probeState.executionOutcome?.status ?? "pending"}${probeState.executionOutcome ? `:${probeState.executionOutcome.message}` : ""}`,
          `exit=${diagnostics?.exitCode ?? "pending"}`,
          `close_ack=${diagnostics?.closeAcknowledged ? "confirmed" : "unknown"}`,
          `stderr=${diagnostics?.stderr ?? ""}`,
        ].join("; "));
      }
      expect(marker.nonce).toBe(nonce);
      await new Promise((resolve) => setTimeout(resolve, 10_100));
      expect(Date.now() - marker.startedAt).toBeGreaterThanOrEqual(10_000);
      expect(gatewayReadyObserved).toBe(true);
      expect(wireMethods).toEqual(["ping", "gateway.capabilities"]);
      expect(requestMethods).toEqual(["ping", "gateway.capabilities"]);

      await fs.writeFile(releasePath, "release");
      const receipt = await vi.waitFor(async () => {
        if (!readyReceiptPath) throw new Error("Rudder MCP readiness receipt path was not provided to the child.");
        const value = JSON.parse(await fs.readFile(readyReceiptPath, "utf8")) as Record<string, unknown>;
        if (value.status !== "ready") throw new Error("typed Rudder MCP tools have not reached ready state");
        return value;
      }, { timeout: 20_000 });
      expect(receipt.toolNames).toEqual([
        "mcp__rudder_tools__rudder_agent_me",
        "mcp__rudder_tools__rudder_probe",
      ]);

      const result = await execution;
      expect(result).toMatchObject({ exitCode: 1, submissionPhase: "indeterminate" });
      expect(result.errorMessage).toContain("model call count remains zero");
      expect(requestMethods).toEqual(["ping", "gateway.capabilities", "session.create", "prompt.submit"]);
      expect(wireMethods).toEqual(["ping", "gateway.capabilities"]);
      expect(promptWasInterceptedAfterReady).toBe(true);
      expect(probeState.nativeClient?.getProcessDiagnostics().closeAcknowledged).toBe(true);
      expect(launchHermesHome).toBeTruthy();
      await expect(fs.access(launchHermesHome!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      await fs.writeFile(releasePath, "release").catch(() => {});
      await fs.writeFile(stopPath, "stop").catch(() => {});
      await probeState.nativeClient?.close().catch(() => {});
      await execution?.catch(() => undefined);
      const markerContents = await fs.readFile(pidPath, "utf8").catch(() => "");
      if (markerContents) {
        const marker = JSON.parse(markerContents) as { pid: number; nonce: string };
        expect(marker.nonce).toBe(nonce);
        const pid = Number(marker.pid);
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 70_000);
});
