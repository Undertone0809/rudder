import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { agents, applyPendingMigrations, chatConversations, createDb, organizations } from "../../../packages/db/src/index.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const MODEL = "vendor/native-chat-executor-model";

type FixtureOptions = {
  exampleBinary: string;
  processHost: string;
  foundationBinary: string;
  postgresBinDir: string;
  mode?: "complete" | "visible_checkpoint";
  runtimeType?: "codex_local" | "hermes_local";
};

async function freePort() {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function fixtureEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: os.tmpdir(),
    HOME: path.join(root, "operator-home"),
    USERPROFILE: path.join(root, "operator-home"),
    LANG: "en_US.UTF-8",
  };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function command(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-16_384); });
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`Fixture command failed (${path.basename(executable)}): ${output}`);
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}

function launch(executable: string, args: string[], root: string, label: string, env: NodeJS.ProcessEnv) {
  const log = createWriteStream(path.join(root, `${label}.log`));
  const child = spawn(executable, args, {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("close", () => log.end());
  // Keep startup errors observable even before a listener begins its wait.
  let startupError: Error | null = null;
  child.on("error", (error) => { startupError = error; });
  return { child, getStartupError: () => startupError };
}

function describeCleanupError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const details = error as NodeJS.ErrnoException & { signal?: string };
  return `${error.name}: ${error.message} (code=${details.code ?? "none"}, signal=${details.signal ?? "none"})`;
}

async function stopChild(label: string, child?: ChildProcess) {
  if (!child?.pid) return `${label}: no owned process (pid=unavailable)`;
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null) {
    return `${label}: exited before cleanup (pid=${pid}, exitCode=${child.exitCode ?? "none"}, signalCode=${child.signalCode ?? "none"})`;
  }
  const exited = once(child, "exit");
  const signals: string[] = [];
  const signal = (value: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      signals.push(`${value}=already-exited`);
      return;
    }
    try {
      if (process.platform !== "win32") process.kill(-pid, value);
      else child.kill(value);
      signals.push(`${value}=sent`);
    } catch (error) {
      const details = error as NodeJS.ErrnoException;
      if (details.code === "ESRCH") signals.push(`${value}=ESRCH`);
      else throw new Error(`${label}: could not send ${value} to owned process group pid=${pid}: ${describeCleanupError(error)}`, { cause: error });
    }
  };
  signal("SIGTERM");
  let forceKillError: unknown;
  const timer = setTimeout(() => {
    try { signal("SIGKILL"); } catch (error) { forceKillError = error; }
  }, 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
  const receipt = `${label}: exit receipt (pid=${pid}, exitCode=${child.exitCode ?? "none"}, signalCode=${child.signalCode ?? "none"}, signals=${signals.join(",") || "none"})`;
  if (forceKillError) throw new Error(`${receipt}; forced termination failed: ${describeCleanupError(forceKillError)}`, { cause: forceKillError });
  return receipt;
}

async function waitForHealth(url: string, process_: ReturnType<typeof launch>) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (process_.getStartupError()) throw process_.getStartupError();
    if (process_.child.exitCode !== null || process_.child.signalCode !== null) {
      throw new Error("Fixture ancillary server exited before readiness; inspect its fixture log");
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* The new listener is not bound yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture ancillary server readiness timed out; inspect its fixture log");
}

/**
 * Real Rust admission/reconciliation/process execution with a synthetic owned
 * provider and a new PostgreSQL cluster. The existing Node server supplies
 * unmigrated UI reads; it is not a mock or a Native Chat business writer.
 */
export async function startNativeChatFixture(options: FixtureOptions) {
  for (const executable of [options.exampleBinary, options.processHost, options.foundationBinary,
    path.join(options.postgresBinDir, "initdb"), path.join(options.postgresBinDir, "pg_ctl")]) {
    await access(executable);
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rudder-native-chat-e2e-")));
  const env = fixtureEnvironment(root);
  const pgData = path.join(root, "db");
  let pgStarted = false;
  let node: ReturnType<typeof launch> | undefined;
  let rust: ReturnType<typeof launch> | undefined;
  const stop = async ({ preserveRoot = true } = {}) => {
    const receipts: string[] = [];
    const failures: unknown[] = [];
    for (const [label, child] of [["rust-authority", rust?.child], ["node-ancillary", node?.child]] as const) {
      try {
        receipts.push(await stopChild(label, child));
      } catch (error) {
        failures.push(new Error(
          `${label} cleanup failed (pid=${child?.pid ?? "unavailable"}, exitCode=${child?.exitCode ?? "none"}, signalCode=${child?.signalCode ?? "none"}): ${describeCleanupError(error)}`,
          { cause: error },
        ));
      }
    }
    if (pgStarted) {
      let postgresPid = "unavailable";
      try { postgresPid = (await readFile(path.join(pgData, "postmaster.pid"), "utf8")).split(/\s+/u, 1)[0] ?? postgresPid; }
      catch { /* The pid file may already be gone when PostgreSQL has exited. */ }
      try {
        await command(path.join(options.postgresBinDir, "pg_ctl"), ["-D", pgData, "-m", "fast", "-w", "-t", "10", "stop"], env);
        pgStarted = false;
        receipts.push(`postgres: stop receipt (pid=${postgresPid})`);
      } catch (error) {
        failures.push(new Error(`postgres cleanup failed (pid=${postgresPid}): ${describeCleanupError(error)}`, { cause: error }));
      }
    }
    if (failures.length > 0) {
      const failureSummary = failures.map(describeCleanupError).join("; ");
      throw new AggregateError(failures, `Fixture cleanup incomplete; preserve ${root}; receipts=[${receipts.join("; ")}]; failures=[${failureSummary}]`);
    }
    if (!preserveRoot) await rm(root, { recursive: true, force: true });
  };
  try {
    for (const directory of ["instance", "workspaces", "previous-documents", "profiles", "operator-home",
      "isolated-home", "runtime-root", "agent-cwd", "bin"]) await mkdir(path.join(root, directory));
    const python = await realpath(await command(
      "python3",
      ["-I", "-S", "-c", "import sys; print(sys.executable)"],
      env,
    ));
    const provider = path.join(root, "bin/provider");
    const source = await readFile(path.join(
      REPO,
      options.runtimeType === "hermes_local"
        ? "tests/e2e/fixtures/fake-hermes.py"
        : "native/crates/native-chat-executor/tests/fixtures/fake_codex.py",
    ));
    await writeFile(provider, Buffer.concat([Buffer.from(`#!${python}\n`), source]));
    await chmod(provider, 0o700);
    if (options.runtimeType === "hermes_local") {
      const install = path.join(root, "hermes-install");
      const bin = path.join(install, "venv/bin");
      await mkdir(bin, { recursive: true });
      const hermes = path.join(bin, "hermes");
      const wrapper = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nif __name__ == \"__main__\":\n    sys.exit(main())\n";
      await writeFile(hermes, wrapper, { mode: 0o700 });
      await chmod(hermes, 0o700);

      const pythonShim = path.join(bin, "python3");
      await writeFile(
        pythonShim,
        `#!/bin/sh\nPYTHONPATH=${shellQuote(install)} exec ${shellQuote(python)} "$@"\n`,
        { mode: 0o700 },
      );
      await chmod(pythonShim, 0o700);

      const hermesSources: Record<string, string> = {
        "hermes_bootstrap.py": "def harden_import_path(source_root):\n    return None\n",
        "hermes_cli/__init__.py": "__version__ = \"0.21.0\"\n",
        "hermes_cli/main.py": "from acp_adapter.entry import main\n",
        "acp_adapter/entry.py":
          `import runpy\n\ndef main(argv=None):\n    runpy.run_path(${JSON.stringify(provider)}, run_name="__main__")\n`,
        "acp_adapter/session.py": "class SessionManager:\n    def _make_agent(self, session_id, cwd, model, requested_provider, base_url, api_mode):\n        return type('Agent', (), {'ephemeral_system_prompt': None})()\n",
        "agent/agent_init.py": "# synthetic Hermes 0.21 adapter fixture\n",
        "agent/chat_completion_helpers.py": "# synthetic Hermes 0.21 adapter fixture\n",
      };
      for (const [relative, text] of Object.entries(hermesSources)) {
        const target = path.join(install, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, { mode: 0o600 });
      }
    }
    await writeFile(path.join(root, "isolated-home/mode.txt"), options.mode ?? "complete");
    const ports = new Set<number>();
    for (let attempt = 0; ports.size < 3 && attempt < 20; attempt += 1) ports.add(await freePort());
    if (ports.size !== 3) throw new Error("Could not allocate distinct fixture ports");
    const [dbPort, nodePort, publicPort] = [...ports];
    await command(path.join(options.postgresBinDir, "initdb"), ["-D", pgData, "--encoding=UTF8", "--locale=C", "--auth=trust", "--username=postgres", "--no-sync"], env);
    pgStarted = true; // Cleanup must also cover a postmaster that outlives pg_ctl startup failure.
    await command(path.join(options.postgresBinDir, "pg_ctl"), ["-D", pgData, "-l", path.join(root, "postgres.log"), "-o",
      `-h 127.0.0.1 -p ${dbPort} -k '' -c shared_buffers=16MB -c max_connections=64`, "-w", "start"], env);
    const databaseUrl = `postgres://postgres@127.0.0.1:${dbPort}/postgres`;
    await applyPendingMigrations(databaseUrl);
    const db = createDb(databaseUrl);
    const orgId = randomUUID(), agentId = randomUUID(), chatId = randomUUID();
    try {
      await db.$client.unsafe("CREATE TABLE rudder_native_chat_browser_fixture(fixture_root text NOT NULL)");
      await db.$client`INSERT INTO rudder_native_chat_browser_fixture VALUES(${root})`;
      await db.insert(organizations).values({ id: orgId, name: "Native Chat Recovery", urlKey: `native-${orgId}`, issuePrefix: "NCE" });
      await db.insert(agents).values({ id: agentId, orgId, name: "Native Chat Fixture", workspaceKey: "codex-agent", role: "engineer", status: "idle", agentRuntimeType: options.runtimeType ?? "codex_local",
        agentRuntimeConfig: options.runtimeType === "hermes_local" ? {} : { command: provider, cwd: path.join(root, "agent-cwd"), profileId: "default", model: MODEL, instructionsBundleMode: "managed", search: false },
        runtimeConfig: { heartbeat: { enabled: false } },
      });
      await db.insert(chatConversations).values({ id: chatId, orgId, title: "Native recovery", preferredAgentId: agentId });
    } finally { await db.$client.end({ timeout: 5 }); }
    const profile = path.join(root, "profiles", orgId, agentId, "default");
    await mkdir(profile, { recursive: true });
    // The launcher/production executor accepts only the exact restricted test
    // profile. No provider authentication is needed for this synthetic child.
    const profileSource = await readFile(path.join(REPO, "native/crates/native-chat-executor/src/profile.rs"), "utf8");
    const configLiteral = profileSource.match(/const CONFIG: &str = ("(?:[^"\\]|\\.)*");/);
    if (!configLiteral) throw new Error("Native test profile contract changed; update the fixture explicitly");
    await writeFile(path.join(profile, "config.toml"), JSON.parse(configLiteral[1]), { mode: 0o600 });
    await writeFile(path.join(profile, ".rudder-native-chat-profile"), "rudder-native-chat-profile-v1\n", { mode: 0o600 });
    const instructions = path.join(root, "workspaces", orgId.replaceAll("-", "").slice(0, 12), "workspaces/agents/codex-agent/instructions");
    await mkdir(instructions, { recursive: true });
    if (options.runtimeType !== "hermes_local") await writeFile(path.join(instructions, "SOUL.md"), "Synthetic native browser fixture instructions.\n");
    await mkdir(path.join(root, "operator-home/hermes-profile"), { recursive: true });
    const instanceRoot = path.join(root, "rudder-home/instances/browser-fixture");
    await mkdir(instanceRoot, { recursive: true });
    const configPath = path.join(instanceRoot, "config.json");
    await writeFile(configPath, JSON.stringify({
      $meta: { version: 1, source: "onboard", updatedAt: new Date().toISOString() },
      database: { mode: "postgres", connectionString: databaseUrl },
      logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
      server: { deploymentMode: "local_trusted", host: "127.0.0.1", port: nodePort },
      auth: { baseUrlMode: "auto" },
      storage: { provider: "local_disk", localDisk: { baseDir: path.join(instanceRoot, "storage") } },
      secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets/master.key") } },
    }));
    const nodeUrl = `http://127.0.0.1:${nodePort}`;
    node = launch(process.execPath, [path.join(REPO, "server/node_modules/tsx/dist/cli.mjs"), "--tsconfig", path.join(REPO, "server/tsconfig.json"), path.join(REPO, "server/src/index.ts")], root, "node-ancillary", {
      ...env, DATABASE_URL: databaseUrl, RUDDER_HOME: path.join(root, "rudder-home"), RUDDER_CONFIG: configPath,
      RUDDER_INSTANCE_ID: "browser-fixture", RUDDER_LOCAL_ENV: "e2e", RUDDER_UI_DEV_MIDDLEWARE: "true",
      RUDDER_LISTEN_HOST: "127.0.0.1", RUDDER_LISTEN_PORT: String(nodePort),
      RUDDER_MIGRATION_PROMPT: "never", RUDDER_MIGRATION_AUTO_APPLY: "true", RUDDER_FEISHU_LONG_CONNECTION_ENABLED: "false",
      RUDDER_SERVER_FOUNDATION_PATH: options.foundationBinary,
    });
    await waitForHealth(nodeUrl, node);
    const fixtureConfigPath = path.join(root, "native-fixture.json");
    await writeFile(fixtureConfigPath, JSON.stringify({ fixtureRoot: root, databaseUrl, nodeUpstream: nodeUrl,
      listenAddr: `127.0.0.1:${publicPort}`, processHost: options.processHost, runtimeType: options.runtimeType }));
    rust = launch(options.exampleBinary, [fixtureConfigPath], root, "rust-authority", env);
    const lines = createInterface({ input: rust.child.stdout! });
    const startup = await new Promise<{ publicUrl: string; providerFixtureSha256: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Rust browser fixture startup timed out")), 20_000);
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.fixture === "native-chat-browser/v1") { clearTimeout(timer); resolve(value); }
        } catch { /* A diagnostic line is not a startup receipt. */ }
      });
      rust!.child.once("exit", () => { clearTimeout(timer); reject(new Error("Rust browser fixture exited before readiness")); });
      rust!.child.once("error", (error) => { clearTimeout(timer); reject(error); });
    }).finally(() => lines.close());
    const restartRust = async () => {
      await stopChild("rust-authority", rust?.child);
      rust = launch(options.exampleBinary, [fixtureConfigPath], root, "rust-authority-restarted", env);
      await waitForHealth(startup.publicUrl, rust);
    };
    return { root, databaseUrl, orgId, agentId, chatId, restartRust, issuePrefix: "NCE", publicUrl: startup.publicUrl,
      providerFixtureSha256: startup.providerFixtureSha256, providerEventsPath: options.runtimeType === "hermes_local" ? path.join(root, "operator-home/hermes-profile/provider-events.jsonl") : path.join(root, "isolated-home/provider-events.jsonl"), stop };
  } catch (error) {
    await stop().catch(() => { /* Preserve the root and logs for owned cleanup diagnosis. */ });
    throw new Error(`Native Chat fixture failed; logs preserved at ${root}`, { cause: error });
  }
}
