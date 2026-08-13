import { StringDecoder } from "node:string_decoder";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolveNativeProcessHostPath, spawnNativeProcessHost, type NativeProcessHost } from "./local-app-native-host.js";
import { terminateOwnedProcessGroup } from "./local-apps-runtime.js";

export const TERMINAL_IPC_CHANNELS = {
  create: "desktop:terminal:create",
  input: "desktop:terminal:input",
  resize: "desktop:terminal:resize",
  close: "desktop:terminal:close",
  output: "desktop:terminal:output",
  exit: "desktop:terminal:exit",
} as const;

const MAX_SESSIONS_PER_OWNER = 8;
const MAX_REPLAY_BYTES = 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const execFileAsync = promisify(execFile);

type Renderer = {
  id?: number;
  mainFrame: unknown;
  isDestroyed?(): boolean;
  send(channel: string, payload: unknown): void;
  once?(event: "destroyed", listener: () => void): void;
};
type IpcEvent = { sender: Renderer; senderFrame: unknown };
type IpcMainLike = {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
};

export type TerminalWorkspace = { cwd: string; agentName: string };
export type TerminalWorkspaceResolver = (orgId: string, agentId: string) => Promise<TerminalWorkspace>;

type AgentWorkspaceApiRecord = { id?: unknown; orgId?: unknown; name?: unknown };
type AgentWorkspaceListing = { rootPath?: unknown; directoryPath?: unknown; rootExists?: unknown; entries?: unknown };

export function resolveTerminalWorkspaceFromApi(
  orgId: string,
  agentId: string,
  agent: AgentWorkspaceApiRecord,
  listing: AgentWorkspaceListing,
): TerminalWorkspace {
  if (agent.id !== agentId || agent.orgId !== orgId) {
    throw new Error("The selected Agent does not belong to this organization.");
  }
  if (
    listing.rootExists !== true
    || listing.directoryPath !== "agents"
    || typeof listing.rootPath !== "string"
    || !path.isAbsolute(listing.rootPath)
  ) {
    throw new Error("The Agent workspace is unavailable on this machine.");
  }
  const entry = Array.isArray(listing.entries)
    ? listing.entries.find((candidate): candidate is { agentId: string; workspaceKey: string; entityType: string } => (
      Boolean(candidate)
      && typeof candidate === "object"
      && (candidate as { agentId?: unknown }).agentId === agentId
      && (candidate as { entityType?: unknown }).entityType === "agent_workspace"
      && typeof (candidate as { workspaceKey?: unknown }).workspaceKey === "string"
    ))
    : null;
  if (!entry) throw new Error("The Agent workspace is unavailable on this machine.");
  const agentsRoot = path.resolve(listing.rootPath, "agents");
  const cwd = path.resolve(agentsRoot, entry.workspaceKey);
  const relative = path.relative(agentsRoot, cwd);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The Agent workspace could not be validated.");
  }
  return { cwd, agentName: typeof agent.name === "string" ? agent.name : "Agent" };
}

type Session = {
  id: string;
  owner: Renderer;
  host: NativeProcessHost;
  replay: Buffer;
  closed: boolean;
  cleanupProven: boolean;
  shellPid: number | null;
  exited: Promise<void>;
  resolveExited: () => void;
};
type CompletedSession = Pick<Session, "owner" | "cleanupProven" | "shellPid">;

async function terminateTerminalTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Terminal process identity is invalid");
  if (process.platform !== "win32") {
    await terminateOwnedProcessGroup(pid);
    return;
  }
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000, windowsHide: true });
}

function appendReplay(current: Buffer, data: Buffer): Buffer {
  if (data.length >= MAX_REPLAY_BYTES) return data.subarray(data.length - MAX_REPLAY_BYTES);
  const overflow = current.length + data.length - MAX_REPLAY_BYTES;
  return Buffer.concat(overflow > 0 ? [current.subarray(overflow), data] : [current, data]);
}

function decodeReplay(replay: Buffer): string {
  let offset = 0;
  while (offset < replay.length && (replay[offset] & 0xc0) === 0x80) offset += 1;
  return replay.subarray(offset).toString("utf8");
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} accepts only its documented fields`);
  }
  return object;
}

function requiredId(value: unknown, label: string, pattern = ENTITY_ID_RE): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function terminalSize(value: unknown, label: string, min: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > 1_000) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

async function defaultShell(): Promise<{ executable: string; argv: string[] }> {
  if (process.platform === "win32") {
    const candidates = [process.env.ComSpec, process.env.COMSPEC].filter((value): value is string => Boolean(value?.trim()));
    for (const candidate of candidates) {
      const executable = path.resolve(candidate);
      if ((await fs.stat(executable).catch(() => null))?.isFile()) return { executable, argv: [] };
    }
    throw new Error("The default Windows shell is unavailable.");
  }
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (!candidate?.trim() || !path.isAbsolute(candidate)) continue;
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return { executable: candidate, argv: ["-l"] };
  }
  throw new Error("The user login shell is unavailable.");
}

function inheritedTerminalEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      Object.keys(env).length < 124
      && typeof value === "string"
      && name.length <= 256
      && value.length <= 16_384
      && !name.includes("=")
      && !name.includes("\0")
      && !value.includes("\0")
    ) env[name] = value;
  }
  env.AGENT_HOME = cwd;
  env.PWD = cwd;
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  return env;
}

export function createTerminalController(options: {
  resolveWorkspace: TerminalWorkspaceResolver;
  resolveHostPath?: () => string | null;
  resolveShell?: () => Promise<{ executable: string; argv: string[] }>;
  spawnHost?: typeof spawnNativeProcessHost;
  terminateTree?: (pid: number) => Promise<void>;
}) {
  const sessions = new Map<string, Session>();
  const completedSessions = new Map<string, CompletedSession>();
  const observedOwners = new WeakSet<Renderer>();

  const ownerSessions = (owner: Renderer) => [...sessions.values()].filter((session) => session.owner === owner);
  const send = (session: Session, channel: string, payload: unknown) => {
    if (!session.owner.isDestroyed?.()) session.owner.send(channel, payload);
  };
  const proveCompletedCleanup = async (owner: Renderer, sessionId: string) => {
    const completed = completedSessions.get(sessionId);
    if (!completed || completed.owner !== owner) throw new Error("Terminal session is not owned by this renderer");
    if (!completed.cleanupProven && completed.shellPid !== null) {
      await (options.terminateTree ?? terminateTerminalTree)(completed.shellPid);
      completed.cleanupProven = true;
    }
    if (!completed.cleanupProven) throw new Error("Rudder could not verify that the Terminal process tree stopped.");
    return completed;
  };
  const close = async (owner: Renderer, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      await proveCompletedCleanup(owner, sessionId);
      completedSessions.delete(sessionId);
      return;
    }
    if (session.owner !== owner) throw new Error("Terminal session is not owned by this renderer");
    if (session.closed) return;
    session.closed = true;
    const stopSent = session.host.send({
      type: "stop",
      protocolVersion: { major: 1, minor: 0 },
      requestId: sessionId,
    });
    let exitedCleanly = await Promise.race([
      session.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exitedCleanly) {
      session.host.stdin.end();
      exitedCleanly = await Promise.race([
        session.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
    }
    let cleanupError: unknown = null;
    if (!session.cleanupProven && session.shellPid !== null) {
      try {
        await (options.terminateTree ?? terminateTerminalTree)(session.shellPid);
        session.cleanupProven = true;
      } catch (cause) {
        cleanupError = cause;
      }
    }
    if (!exitedCleanly) session.host.kill("SIGKILL");
    if (!session.cleanupProven) {
      session.closed = false;
      throw new Error(stopSent
        ? "Rudder could not verify that the Terminal process tree stopped."
        : "Rudder could not send or verify the Terminal stop request.", { cause: cleanupError });
    }
  };
  const closeOwner = async (owner: Renderer) => {
    const sessionIds = [
      ...ownerSessions(owner).map((session) => session.id),
      ...[...completedSessions].flatMap(([id, session]) => session.owner === owner ? [id] : []),
    ];
    const results = await Promise.allSettled(sessionIds.map((id) => close(owner, id)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Terminal owner cleanup could not be verified");
  };

  return {
    async create(owner: Renderer, input: unknown) {
      const payload = exactObject(input, ["orgId", "agentId", "sessionId", "cols", "rows"], "Terminal create");
      const orgId = requiredId(payload.orgId, "Organization id");
      const agentId = requiredId(payload.agentId, "Agent id");
      const sessionId = requiredId(payload.sessionId, "Terminal session id", SESSION_ID_RE);
      const cols = terminalSize(payload.cols, "Terminal columns", 2);
      const rows = terminalSize(payload.rows, "Terminal rows", 1);
      const existing = sessions.get(sessionId);
      if (existing) {
        if (existing.owner !== owner) throw new Error("Terminal session is owned by another renderer");
        return { sessionId, replay: decodeReplay(existing.replay), status: existing.closed ? "exited" : "running" };
      }
      if (ownerSessions(owner).length >= MAX_SESSIONS_PER_OWNER) throw new Error("This window already has the maximum number of Terminal sessions.");
      const completed = completedSessions.get(sessionId);
      if (completed) {
        if (completed.owner !== owner) throw new Error("Terminal session is owned by another renderer");
        await proveCompletedCleanup(owner, sessionId);
        completedSessions.delete(sessionId);
      }

      const workspace = await options.resolveWorkspace(orgId, agentId);
      const workspaceStat = await fs.stat(workspace.cwd).catch(() => null);
      if (!workspaceStat?.isDirectory()) throw new Error("The Agent workspace is unavailable on this machine.");
      const hostPath = options.resolveHostPath?.() ?? resolveNativeProcessHostPath();
      if (!hostPath || !(await fs.stat(hostPath).catch(() => null))?.isFile()) throw new Error("The native Terminal host is unavailable.");
      const shell = await (options.resolveShell ?? defaultShell)();
      const host = (options.spawnHost ?? spawnNativeProcessHost)(hostPath, { cwd: workspace.cwd, env: process.env });
      let resolveExited = () => {};
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      const session: Session = { id: sessionId, owner, host, replay: Buffer.alloc(0), closed: false, cleanupProven: false, shellPid: null, exited, resolveExited };
      let completedRecord: CompletedSession | null = null;
      sessions.set(sessionId, session);
      if (!observedOwners.has(owner)) {
        observedOwners.add(owner);
        owner.once?.("destroyed", () => {
          void closeOwner(owner).catch((error) => {
            console.error("[desktop] Terminal renderer cleanup could not be verified", error);
          });
        });
      }
      const decoder = new StringDecoder("utf8");
      host.stdout.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        session.replay = appendReplay(session.replay, bytes);
        const data = decoder.write(bytes);
        send(session, TERMINAL_IPC_CHANNELS.output, { sessionId, data });
      });
      host.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const event = message as { type?: unknown; code?: unknown; signal?: unknown; errorCode?: unknown; message?: unknown; pid?: unknown; cleanupProven?: unknown };
        if (event.type === "spawned" && Number.isSafeInteger(event.pid) && Number(event.pid) >= 2) session.shellPid = Number(event.pid);
        if (event.type === "terminal" && event.cleanupProven === true) {
          session.cleanupProven = true;
          if (completedRecord && completedSessions.get(sessionId) === completedRecord) {
            completedRecord.cleanupProven = true;
          }
        }
        if (event.type === "error") {
          send(session, TERMINAL_IPC_CHANNELS.exit, { sessionId, code: null, signal: null, error: String(event.message ?? event.errorCode ?? "Terminal host failed") });
        }
      });
      host.once("exit", (code, signal) => {
        const tail = decoder.end();
        if (tail) send(session, TERMINAL_IPC_CHANNELS.output, { sessionId, data: tail });
        session.closed = true;
        sessions.delete(sessionId);
        completedRecord = { owner, cleanupProven: session.cleanupProven, shellPid: session.shellPid };
        completedSessions.set(sessionId, completedRecord);
        session.resolveExited();
        send(session, TERMINAL_IPC_CHANNELS.exit, { sessionId, code, signal, error: code === 0 ? null : "The shell exited." });
      });
      host.once("error", (error) => {
        session.closed = true;
        if (session.shellPid === null) session.cleanupProven = true;
        sessions.delete(sessionId);
        completedRecord = { owner, cleanupProven: session.cleanupProven, shellPid: session.shellPid };
        completedSessions.set(sessionId, completedRecord);
        session.resolveExited();
        send(session, TERMINAL_IPC_CHANNELS.exit, { sessionId, code: null, signal: null, error: error.message });
      });
      host.send({
        type: "startTerminal",
        protocolVersion: { major: 1, minor: 0 },
        requestId: sessionId,
        executable: shell.executable,
        argv: shell.argv,
        cwd: workspace.cwd,
        env: inheritedTerminalEnv(workspace.cwd),
        ownerToken: randomUUID(),
        cols,
        rows,
      });
      return { sessionId, replay: "", status: "running", agentName: workspace.agentName };
    },
    input(owner: Renderer, input: unknown) {
      const payload = exactObject(input, ["sessionId", "data"], "Terminal input");
      const sessionId = requiredId(payload.sessionId, "Terminal session id", SESSION_ID_RE);
      if (typeof payload.data !== "string" || Buffer.byteLength(payload.data) > 48 * 1024 || payload.data.includes("\0")) throw new Error("Terminal input is invalid");
      const session = sessions.get(sessionId);
      if (!session || session.owner !== owner || session.closed) throw new Error("Terminal session is unavailable");
      session.host.send({ type: "input", protocolVersion: { major: 1, minor: 0 }, requestId: sessionId, data: payload.data });
    },
    resize(owner: Renderer, input: unknown) {
      const payload = exactObject(input, ["sessionId", "cols", "rows"], "Terminal resize");
      const sessionId = requiredId(payload.sessionId, "Terminal session id", SESSION_ID_RE);
      const session = sessions.get(sessionId);
      if (!session || session.owner !== owner || session.closed) throw new Error("Terminal session is unavailable");
      session.host.send({ type: "resize", protocolVersion: { major: 1, minor: 0 }, requestId: sessionId, cols: terminalSize(payload.cols, "Terminal columns", 2), rows: terminalSize(payload.rows, "Terminal rows", 1) });
    },
    close,
    closeOwner,
    async shutdown() {
      const owners = new Set<Renderer>([
        ...[...sessions.values()].map((session) => session.owner),
        ...[...completedSessions.values()].map((session) => session.owner),
      ]);
      const results = await Promise.allSettled([...owners].map((owner) => closeOwner(owner)));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Terminal shutdown could not verify cleanup");
    },
    sessionCount() { return sessions.size; },
  };
}

export function registerTerminalIpcHandlers(ipcMain: IpcMainLike, options: {
  getMainRenderer(): Renderer | null;
  controller: ReturnType<typeof createTerminalController>;
}) {
  const register = (channel: string, handler: (event: IpcEvent, payload: unknown) => unknown) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, (event, payload) => {
      const renderer = options.getMainRenderer();
      if (!renderer || event.sender !== renderer || event.senderFrame !== renderer.mainFrame) throw new Error("Terminal IPC is restricted to the current renderer main frame");
      return handler(event, payload);
    });
  };
  register(TERMINAL_IPC_CHANNELS.create, (event, payload) => options.controller.create(event.sender, payload));
  register(TERMINAL_IPC_CHANNELS.input, (event, payload) => options.controller.input(event.sender, payload));
  register(TERMINAL_IPC_CHANNELS.resize, (event, payload) => options.controller.resize(event.sender, payload));
  register(TERMINAL_IPC_CHANNELS.close, (event, payload) => {
    const object = exactObject(payload, ["sessionId"], "Terminal close");
    return options.controller.close(event.sender, requiredId(object.sessionId, "Terminal session id", SESSION_ID_RE));
  });
}
