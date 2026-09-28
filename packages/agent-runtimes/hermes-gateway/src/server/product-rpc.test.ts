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
import {
  buildHermesProductRpcSessionParams,
  deriveHermesProductRpcTranscriptBoundary,
  executeHermesProductRpcChat,
  forkHermesProductRpcNativeSession,
  HERMES_PRODUCT_RPC_TRANSPORT,
  HermesProductRpcForkError,
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
  "        return [], display",
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
  "db.create_session('hermes-fork-parent', source='acp', model='fixture-model', model_config={}, cwd=str(home), profile_name=home.name)",
  "db.set_session_title('hermes-fork-parent', 'native chat')",
  "db.append_messages_batch('hermes-fork-parent', [",
  "    {'role': 'user', 'content': 'first question', 'timestamp': 1},",
  "    {'role': 'assistant', 'content': 'first answer', 'timestamp': 2, 'finish_reason': 'stop', 'reasoning': 'kept'},",
  "    {'role': 'tool', 'content': 'tool result', 'timestamp': 3},",
  "    {'role': 'user', 'content': 'second question', 'timestamp': 4},",
  "    {'role': 'assistant', 'content': 'selected answer', 'timestamp': 5, 'finish_reason': 'stop'},",
  "    {'role': 'assistant', 'content': 'later answer', 'timestamp': 6, 'finish_reason': 'stop'},",
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

const INSTALLED_HERMES_SEED_SCRIPT = [
  "import os",
  "from pathlib import Path",
  "from hermes_cli import __version__",
  "from hermes_state import SessionDB",
  "assert __version__ == '0.21.0', __version__",
  "home = Path(os.environ['HERMES_HOME'])",
  "db = SessionDB(db_path=home / 'state.db')",
  "db.create_session('hermes-fork-parent', source='acp', model='integration-model', model_config={}, cwd=os.environ['RUDDER_TEST_CWD'], profile_name=home.name)",
  "db.set_session_title('hermes-fork-parent', 'native chat')",
  "db.append_messages_batch('hermes-fork-parent', [",
  "    {'role': 'user', 'content': 'first question', 'timestamp': 1},",
  "    {'role': 'assistant', 'content': 'first answer', 'timestamp': 2, 'finish_reason': 'stop'},",
  "    {'role': 'user', 'content': 'second question', 'timestamp': 3},",
  "    {'role': 'assistant', 'content': 'selected assistant boundary', 'timestamp': 4, 'finish_reason': 'stop'},",
  "    {'role': 'assistant', 'content': 'later answer', 'timestamp': 5, 'finish_reason': 'stop'},",
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
  it("copies only the visible prefix through the exact assistant row and survives a fresh SessionDB open", async () => {
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
        "hermes:db:hermes-fork-parent:4",
        sourceBoundary,
      ]);
      expect(parentAfter).toEqual(parentBefore);
      expect(child.session).toMatchObject({
        parent_session_id: "hermes-fork-parent",
        model_config: { _branched_from: "hermes-fork-parent" },
        title: "native chat (branch)",
      });
      expect(child.rows.map((row) => row.content)).toEqual([
        "first question",
        "first answer",
        "second question",
        "selected answer",
      ]);
      expect(child.rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(child.rows.map((row) => "hermes:db:" + result.session.sessionId + ":" + row._row_id)).toEqual(
        Object.values(result.identityMap),
      );
      expect(child.rows.some((row) => row.content === "later answer")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a missing or non-assistant boundary without creating a child", async () => {
    for (const boundaryRowId of [4, 99]) {
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

  it("compensates a child when its persisted display projection fails exact copy verification", async () => {
    const fixture = await makeForkFixture("mismatch");
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
      expect(childModelConfig).toMatchObject({ _branched_from: "hermes-fork-parent" });
      expect(child.rows.map((row) => row.content)).toEqual([
        "first question",
        "first answer",
        "second question",
        "selected assistant boundary",
      ]);
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

function mockGateway(handler: GatewayHandler = () => undefined) {
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
    onNotification,
    onSpawn,
  }: {
    onNotification: (method: string, params: Record<string, unknown>) => void;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }) => {
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
  createClient: ReturnType<typeof mockGateway>["createClient"],
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
        ...runInput(profile, gateway.createClient, readHistoryTail, {
          acquireHistoryFence: undefined,
        }),
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
