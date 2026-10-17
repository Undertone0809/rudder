import { applyPendingMigrations, createDb, ensurePostgresDatabase } from "@rudderhq/db";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthRuntime } from "../bootstrap/auth-runtime.js";
import { createHttpApp, type HttpAppHandle } from "../bootstrap/create-http-app.js";
import { preparePublicIngressStartup } from "../bootstrap/public-ingress-startup.js";
import type { Config } from "../config.js";
import { localAccountAuthService } from "../services/local-account-auth.js";

// Real bootstrap components, issuer lifecycle, public HTTP, source-built Rust,
// and disposable PostgreSQL. No mocked session resolver or Rust bridge.
// Better Auth captures NODE_ENV at module evaluation. Set production before
// static bootstrap imports run; changing it only in beforeAll leaves origin
// protection disabled by the dependency's cached test-mode constant.
const issuerEnvironment = vi.hoisted(() => {
  const previous = { NODE_ENV: process.env.NODE_ENV, TEST: process.env.TEST };
  process.env.NODE_ENV = "production";
  process.env.TEST = "false";
  return previous;
});
type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type PgConstructor = new (options: Record<string, unknown>) => Pg;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);
const secret = "  synthetic-launcher-issuer-secret-at-least-32-bytes  ";
const envNames = ["RUDDER_HOME", "RUDDER_PUBLIC_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "RUDDER_AGENT_JWT_SECRET", "NODE_ENV", "TEST"] as const;

async function freePort() {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("constructed issuer through the real Rust application launcher", () => {
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  previousEnv.NODE_ENV = issuerEnvironment.NODE_ENV;
  previousEnv.TEST = issuerEnvironment.TEST;
  let temporary = "", binary = "", databaseUrl = "", rustDatabaseUrl = "";
  let databaseProxy: net.Server | undefined;
  let databasePort = 0, proxyPort = 0;
  const proxySockets = new Set<net.Socket>();
  let pg: Pg | undefined;
  let createAuthRuntime: typeof import("../bootstrap/auth-runtime.js")["createAuthRuntime"];
  let db: ReturnType<typeof createDb>;
  let app: HttpAppHandle | undefined;
  let server: Server | undefined;
  const nodePaths: string[] = [];

  async function startDatabaseProxy() {
    databaseProxy = net.createServer((incoming) => {
      const upstream = net.connect(databasePort, "127.0.0.1");
      for (const socket of [incoming, upstream]) {
        proxySockets.add(socket);
        socket.on("close", () => proxySockets.delete(socket));
        socket.on("error", () => { incoming.destroy(); upstream.destroy(); });
      }
      incoming.pipe(upstream).pipe(incoming);
    }).listen(proxyPort, "127.0.0.1");
    await once(databaseProxy, "listening");
    proxyPort = (databaseProxy.address() as net.AddressInfo).port;
  }

  async function stopDatabaseProxy() {
    const owned = databaseProxy; databaseProxy = undefined;
    for (const socket of proxySockets) socket.destroy();
    proxySockets.clear();
    if (owned) await new Promise<void>((resolve, reject) => owned.close((error) => error ? reject(error) : resolve()));
  }

  async function closeApp() {
    await app?.close(); app = undefined;
    if (server) {
      const owned = server; server = undefined;
      if (!owned.listening) return;
      await new Promise<void>((resolve, reject) => {
        owned.close((error) => error ? reject(error) : resolve());
        owned.closeAllConnections();
      });
    }
  }

  beforeAll(async () => {
    // Better Auth disables origin/CSRF checks in its test environment. Reload
    // the actual issuer under production defaults so this workflow covers them.
    process.env.NODE_ENV = "production";
    process.env.TEST = "false";
    vi.resetModules();
    ({ createAuthRuntime } = await import("../bootstrap/auth-runtime.js"));
    temporary = await mkdtemp(path.join(os.tmpdir(), "rudder-auth-launcher-"));
    process.env.RUDDER_HOME = path.join(temporary, "home");
    const args = ["build", "--locked", "--manifest-path", path.join(repositoryRoot, "native/Cargo.toml"), "--bin", "rudder-server-foundation", "--message-format=json"];
    if (process.env.CI) args.push("--release");
    const built = await run("cargo", args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 });
    for (const line of built.stdout.trim().split("\n")) {
      const artifact = JSON.parse(line);
      if (artifact.reason === "compiler-artifact" && artifact.target?.name === "rudder-server-foundation" && artifact.executable) binary = artifact.executable;
    }
    if (!binary) throw new Error("No source-built Rust foundation binary");
    console.info("Auth launcher source binary", { binary, sha256: createHash("sha256").update(await readFile(binary)).digest("hex") });
    const external = process.env.RUDDER_BROWSER_AUTH_LAUNCHER_TEST_DATABASE_URL?.trim();
    if (external) {
      const parsed = new URL(external);
      if (parsed.hostname !== "127.0.0.1" || !/^\/[a-z0-9_]+_test$/.test(parsed.pathname)) {
        throw new Error("Launcher integration requires a loopback database with a name ending _test");
      }
      databaseUrl = external;
      databasePort = Number(parsed.port);
    } else {
      const port = await freePort();
      const EmbeddedPostgres = (await import("embedded-postgres")).default as PgConstructor;
      pg = new EmbeddedPostgres({ databaseDir: path.join(temporary, "pg"), user: "rudder", password: "rudder", port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-k", ""], onLog: () => {}, onError: () => {} });
      await pg.initialise(); await pg.start();
      await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder_auth_launcher_test");
      databaseUrl = `postgres://rudder:rudder@127.0.0.1:${port}/rudder_auth_launcher_test`;
      databasePort = port;
    }
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);
    await startDatabaseProxy();
    const proxied = new URL(databaseUrl);
    proxied.port = String(proxyPort);
    rustDatabaseUrl = proxied.toString();
  }, 180_000);

  afterEach(closeApp, 30_000);
  afterAll(async () => {
    try { await closeApp(); await stopDatabaseProxy(); await db?.$client.end({ timeout: 5 }); await pg?.stop(); }
    finally {
      for (const name of envNames) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);

  async function start(config: Config, runtime: AuthRuntime, publicPort: number) {
    const issuer = runtime.browserSessionAuth;
    const localIssuer = issuer?.issuer === "local_account"
      ? { sessionSecret: issuer.secret, secureCookie: issuer.secureCookie } : undefined;
    const ingress = await preparePublicIngressStartup(config, publicPort, localIssuer, issuer);
    // Reserve the selected compatibility port before Rust binds an ephemeral
    // private bridge port; macOS can otherwise assign that same next port.
    server = createServer((req, res) => {
      nodePaths.push(req.url ?? "");
      if (app) app.app(req, res);
      else { res.statusCode = 503; res.end(); }
    });
    server.listen(ingress.nodeListenPort, ingress.nodeListenHost);
    await once(server, "listening");
    app = await createHttpApp(db, {
      uiMode: "none", serverPort: publicPort, storageService: {} as never,
      deploymentMode: config.deploymentMode, authRequirement: "required",
      deploymentExposure: "private", allowedHostnames: [], bindHost: "127.0.0.1",
      companyDeletionEnabled: false, databaseUrl: rustDatabaseUrl, instanceId: "auth-launcher-test",
      rustFoundationBinaryPath: binary, rustFoundationMode: "off",
      rustOrganizationBrandingMode: "off", rustProjectGoalSetMode: "off",
      ...runtime, ...ingress.appOptions,
    });
    await app.waitForPublicIngressReady?.();
    return app.publicIngressBaseUrl!;
  }

  for (const issuer of ["better_auth", "local_account"] as const) {
    for (const secure of [false, true]) {
      for (const remember of issuer === "better_auth" ? [true, false] : [true]) {
        it(`${issuer} secure=${secure} remember=${remember}: real issuance, native read, restart and signout`, async () => {
          const publicPort = await freePort();
          const origin = `${secure ? "https" : "http"}://127.0.0.1:${publicPort}`;
          process.env.RUDDER_PUBLIC_URL = origin;
          delete process.env.BETTER_AUTH_SECRETS;
          if (secure) { delete process.env.BETTER_AUTH_SECRET; process.env.RUDDER_AGENT_JWT_SECRET = secret; }
          else { process.env.BETTER_AUTH_SECRET = secret; delete process.env.RUDDER_AGENT_JWT_SECRET; }
          const config = {
            deploymentMode: issuer === "local_account" ? "local_trusted" : "authenticated",
            deploymentExposure: "private", host: "127.0.0.1", allowedHostnames: [],
            rustPublicIngressMode: "required", authBaseUrlMode: "explicit",
            authPublicBaseUrl: origin, authDisableSignUp: false,
          } as Config;
          const runtime = await createAuthRuntime({
            db, config, instanceId: "auth-launcher-test", ensureLocalTrustedBoardPrincipal: async () => {},
            localAccountAuth: issuer === "local_account" ? {
              identityOrigin: "https://identity.invalid.test", audience: "rudder-test",
              sessionSecret: secret, secureCookie: secure,
            } : undefined,
          });
          expect(Object.isFrozen(runtime.browserSessionAuth)).toBe(true);
          expect(runtime.browserSessionAuth?.secret).toBe(secret);
          expect(runtime.browserSessionAuth?.secureCookie).toBe(secure);
          // Ambient changes after construction must not change either owner.
          process.env.BETTER_AUTH_SECRET = "wrong-after-construction-but-long-enough-secret";
          process.env.RUDDER_AGENT_JWT_SECRET = "wrong-fallback-after-construction-secret";
          process.env.RUDDER_PUBLIC_URL = secure ? "http://invalid.test" : "https://invalid.test";
          let base = await start(config, runtime, publicPort);
          expect((await fetch(`${base}/api/auth/get-session`)).status).toBe(401);
          for (const route of ["orgs", "agents"]) {
            expect((await fetch(`${base}/api/${route}`)).status).toBe(401);
          }
          let cookie: string, userId: string;
          if (issuer === "better_auth") {
            const signUp = () => fetch(`${base}/api/auth/sign-up/email`, {
              method: "POST", headers: { "content-type": "application/json", origin },
              body: JSON.stringify({ name: "Native Launcher", email: `${randomUUID()}@invalid.test`, password: `test-${randomUUID()}`, rememberMe: remember }),
            });
            let signup = await signUp();
            // Production Better Auth rate limits this shared loopback address.
            // Respect its bounded retry window instead of disabling protection.
            if (signup.status === 429) {
              const retrySeconds = Number(signup.headers.get("retry-after") ?? 10);
              expect(retrySeconds).toBeGreaterThanOrEqual(0);
              expect(retrySeconds).toBeLessThanOrEqual(15);
              await new Promise((resolve) => setTimeout(resolve, (retrySeconds + 1) * 1000));
              signup = await signUp();
            }
            expect(signup.status).toBe(200);
            cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            userId = (await signup.json() as { user: { id: string } }).user.id;
          } else {
            const policy = runtime.localAccountExchangePolicy!;
            const claims = { issuer: policy.expectedIssuer, subject: randomUUID(), audience: policy.audience, installationId: "auth-launcher-test", jti: randomUUID(), expiresAt: new Date(Date.now() + 60_000), email: `${randomUUID()}@invalid.test`, emailVerified: true, name: "Native Local Launcher" };
            // Controlled exchange verifier, actual existing local session issuer.
            const issued = await localAccountAuthService(db, { ...policy, verifier: { verify: async () => claims } }).redeem("synthetic-exchange-code");
            cookie = issued.session.setCookie.split(";")[0]; userId = issued.userId;
          }
          await db.$client`UPDATE session SET expires_at=now()+interval '2 days' WHERE user_id=${userId}`;
          const beforeRead = nodePaths.length;
          const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
          expect(session.status).toBe(200); expect(session.headers.get("cache-control")).toBe("no-store");
          const dto = { session: { id: `rudder:session:${userId}`, userId }, user: { id: userId, email: null, name: null } };
          expect(await session.json()).toEqual(dto);
          const [row] = await db.$client`SELECT expires_at>now()+interval '6 days' AS refreshed FROM session WHERE user_id=${userId}`;
          expect(row.refreshed).toBe(issuer === "better_auth" && remember);
          expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie, authorization: "Bearer invalid" } })).status).toBe(401);
          expect(nodePaths.length).toBe(beforeRead);
          await closeApp();
          base = await start(config, runtime, publicPort);
          const afterRestart = nodePaths.length;
          expect(await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).json()).toEqual(dto);
          expect(nodePaths.length).toBe(afterRestart);
          if (issuer === "better_auth") {
            const forbidden = await fetch(`${base}/api/auth/sign-out`, {
              method: "POST", headers: { cookie, origin: "https://attacker.invalid.test", "content-type": "application/json" }, body: "{}",
            });
            expect(forbidden.status).toBe(403);
            expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(200);
          }
          if (issuer === "local_account" && secure) {
            const beforeOutage = nodePaths.length;
            await stopDatabaseProxy();
            try {
              expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(503);
              expect(nodePaths.length).toBe(beforeOutage);
            } finally { await startDatabaseProxy(); }
            expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(200);
          }
          const signout = issuer === "better_auth" ? "sign-out" : "local-signout-all";
          const logout = await fetch(`${base}/api/auth/${signout}`, {
            method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}",
          });
          expect(logout.status).toBe(200);
          expect(nodePaths.at(-1)).toBe(`/api/auth/${signout}`);
          const afterLogout = nodePaths.length;
          expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(401);
          expect(nodePaths.length).toBe(afterLogout);
        }, 60_000);
      }
    }
  }
});
