import { applyPendingMigrations, createDb, ensurePostgresDatabase } from "@rudderhq/db";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signNativeSessionAssertion } from "../auth/native-session-assertion.js";
import type { AuthRuntime } from "../bootstrap/auth-runtime.js";
import { createHttpApp, type HttpAppHandle } from "../bootstrap/create-http-app.js";
import { preparePublicIngressStartup } from "../bootstrap/public-ingress-startup.js";
import type { Config } from "../config.js";
import { localAccountAuthService } from "../services/local-account-auth.js";
import type { RustNativeChatHost } from "../services/rust-public-ingress-config.js";

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
const secret = "  synthetic-launcher-issuer-secret-at-least-32-bytes  ";
const envNames = ["RUDDER_HOME", "RUDDER_PUBLIC_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "RUDDER_AGENT_JWT_SECRET", "NODE_ENV", "TEST"] as const;

async function runBoundedBuild(command: string, args: string[]) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maxOutputBytes = 32 * 1024 * 1024;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let spawnFailed = false;
  const killOwnedProcessTree = () => {
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall back to the direct child if the process group has already gone.
      }
    }
    child.kill("SIGKILL");
  };
  const collect = (chunks: Buffer[], currentBytes: number, chunk: Buffer) => {
    if (currentBytes + chunk.length > maxOutputBytes) {
      outputLimitExceeded = true;
      killOwnedProcessTree();
      return currentBytes;
    }
    chunks.push(chunk);
    return currentBytes + chunk.length;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes = collect(stdout, stdoutBytes, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes = collect(stderr, stderrBytes, chunk);
  });
  let killTimer: ReturnType<typeof setTimeout>;
  const completion = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, signal) => {
      clearTimeout(killTimer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (spawnFailed) reject(new Error("cargo could not start"));
      else if (timedOut) reject(new Error("cargo build exceeded its 300-second timeout"));
      else if (outputLimitExceeded) reject(new Error("cargo build exceeded its output limit"));
      else if (code !== 0) {
        reject(new Error(`cargo build exited with ${code ?? signal}: ${stderrText.slice(-8_000)}`));
      } else resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
  killTimer = setTimeout(() => {
    timedOut = true;
    killOwnedProcessTree();
  }, 300_000);
  return completion;
}

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
  let temporary = "", binary = "", cliBinary = "", databaseUrl = "", rustDatabaseUrl = "";
  let databaseProxy: net.Server | undefined;
  let databasePort = 0, proxyPort = 0;
  const proxySockets = new Set<net.Socket>();
  let pg: Pg | undefined;
  let createAuthRuntime: typeof import("../bootstrap/auth-runtime.js")["createAuthRuntime"];
  let db: ReturnType<typeof createDb>;
  let app: HttpAppHandle | undefined;
  let server: Server | undefined;
  let privateNodeBaseUrl = "";
  let privateNodeAssertionConfig: { assertionKey: string; authorizationKey: string } | undefined;
  const nodePaths: string[] = [];
  const betterAuthRequests: string[] = [];

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
    privateNodeAssertionConfig = undefined;
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
    const args = ["build", "--locked", "--manifest-path", path.join(repositoryRoot, "native/Cargo.toml"), "--bin", "rudder-server-foundation", "--bin", "rudder-cli", "--message-format=json"];
    if (process.env.CI) args.push("--release");
    const built = await runBoundedBuild("cargo", args);
    for (const line of built.stdout.trim().split("\n")) {
      const artifact = JSON.parse(line);
      if (artifact.reason === "compiler-artifact" && artifact.target?.name === "rudder-server-foundation" && artifact.executable) binary = artifact.executable;
      if (artifact.reason === "compiler-artifact" && artifact.target?.name === "rudder-cli" && artifact.executable) cliBinary = artifact.executable;
    }
    if (!binary || !cliBinary) throw new Error("No source-built Rust foundation and CLI binaries");
    console.info("Auth launcher source binary", { binary, sha256: createHash("sha256").update(await readFile(binary)).digest("hex") });
    console.info("Auth launcher source CLI", { binary: cliBinary, sha256: createHash("sha256").update(await readFile(cliBinary)).digest("hex") });
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
  }, 420_000);

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

  async function nativeChatHost(origin: string): Promise<RustNativeChatHost> {
    const root = path.join(temporary, "native-chat-host");
    const instanceRoot = path.join(root, "instance");
    const workspaceHome = path.join(root, "workspace");
    const operatorHome = path.join(root, "operator");
    await Promise.all([instanceRoot, workspaceHome, operatorHome].map((directory) =>
      mkdir(directory, { recursive: true }),
    ));
    return {
      instanceId: "auth-launcher-native-chat",
      instanceRoot,
      workspaceHome,
      operatorHome,
      // Native recovery is available without an installed provider. Keep the
      // test installation isolated and make provider discovery explicitly empty.
      executableSearchPath: "",
      friendlyWorkspaceHome: false,
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authRequirement: "required",
      trustedOrigins: [origin],
    };
  }

  async function start(
    config: Config,
    runtime: AuthRuntime,
    publicPort: number,
    nativeHost?: RustNativeChatHost,
  ) {
    const issuer = runtime.browserSessionAuth;
    const localIssuer = issuer?.issuer === "local_account"
      ? { sessionSecret: issuer.secret, secureCookie: issuer.secureCookie } : undefined;
    const localAccountLifecycle = runtime.localAccountExchangePolicy
      ? {
          installationId: "auth-launcher-test",
          expectedIssuer: runtime.localAccountExchangePolicy.expectedIssuer,
          audience: runtime.localAccountExchangePolicy.audience,
          identityOrigin: runtime.localAccountExchangePolicy.expectedIssuer,
          offline: runtime.localAccountExchangePolicy.offline,
        }
      : undefined;
    const ingress = await preparePublicIngressStartup(
      config,
      publicPort,
      localIssuer,
      issuer,
      localAccountLifecycle,
      nativeHost,
    );
    const rustIngress = ingress.appOptions.rustPublicIngress;
    if (!rustIngress?.identityAuth) {
      throw new Error("CLI private-hop regression requires the configured Rust identity assertion");
    }
    privateNodeAssertionConfig = {
      assertionKey: rustIngress.identityAuth.assertionKey,
      authorizationKey: rustIngress.authorizationKey,
    };
    // Reserve the selected compatibility port before Rust binds an ephemeral
    // private bridge port; macOS can otherwise assign that same next port.
    server = createServer((req, res) => {
      nodePaths.push(req.url ?? "");
      if (app) app.app(req, res);
      else { res.statusCode = 503; res.end(); }
    });
    server.listen(ingress.nodeListenPort, ingress.nodeListenHost);
    await once(server, "listening");
    privateNodeBaseUrl = `http://${ingress.nodeListenHost}:${ingress.nodeListenPort}`;
    betterAuthRequests.length = 0;
    const betterAuthHandler = runtime.betterAuthHandler;
    app = await createHttpApp(db, {
      uiMode: "none", serverPort: publicPort, storageService: {} as never,
      deploymentMode: config.deploymentMode, authRequirement: "required",
      deploymentExposure: "private", allowedHostnames: [], bindHost: "127.0.0.1",
      companyDeletionEnabled: false, databaseUrl: rustDatabaseUrl, instanceId: "auth-launcher-test",
      rustFoundationBinaryPath: binary, rustFoundationMode: "off",
      rustOrganizationBrandingMode: "off", rustProjectGoalSetMode: "off",
      ...runtime, ...ingress.appOptions,
      betterAuthHandler: betterAuthHandler
        ? (req, res, next) => {
            betterAuthRequests.push(`${req.method} ${req.originalUrl}`);
            return betterAuthHandler(req, res, next);
          }
        : undefined,
    });
    await app.waitForPublicIngressReady?.();
    return app.publicIngressBaseUrl!;
  }

  async function exerciseCliAuthWorkflow(
    base: string,
    origin: string,
    cookie: string,
    userId: string,
    nativeSessionId: string,
    noMembershipSession?: { cookie: string; userId: string },
  ) {
    let expectedCreatedEvents = 2;
    const organizationId = randomUUID();
    const issuePrefix = `CLI${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.$client`INSERT INTO organizations (id, url_key, name, issue_prefix)
      VALUES (${organizationId}, ${`cli-${organizationId}`}, 'CLI auth launcher', ${issuePrefix})`;
    await db.$client`INSERT INTO organization_memberships
      (org_id, principal_type, principal_id, status, membership_role)
      VALUES (${organizationId}, 'user', ${userId}, 'active', 'owner')`;
    const replayUserId = randomUUID();
    const replayBoardToken = `pcp_board_${randomBytes(24).toString("hex")}`;
    await db.$client`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${replayUserId}, 'CLI Replay User', ${`${replayUserId}@invalid.test`}, TRUE, now(), now())`;
    await db.$client`INSERT INTO board_api_keys (user_id, name, key_hash, expires_at, created_at)
      VALUES (${replayUserId}, 'CLI replay fixture', ${createHash("sha256").update(replayBoardToken).digest("hex")}, now()+interval '2 days', now())`;

    const privatePaths = [
      ["POST", "/api/cli-auth/challenges"],
      ["GET", "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562?token=synthetic-token"],
      ["POST", "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/approve"],
      ["POST", "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/cancel"],
      ["GET", "/api/cli-auth/me"],
      ["POST", "/api/cli-auth/revoke-current"],
    ] as const;
    const privateNodeStart = nodePaths.length;
    const publicSession = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
    expect(publicSession.status).toBe(200);
    const publicSessionBody = await publicSession.json() as { session: { userId: string }; user: { id: string } };
    expect(publicSessionBody.session.userId).toBe(userId);
    expect(publicSessionBody.user.id).toBe(userId);
    const privateAuthConfig = privateNodeAssertionConfig;
    if (!privateAuthConfig) throw new Error("Rust private-hop assertion config is unavailable");
    const [effectsBeforePrivateRequests] = await db.$client`SELECT
        (SELECT COUNT(*)::int FROM "user") AS users,
        (SELECT COUNT(*)::int FROM account) AS accounts,
        (SELECT COUNT(*)::int FROM session) AS sessions,
        (SELECT COUNT(*)::int FROM board_api_keys) AS board_api_keys,
        (SELECT COUNT(*)::int FROM cli_auth_challenges) AS cli_auth_challenges,
        (SELECT COUNT(*)::int FROM activity_log) AS activity_log,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox) AS outbox`;
    const betterAuthCallsBeforePrivateRequests = betterAuthRequests.length;
    const expectedPrivateNodePaths: string[] = [];
    for (const [method, pathname] of privatePaths) {
      const cookieOnly = await fetch(`${privateNodeBaseUrl}${pathname}`, {
        method,
        headers: {
          cookie,
          origin: privateNodeBaseUrl,
          "content-type": "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify({ token: "synthetic-token" }) } : {}),
      });
      expect(cookieOnly.status, `cookie-only private Node ${method} ${pathname}`).toBe(401);
      expect(await cookieOnly.json()).toMatchObject({ code: "native_session_proof_required" });
      expectedPrivateNodePaths.push(pathname);

      // The session identity was accepted by Rust's public get-session route.
      // Sign the same method/target-bound private-hop protocol with the key
      // shared by this launcher instance, then prove the retired route itself
      // returns 404 after the private proof guard admits that identity.
      const proof = signNativeSessionAssertion({
        key: privateAuthConfig.assertionKey,
        method,
        target: pathname,
        identity: { kind: "session", session_id: nativeSessionId, user_id: userId },
      });
      const authenticated = await fetch(`${privateNodeBaseUrl}${pathname}`, {
        method,
        headers: {
          cookie,
          origin: privateNodeBaseUrl,
          "content-type": "application/json",
          "x-rudder-native-session-proof": proof,
          "x-rudder-ingress-auth": privateAuthConfig.authorizationKey,
        },
        ...(method === "POST" ? { body: JSON.stringify({ token: "synthetic-token" }) } : {}),
      });
      expect(authenticated.status, `authenticated private Node ${method} ${pathname}`).toBe(404);
      expectedPrivateNodePaths.push(pathname);
    }
    expect(nodePaths.slice(privateNodeStart)).toEqual(expectedPrivateNodePaths);
    expect(betterAuthRequests).toHaveLength(betterAuthCallsBeforePrivateRequests);
    const [effectsAfterPrivateRequests] = await db.$client`SELECT
        (SELECT COUNT(*)::int FROM "user") AS users,
        (SELECT COUNT(*)::int FROM account) AS accounts,
        (SELECT COUNT(*)::int FROM session) AS sessions,
        (SELECT COUNT(*)::int FROM board_api_keys) AS board_api_keys,
        (SELECT COUNT(*)::int FROM cli_auth_challenges) AS cli_auth_challenges,
        (SELECT COUNT(*)::int FROM activity_log) AS activity_log,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox) AS outbox`;
    expect(effectsAfterPrivateRequests).toEqual(effectsBeforePrivateRequests);

    const publicNodeStart = nodePaths.length;
    const postJson = (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify(body),
      });
    const createChallenge = async (requestedAccess: "board" | "instance_admin_required" = "board") => {
      const response = await postJson("/api/cli-auth/challenges", {
        command: "rudder organization list",
        clientName: "launcher cli",
        requestedAccess,
        requestedCompanyId: organizationId,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      const value = await response.json() as {
        id: string;
        token: string;
        boardApiToken: string;
        approvalPath: string;
        approvalUrl: string | null;
        pollPath: string;
      };
      const generatedCredential = (credential: unknown, prefix: string) =>
        typeof credential === "string"
        && credential.startsWith(prefix)
        && /^[0-9a-f]{48}$/.test(credential.slice(prefix.length));
      expect(generatedCredential(value.token, "pcp_cli_auth_")).toBe(true);
      expect(generatedCredential(value.boardApiToken, "pcp_board_")).toBe(true);
      expect(value.approvalPath.startsWith(`/cli-auth/${value.id}?token=`)).toBe(true);
      expect(new URL(value.approvalPath, "http://rudder.invalid").searchParams.get("token") === value.token).toBe(true);
      expect(value.approvalUrl?.startsWith(new URL(base).origin)).toBe(true);
      expect(value.approvalUrl && new URL(value.approvalUrl).searchParams.get("token") === value.token).toBe(true);
      expect(value.pollPath).toBe(`/cli-auth/challenges/${value.id}`);
      const [stored] = await db.$client`SELECT
          secret_hash,
          pending_key_hash,
          pending_key_name,
          command,
          client_name,
          requested_access,
          requested_company_id::text AS requested_company_id,
          expires_at BETWEEN now()+interval '9 minutes' AND now()+interval '11 minutes' AS ttl_ok
        FROM cli_auth_challenges WHERE id=${value.id}::uuid`;
      expect(stored.secret_hash === createHash("sha256").update(value.token).digest("hex")).toBe(true);
      expect(stored.pending_key_hash === createHash("sha256").update(value.boardApiToken).digest("hex")).toBe(true);
      expect(stored.pending_key_name).toBe(
        requestedAccess === "instance_admin_required"
          ? "launcher cli (instance admin)"
          : "launcher cli (board)",
      );
      expect(stored.command).toBe("rudder organization list");
      expect(stored.client_name).toBe("launcher cli");
      expect(stored.requested_access).toBe(requestedAccess);
      expect(stored.requested_company_id).toBe(organizationId);
      expect(stored.ttl_ok).toBe(true);
      return value;
    };
    const poll = (challenge: { id: string; token: string }, withCookie = false) =>
      fetch(`${base}/api/cli-auth/challenges/${challenge.id}?token=${encodeURIComponent(challenge.token)}`, {
        headers: withCookie ? { cookie } : {},
      });
    const approve = (challenge: { id: string; token: string }, requestOrigin = origin) =>
      postJson(
        `/api/cli-auth/challenges/${challenge.id}/approve`,
        { token: challenge.token },
        { cookie, origin: requestOrigin },
      );
    const approveAsReplayUser = (challenge: { id: string; token: string }) =>
      postJson(
        `/api/cli-auth/challenges/${challenge.id}/approve`,
        { token: challenge.token },
        { authorization: `Bearer ${replayBoardToken}` },
      );

    const first = await createChallenge();
    const pending = await poll(first);
    const pendingBody = await pending.json() as Record<string, unknown>;
    expect(pending.status).toBe(200);
    expect(pendingBody).toMatchObject({ status: "pending", requiresSignIn: true, canApprove: false });
    expect(pending.headers.get("cache-control")).toBe("private, no-store, max-age=0");

    const rejectedOrigin = await approve(first, "https://attacker.invalid.test");
    expect(rejectedOrigin.status).toBe(403);
    expect((await poll(first)).status).toBe(200);

    const firstApproved = await approve(first);
    expect(firstApproved.status).toBe(200);
    const firstApprovalBody = await firstApproved.json() as { approved: boolean; status: string; keyId: string };
    expect(firstApprovalBody.approved).toBe(true);
    expect(firstApprovalBody.status).toBe("approved");
    const firstApprovedPoll = await poll(first, true);
    expect((await firstApprovedPoll.json() as Record<string, unknown>).status).toBe("approved");
    const replayed = await approveAsReplayUser(first);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({
      approved: true,
      status: "approved",
      userId,
      keyId: firstApprovalBody.keyId,
    });
    const [firstOwner] = await db.$client`SELECT
        c.approved_by_user_id,
        c.board_api_key_id::text AS key_id,
        k.user_id AS key_owner
      FROM cli_auth_challenges c
      JOIN board_api_keys k ON k.id=c.board_api_key_id
      WHERE c.id=${first.id}::uuid`;
    expect(firstOwner).toEqual({
      approved_by_user_id: userId,
      key_id: firstApprovalBody.keyId,
      key_owner: userId,
    });
    const [firstEffects] = await db.$client`SELECT
        (SELECT COUNT(*)::int FROM activity_log WHERE action='board_api_key.created' AND details->>'challengeId'=${first.id}) AS activity_count,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE event_type='activity.logged' AND payload->'details'->>'challengeId'=${first.id}) AS event_count`;
    expect(firstEffects).toEqual({ activity_count: 1, event_count: 1 });

    const noMembership = await createChallenge();
    const noMembershipApproval = await approveAsReplayUser(noMembership);
    expect(noMembershipApproval.status).toBe(200);
    const noMembershipBody = await noMembershipApproval.json() as { userId: string };
    expect(noMembershipBody.userId).toBe(replayUserId);
    const [noMembershipOwner] = await db.$client`SELECT c.approved_by_user_id, k.user_id AS key_owner
      FROM cli_auth_challenges c JOIN board_api_keys k ON k.id=c.board_api_key_id
      WHERE c.id=${noMembership.id}::uuid`;
    expect(noMembershipOwner).toEqual({ approved_by_user_id: replayUserId, key_owner: replayUserId });
    const [noMembershipEffects] = await db.$client`SELECT
        (SELECT COUNT(*)::int FROM activity_log WHERE details->>'challengeId'=${noMembership.id}) AS activity_count,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE payload->'details'->>'challengeId'=${noMembership.id}) AS event_count`;
    expect(noMembershipEffects).toEqual({ activity_count: 0, event_count: 0 });

    if (noMembershipSession) {
      const [membershipRows] = await db.$client`SELECT COUNT(*)::int AS count
        FROM organization_memberships
        WHERE principal_type='user' AND principal_id=${noMembershipSession.userId} AND status='active'`;
      expect(membershipRows.count).toBe(0);
      const sessionChallenge = await createChallenge();
      const sessionApproval = await postJson(
        `/api/cli-auth/challenges/${sessionChallenge.id}/approve`,
        { token: sessionChallenge.token },
        { cookie: noMembershipSession.cookie, origin },
      );
      expect(sessionApproval.status).toBe(200);
      expect(await sessionApproval.json()).toMatchObject({
        approved: true,
        status: "approved",
        userId: noMembershipSession.userId,
      });
      const [sessionOwner] = await db.$client`SELECT
          c.approved_by_user_id,
          c.board_api_key_id::text AS key_id,
          k.user_id AS key_owner
        FROM cli_auth_challenges c
        JOIN board_api_keys k ON k.id=c.board_api_key_id
        WHERE c.id=${sessionChallenge.id}::uuid`;
      expect(sessionOwner).toMatchObject({
        approved_by_user_id: noMembershipSession.userId,
        key_owner: noMembershipSession.userId,
      });
      const sessionKeyMe = await fetch(`${base}/api/cli-auth/me`, {
        headers: { authorization: `Bearer ${sessionChallenge.boardApiToken}` },
      });
      expect(sessionKeyMe.status).toBe(200);
      expect(await sessionKeyMe.json()).toMatchObject({
        userId: noMembershipSession.userId,
        orgIds: [],
      });

      const [foreignAccessBefore] = await db.$client`SELECT
          (SELECT COUNT(*)::int FROM projects WHERE org_id=${organizationId}::uuid) AS project_count,
          (SELECT COUNT(*)::int FROM activity_log WHERE org_id=${organizationId}::uuid) AS activity_count,
          (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE org_id=${organizationId}::uuid) AS event_count`;
      const foreignProject = await fetch(`${base}/api/orgs/${organizationId}/projects`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionChallenge.boardApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: `forbidden-${randomUUID()}` }),
      });
      // Rust rejects the foreign Project write without a Node hop.
      expect(foreignProject.status).toBe(403);
      const [foreignAccessAfter] = await db.$client`SELECT
          (SELECT COUNT(*)::int FROM projects WHERE org_id=${organizationId}::uuid) AS project_count,
          (SELECT COUNT(*)::int FROM activity_log WHERE org_id=${organizationId}::uuid) AS activity_count,
          (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE org_id=${organizationId}::uuid) AS event_count`;
      expect(foreignAccessAfter).toEqual(foreignAccessBefore);
      const [sessionEffects] = await db.$client`SELECT
          (SELECT COUNT(*)::int FROM activity_log WHERE details->>'challengeId'=${sessionChallenge.id}) AS activity_count,
          (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE payload->'details'->>'challengeId'=${sessionChallenge.id}) AS event_count`;
      expect(sessionEffects).toEqual({ activity_count: 0, event_count: 0 });
    }

    const noMembershipMe = await fetch(`${base}/api/cli-auth/me`, {
      headers: { authorization: `Bearer ${noMembership.boardApiToken}` },
    });
    expect(noMembershipMe.status).toBe(200);
    expect(await noMembershipMe.json()).toMatchObject({ userId: replayUserId, orgIds: [] });
    const noMembershipRevoke = await postJson("/api/cli-auth/revoke-current", {}, {
      authorization: `Bearer ${noMembership.boardApiToken}`,
    });
    expect(noMembershipRevoke.status).toBe(200);
    const [noMembershipRevokeEffects] = await db.$client`SELECT
        (SELECT COUNT(*)::int FROM activity_log WHERE details->>'challengeId'=${noMembership.id}) AS activity_count,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE payload->'details'->>'challengeId'=${noMembership.id}) AS event_count`;
    expect(noMembershipRevokeEffects).toEqual({ activity_count: 0, event_count: 0 });

    const concurrent = await createChallenge();
    const concurrentResponses = await Promise.all([
      approve(concurrent),
      approveAsReplayUser(concurrent),
    ]);
    expect(concurrentResponses.map((response) => response.status)).toEqual([200, 200]);
    const concurrentBodies = await Promise.all(
      concurrentResponses.map((response) => response.json() as Promise<{ userId: string; keyId: string }>),
    );
    const [concurrentOwner] = await db.$client`SELECT
        c.approved_by_user_id,
        c.board_api_key_id::text AS key_id,
        k.user_id AS key_owner
      FROM cli_auth_challenges c
      JOIN board_api_keys k ON k.id=c.board_api_key_id
      WHERE c.id=${concurrent.id}::uuid`;
    expect(concurrentBodies.every((body) => body.userId === concurrentOwner.approved_by_user_id)).toBe(true);
    expect(concurrentBodies.every((body) => body.keyId === concurrentOwner.key_id)).toBe(true);
    expect(concurrentOwner.key_owner).toBe(concurrentOwner.approved_by_user_id);
    if (concurrentOwner.approved_by_user_id === userId) expectedCreatedEvents += 1;
    const [concurrentEffects] = await db.$client`SELECT
        (SELECT COUNT(*)::int FROM activity_log WHERE action='board_api_key.created' AND details->>'challengeId'=${concurrent.id}) AS activity_count,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE event_type='activity.logged' AND payload->'details'->>'challengeId'=${concurrent.id}) AS event_count`;
    const expectedConcurrentEffects = concurrentOwner.approved_by_user_id === userId ? 1 : 0;
    expect(concurrentEffects).toEqual({ activity_count: expectedConcurrentEffects, event_count: expectedConcurrentEffects });

    const elevated = await createChallenge("instance_admin_required");
    const elevatedPoll = await poll(elevated, true);
    expect((await elevatedPoll.json() as Record<string, unknown>).canApprove).toBe(false);
    const denied = await approve(elevated);
    expect(denied.status).toBe(403);
    await db.$client`INSERT INTO instance_user_roles (user_id, role) VALUES (${userId}, 'instance_admin')`;
    const elevatedApproved = await approve(elevated);
    expect(elevatedApproved.status).toBe(200);
    const elevatedApprovalBody = await elevatedApproved.json() as { approved: boolean; keyId: string };
    expect(elevatedApprovalBody.approved).toBe(true);
    expect(elevatedApprovalBody.keyId).not.toBe(firstApprovalBody.keyId);

    const keyMe = (token: string) => fetch(`${base}/api/cli-auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const firstMe = await keyMe(first.boardApiToken);
    expect(firstMe.status).toBe(200);
    const firstMeBody = await firstMe.json() as { userId: string; source: string; keyId: string; orgIds: string[] };
    expect(firstMeBody.userId).toBe(userId);
    expect(firstMeBody.source).toBe("board_key");
    expect(firstMeBody.keyId).toBe(firstApprovalBody.keyId);
    expect(firstMeBody.orgIds).toContain(organizationId);

    const firstKey = await db.$client`
      SELECT key_hash,
        expires_at > statement_timestamp() + interval '29 days' AS expires_after_29_days,
        expires_at < statement_timestamp() + interval '31 days' AS expires_before_31_days
      FROM board_api_keys
      WHERE id=${firstApprovalBody.keyId}::uuid
    `;
    expect(firstKey[0].key_hash === createHash("sha256").update(first.boardApiToken).digest("hex")).toBe(true);
    expect(firstKey[0].expires_after_29_days).toBe(true);
    expect(firstKey[0].expires_before_31_days).toBe(true);

    const cancelled = await createChallenge();
    const cancel = () => postJson(
      `/api/cli-auth/challenges/${cancelled.id}/cancel`,
      { token: cancelled.token },
    );
    expect((await cancel()).status).toBe(200);
    expect((await (await cancel()).json() as { status: string; cancelled: boolean }).status).toBe("cancelled");
    expect((await (await poll(cancelled)).json() as Record<string, unknown>).status).toBe("cancelled");

    const approveCancelRace = await createChallenge();
    const [racedApproval, racedCancellation] = await Promise.all([
      approve(approveCancelRace),
      postJson(`/api/cli-auth/challenges/${approveCancelRace.id}/cancel`, { token: approveCancelRace.token }),
    ]);
    expect([racedApproval.status, racedCancellation.status]).toEqual([200, 200]);
    const [racedApprovalBody, racedCancellationBody] = await Promise.all([
      racedApproval.json() as Promise<{ approved: boolean; status: string; keyId: string | null }>,
      racedCancellation.json() as Promise<{ cancelled: boolean; status: string }>,
    ]);
    const [approveCancelState] = await db.$client`SELECT
        c.approved_by_user_id,
        c.board_api_key_id::text AS key_id,
        c.approved_at IS NOT NULL AS approved,
        c.cancelled_at IS NOT NULL AS cancelled,
        (SELECT COUNT(*)::int FROM activity_log WHERE action='board_api_key.created' AND details->>'challengeId'=${approveCancelRace.id}) AS activity_count,
        (SELECT COUNT(*)::int FROM organization_mutation_outbox WHERE event_type='activity.logged' AND payload->'details'->>'challengeId'=${approveCancelRace.id}) AS event_count
      FROM cli_auth_challenges c WHERE c.id=${approveCancelRace.id}::uuid`;
    expect(Boolean(approveCancelState.approved) !== Boolean(approveCancelState.cancelled)).toBe(true);
    const finalRaceStatus = approveCancelState.approved ? "approved" : "cancelled";
    expect(racedApprovalBody.status).toBe(finalRaceStatus);
    expect(racedApprovalBody.approved).toBe(approveCancelState.approved);
    expect(racedCancellationBody.status).toBe(finalRaceStatus);
    expect(racedCancellationBody.cancelled).toBe(approveCancelState.cancelled);
    if (approveCancelState.approved) {
      expect(approveCancelState.approved_by_user_id).toBe(userId);
      expect(approveCancelState.key_id).not.toBeNull();
      expect(approveCancelState.activity_count).toBe(1);
      expect(approveCancelState.event_count).toBe(1);
      expectedCreatedEvents += 1;
    } else {
      expect(approveCancelState.approved_by_user_id).toBeNull();
      expect(approveCancelState.key_id).toBeNull();
      expect(approveCancelState.activity_count).toBe(0);
      expect(approveCancelState.event_count).toBe(0);
    }

    const expired = await createChallenge();
    await db.$client`UPDATE cli_auth_challenges SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect((await (await poll(expired)).json() as Record<string, unknown>).status).toBe("expired");

    const revoke = await postJson("/api/cli-auth/revoke-current", {}, {
      authorization: `Bearer ${first.boardApiToken}`,
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true, keyId: firstApprovalBody.keyId });
    expect((await keyMe(first.boardApiToken)).status).toBe(401);
    expect((await keyMe(elevated.boardApiToken)).status).toBe(200);

    const auditRows = await db.$client`SELECT action, details->>'challengeId' AS challenge_id
      FROM activity_log WHERE org_id=${organizationId}::uuid AND actor_id=${userId}`;
    expect(auditRows.some((row) => row.action === "board_api_key.created" && row.challenge_id === first.id)).toBe(true);
    expect(auditRows.some((row) => row.action === "board_api_key.created" && row.challenge_id === elevated.id)).toBe(true);
    expect(auditRows.some((row) => row.action === "board_api_key.revoked")).toBe(true);
    const liveEvents = await db.$client`SELECT event_type, payload->>'action' AS action
      FROM organization_mutation_outbox WHERE org_id=${organizationId}::uuid`;
    expect(liveEvents.filter((row) => row.event_type === "activity.logged" && row.action === "board_api_key.created")).toHaveLength(expectedCreatedEvents);
    expect(liveEvents.filter((row) => row.event_type === "activity.logged" && row.action === "board_api_key.revoked")).toHaveLength(1);
    expect(nodePaths.slice(publicNodeStart)).toEqual([]);
    return organizationId;
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
          const nativeHost = issuer === "better_auth" && !secure && remember
            ? await nativeChatHost(origin)
            : undefined;
          // Ambient changes after construction must not change either owner.
          process.env.BETTER_AUTH_SECRET = "wrong-after-construction-but-long-enough-secret";
          process.env.RUDDER_AGENT_JWT_SECRET = "wrong-fallback-after-construction-secret";
          process.env.RUDDER_PUBLIC_URL = secure ? "http://invalid.test" : "https://invalid.test";
          let base = await start(config, runtime, publicPort, nativeHost);
          expect((await fetch(`${base}/api/auth/get-session`)).status).toBe(401);
          for (const route of ["orgs", "agents"]) {
            expect((await fetch(`${base}/api/${route}`)).status).toBe(401);
          }
          let cookie: string, userId: string, nativeSessionId: string;
          let noMembershipSession: { cookie: string; userId: string } | undefined;
          let secondCookie: string | undefined;
          let primarySessionToken: string | undefined;
          let secondSessionToken: string | undefined;
          if (issuer === "better_auth") {
            const [authRowsBeforePrivateProbe] = await db.$client`SELECT
                (SELECT COUNT(*)::int FROM "user") AS users,
                (SELECT COUNT(*)::int FROM account) AS accounts,
                (SELECT COUNT(*)::int FROM session) AS sessions,
                (SELECT COUNT(*)::int FROM verification) AS verifications`;
            const privateNodePathsBeforeProbe = nodePaths.length;
            const privateAuthPaths = [
              "/api/auth/sign-up/email",
              "/api/auth/sign-in/email",
              "/api/auth/sign-out",
              "/api/auth/sign-up%2Femail",
            ];
            for (const path of privateAuthPaths) {
              const response = await fetch(`${privateNodeBaseUrl}${path}`, {
                method: "POST", headers: { "content-type": "application/json", origin }, body: "{}",
              });
              expect(response.status, path).toBe(404);
            }
            expect(nodePaths.slice(privateNodePathsBeforeProbe)).toEqual(privateAuthPaths);
            expect(betterAuthRequests).toEqual([]);
            const [authRowsAfterPrivateProbe] = await db.$client`SELECT
                (SELECT COUNT(*)::int FROM "user") AS users,
                (SELECT COUNT(*)::int FROM account) AS accounts,
                (SELECT COUNT(*)::int FROM session) AS sessions,
                (SELECT COUNT(*)::int FROM verification) AS verifications`;
            expect(authRowsAfterPrivateProbe).toEqual(authRowsBeforePrivateProbe);

            const email = `${randomUUID()}@invalid.test`;
            const password = randomBytes(24).toString("base64url");
            const emailAuthNodePathsBefore = nodePaths.length;
            const signUp = () => fetch(`${base}/api/auth/sign-up/email`, {
              method: "POST", headers: { "content-type": "application/json", origin },
              body: JSON.stringify({ name: "Native Launcher", email, password, rememberMe: remember }),
            });
            let signup = await signUp();
            // Production Better Auth rate limits this shared loopback address.
            // Respect its bounded retry window instead of disabling protection.
            if (signup.status === 429) {
              const retrySeconds = Number(signup.headers.get("x-retry-after") ?? signup.headers.get("retry-after") ?? 10);
              expect(retrySeconds).toBeGreaterThanOrEqual(0);
              expect(retrySeconds).toBeLessThanOrEqual(15);
              await new Promise((resolve) => setTimeout(resolve, (retrySeconds + 1) * 1000));
              signup = await signUp();
            }
            expect(signup.status).toBe(200);
            expect(nodePaths.length).toBe(emailAuthNodePathsBefore);
            cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            const signupBody = await signup.json() as { token: string; user: { id: string } };
            primarySessionToken = signupBody.token;
            userId = signupBody.user.id;
            const [nativeSession] = await db.$client`SELECT id FROM session WHERE token=${primarySessionToken} AND user_id=${userId}`;
            if (!nativeSession?.id) throw new Error("Native session row was not created for the signed-up user");
            nativeSessionId = nativeSession.id;

            const privateNodePathsBeforeSignout = nodePaths.length;
            const betterAuthCallsBeforePrivateSignout = betterAuthRequests.length;
            const privateSignout = await fetch(`${privateNodeBaseUrl}/api/auth/sign-out`, {
              method: "POST", headers: { cookie, "content-type": "application/json", origin }, body: "{}",
            });
            expect(privateSignout.status).toBe(404);
            expect(nodePaths.slice(privateNodePathsBeforeSignout)).toEqual(["/api/auth/sign-out"]);
            expect(betterAuthRequests).toHaveLength(betterAuthCallsBeforePrivateSignout);
            expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(200);
            const emailAuthNodePathsAfterPrivateSignout = nodePaths.length;

            // The installed Better Auth schema has no unique email constraint,
            // so historical duplicate rows are possible. Native sign-in must
            // fail closed rather than choosing an ambiguous credential row.
            const historicalDuplicateEmail = `${randomUUID()}@invalid.test`;
            for (const duplicateId of [randomUUID(), randomUUID()]) {
              await db.$client`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
                VALUES (${duplicateId}, 'Historical Duplicate', ${historicalDuplicateEmail}, FALSE, now(), now())`;
            }
            const ambiguousLogin = await fetch(`${base}/api/auth/sign-in/email`, {
              method: "POST", headers: { "content-type": "application/json", origin },
              body: JSON.stringify({ email: historicalDuplicateEmail, password: "synthetic-password" }),
            });
            expect(ambiguousLogin.status).toBe(401);
            expect(await ambiguousLogin.json()).toEqual({
              message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD",
            });

            const concurrentEmail = `${randomUUID()}@invalid.test`;
            const concurrentPassword = randomBytes(24).toString("base64url");
            const outcomes: Array<{ status: number; body: unknown; retryAfter: number }> = [];
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const batch = await Promise.all([0, 1].map(async () => {
                const response = await fetch(`${base}/api/auth/sign-up/email`, {
                  method: "POST", headers: { "content-type": "application/json", origin },
                  body: JSON.stringify({ name: "Concurrent Native Signup", email: concurrentEmail, password: concurrentPassword }),
                });
                const retryAfter = Number(response.headers.get("x-retry-after") ?? response.headers.get("retry-after") ?? 10);
                return { status: response.status, body: await response.json(), retryAfter };
              }));
              outcomes.push(...batch);
              if (!batch.some((outcome) => outcome.status === 429)) break;
              const retrySeconds = Math.max(...batch.map((outcome) => outcome.retryAfter));
              expect(retrySeconds).toBeGreaterThanOrEqual(0);
              expect(retrySeconds).toBeLessThanOrEqual(15);
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (retrySeconds + 1) * 1000));
            }
            expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1);
            const duplicateOutcomes = outcomes.filter((outcome) => outcome.status === 422);
            expect(duplicateOutcomes.length).toBeGreaterThanOrEqual(1);
            for (const outcome of duplicateOutcomes) {
              expect(outcome.body).toEqual({
                message: "User already exists. Use another email.",
                code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
              });
            }
            expect(outcomes.every((outcome) => [200, 422, 429].includes(outcome.status))).toBe(true);
            const [concurrentCounts] = await db.$client`SELECT
                COUNT(DISTINCT u.id)::int AS users,
                COUNT(DISTINCT a.id)::int AS accounts,
                COUNT(DISTINCT s.id)::int AS sessions
              FROM "user" u
              LEFT JOIN account a ON a.user_id=u.id AND a.provider_id='credential'
              LEFT JOIN session s ON s.user_id=u.id
              WHERE u.email=${concurrentEmail}`;
            expect(concurrentCounts).toMatchObject({ users: 1, accounts: 1, sessions: 1 });

            const invalidLogin = await fetch(`${base}/api/auth/sign-in/email`, {
              method: "POST", headers: { "content-type": "application/json", origin },
              body: JSON.stringify({ email, password: `${password}-wrong` }),
            });
            expect(invalidLogin.status).toBe(401);
            expect(await invalidLogin.json()).toEqual({ message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" });
            const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
              method: "POST", headers: { "content-type": "application/json", origin },
              body: JSON.stringify({ email, password, rememberMe: remember }),
            });
            expect(signIn.status).toBe(200);
            secondCookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            secondSessionToken = (await signIn.json() as { token: string }).token;
            for (const token of [primarySessionToken, secondSessionToken]) {
              const [issuedSession] = await db.$client`SELECT
                  expires_at>now()+interval '6 days' AS remembered,
                  expires_at BETWEEN now()+interval '23 hours' AND now()+interval '25 hours' AS short_lived
                FROM session WHERE token=${token}`;
              expect(issuedSession.remembered).toBe(remember);
              expect(issuedSession.short_lived).toBe(!remember);
            }
            const noMembershipEmail = `${randomUUID()}@invalid.test`;
            const noMembershipPassword = randomBytes(24).toString("base64url");
            let noMembershipSignup: Response | undefined;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const response = await fetch(`${base}/api/auth/sign-up/email`, {
                method: "POST", headers: { "content-type": "application/json", origin },
                body: JSON.stringify({ name: "CLI No Membership", email: noMembershipEmail, password: noMembershipPassword }),
              });
              noMembershipSignup = response;
              if (response.status !== 429 || attempt === 2) break;
              const retrySeconds = Number(response.headers.get("x-retry-after") ?? response.headers.get("retry-after") ?? 10);
              expect(retrySeconds).toBeGreaterThanOrEqual(0);
              expect(retrySeconds).toBeLessThanOrEqual(15);
              await new Promise((resolve) => setTimeout(resolve, (retrySeconds + 1) * 1000));
            }
            if (!noMembershipSignup) throw new Error("No-membership Better Auth signup was not attempted");
            expect(noMembershipSignup.status).toBe(200);
            const noMembershipCookie = noMembershipSignup.headers.getSetCookie()
              .map((value) => value.split(";")[0]).join("; ");
            const noMembershipBody = await noMembershipSignup.json() as { user: { id: string } };
            noMembershipSession = { cookie: noMembershipCookie, userId: noMembershipBody.user.id };
            expect(nodePaths.length).toBe(emailAuthNodePathsAfterPrivateSignout);
          } else {
            const policy = runtime.localAccountExchangePolicy!;
            const claims = { issuer: policy.expectedIssuer, subject: randomUUID(), audience: policy.audience, installationId: "auth-launcher-test", jti: randomUUID(), expiresAt: new Date(Date.now() + 60_000), email: `${randomUUID()}@invalid.test`, emailVerified: true, name: "Native Local Launcher" };
            // Controlled exchange verifier, actual existing local session issuer.
            const issued = await localAccountAuthService(db, { ...policy, verifier: { verify: async () => claims } }).redeem("synthetic-exchange-code");
            cookie = issued.session.setCookie.split(";")[0]; userId = issued.userId; nativeSessionId = issued.session.id;
          }
          const organizationId = await exerciseCliAuthWorkflow(base, origin, cookie, userId, nativeSessionId, noMembershipSession);
          let nativeChatId: string | undefined;
          if (nativeHost) {
            nativeChatId = randomUUID();
            await db.$client`INSERT INTO chat_conversations
              (id, org_id, title, conversation_kind, created_by_user_id, status)
              VALUES (${nativeChatId}::uuid, ${organizationId}::uuid, 'Auth and Native Chat', 'chat', ${userId}, 'active')`;
          }
          await db.$client`UPDATE session SET expires_at=now()+interval '2 days' WHERE user_id=${userId}`;
          const beforeRead = nodePaths.length;
          const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
          expect(session.status).toBe(200); expect(session.headers.get("cache-control")).toBe("no-store");
          const dto = { session: { id: `rudder:session:${userId}`, userId }, user: { id: userId, email: null, name: null } };
          expect(await session.json()).toEqual(dto);
          if (issuer === "better_auth") {
            if (!primarySessionToken || !secondSessionToken) throw new Error("Expected both Better Auth session tokens");
            const [primaryRow] = await db.$client`SELECT expires_at>now()+interval '6 days' AS refreshed FROM session WHERE token=${primarySessionToken}`;
            const [secondaryRow] = await db.$client`SELECT expires_at>now()+interval '6 days' AS refreshed FROM session WHERE token=${secondSessionToken}`;
            expect(primaryRow.refreshed).toBe(remember);
            expect(secondaryRow.refreshed).toBe(false);
          } else {
            const [row] = await db.$client`SELECT expires_at>now()+interval '6 days' AS refreshed FROM session WHERE user_id=${userId}`;
            expect(row.refreshed).toBe(false);
          }
          expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie, authorization: "Bearer invalid" } })).status).toBe(401);
          expect(nodePaths.length).toBe(beforeRead);
          await closeApp();
          base = await start(config, runtime, publicPort, nativeHost);
          const afterRestart = nodePaths.length;
          expect(await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).json()).toEqual(dto);
          expect(nodePaths.length).toBe(afterRestart);
          if (nativeChatId) {
            const beforeNativeRecovery = nodePaths.length;
            const beforeNativeRecoveryAuth = betterAuthRequests.length;
            const recovery = await fetch(`${base}/api/chats/${nativeChatId}/messages/stream/recovery`, {
              headers: { cookie, origin },
            });
            expect(recovery.status).toBe(200);
            expect(await recovery.json()).toEqual({
              executionAuthority: "native_rust",
              orgId: organizationId,
              conversationId: nativeChatId,
              recovery: null,
            });
            expect(nodePaths.length).toBe(beforeNativeRecovery);
            expect(betterAuthRequests).toHaveLength(beforeNativeRecoveryAuth);
          }
          if (issuer === "better_auth") {
            const forbidden = await fetch(`${base}/api/auth/sign-out`, {
              method: "POST", headers: { cookie, origin: "https://attacker.invalid.test", "content-type": "application/json" }, body: "{}",
            });
            expect(forbidden.status).toBe(403);
            expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(200);

            // Native sign-out must not claim revocation or clear the browser
            // cookie while the backing session row cannot be deleted.
            const beforeOutage = nodePaths.length;
            await stopDatabaseProxy();
            try {
              const unavailable = await fetch(`${base}/api/auth/sign-out`, {
                method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}",
              });
              expect(unavailable.status).toBe(503);
              expect(unavailable.headers.get("retry-after")).toBe("1");
              expect(unavailable.headers.getSetCookie()).toEqual([]);
              const noSession = await fetch(`${base}/api/auth/sign-out`, {
                method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
              });
              expect(noSession.status).toBe(200);
              expect(noSession.headers.getSetCookie().length).toBeGreaterThan(0);
              expect(nodePaths.length).toBe(beforeOutage);
            } finally { await startDatabaseProxy(); }
            expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(200);
            if (secondCookie) {
              expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie: secondCookie } })).status).toBe(200);
            }
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
          const beforeLogout = nodePaths.length;
          const logout = await fetch(`${base}/api/auth/${signout}`, {
            method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}",
          });
          expect(logout.status).toBe(200);
          if (issuer === "better_auth") {
            expect(nodePaths.length).toBe(beforeLogout);
            // Replaying a correctly signed cookie after its row is gone is an
            // idempotent sign-out: the DELETE affects zero rows but still
            // clears that cookie, and cannot revoke the second session.
            const repeatedLogout = await fetch(`${base}/api/auth/sign-out`, {
              method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}",
            });
            expect(repeatedLogout.status).toBe(200);
            expect(repeatedLogout.headers.getSetCookie().length).toBeGreaterThan(0);
            expect(nodePaths.length).toBe(beforeLogout);
          } else {
            // Local-account lifecycle is Rust-owned; the private Node bridge
            // must not observe the native sign-out request.
            expect(nodePaths.length).toBe(beforeLogout);
          }
          const afterLogout = nodePaths.length;
          expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).status).toBe(401);
          if (nativeChatId) {
            const beforeSignedOutRecovery = nodePaths.length;
            const beforeSignedOutAuth = betterAuthRequests.length;
            const signedOutRecovery = await fetch(`${base}/api/chats/${nativeChatId}/messages/stream/recovery`, {
              headers: { cookie, origin },
            });
            expect(signedOutRecovery.status).toBe(401);
            expect(await signedOutRecovery.json()).toEqual({ error: "unauthorized" });
            expect(nodePaths.length).toBe(beforeSignedOutRecovery);
            expect(betterAuthRequests).toHaveLength(beforeSignedOutAuth);
          }
          if (issuer === "better_auth" && secondCookie) {
            expect((await fetch(`${base}/api/auth/get-session`, { headers: { cookie: secondCookie } })).status).toBe(200);
          }
          expect(nodePaths.length).toBe(afterLogout);
        }, 60_000);
      }
    }
  }

  it("keeps anonymous challenge access and local-trusted approval without a browser session issuer", async () => {
    const publicPort = await freePort();
    const origin = `http://127.0.0.1:${publicPort}`;
    process.env.RUDDER_PUBLIC_URL = origin;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRETS;
    delete process.env.RUDDER_AGENT_JWT_SECRET;
    const config = {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      host: "127.0.0.1",
      allowedHostnames: [],
      rustPublicIngressMode: "required",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: origin,
      authDisableSignUp: false,
    } as Config;
    const runtime = await createAuthRuntime({
      db,
      config,
      instanceId: "auth-launcher-local-trusted-test",
      ensureLocalTrustedBoardPrincipal: async () => {},
    });
    expect(runtime.browserSessionAuth).toBeUndefined();

    await db.$client`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('local-board', 'Board', 'local@rudder.local', TRUE, now(), now())
      ON CONFLICT (id) DO NOTHING`;
    await db.$client`INSERT INTO instance_user_roles (user_id, role)
      VALUES ('local-board', 'instance_admin') ON CONFLICT (user_id, role) DO NOTHING`;
    const organizationId = randomUUID();
    const issuePrefix = `LCL${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.$client`INSERT INTO organizations (id, url_key, name, issue_prefix)
      VALUES (${organizationId}, ${`local-cli-${organizationId}`}, 'Local CLI auth', ${issuePrefix})`;
    await db.$client`INSERT INTO organization_memberships
      (org_id, principal_type, principal_id, status, membership_role)
      VALUES (${organizationId}, 'user', 'local-board', 'active', 'owner')`;
    const directoryMemberId = randomUUID();
    await db.$client`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${directoryMemberId}, 'CLI Directory Member', ${`${directoryMemberId}@invalid.test`}, TRUE, now(), now())`;
    await db.$client`INSERT INTO organization_memberships
      (org_id, principal_type, principal_id, status, membership_role)
      VALUES (${organizationId}, 'user', ${directoryMemberId}, 'active', 'member')`;

    const base = await start(config, runtime, publicPort);
    const nodeStart = nodePaths.length;
    const created = await fetch(`${base}/api/cli-auth/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "rudder orgs list",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: organizationId,
      }),
    });
    expect(created.status).toBe(201);
    const challenge = await created.json() as { id: string; token: string; boardApiToken: string };
    const looksGenerated = (value: string, prefix: string) =>
      value.startsWith(prefix) && /^[0-9a-f]{48}$/.test(value.slice(prefix.length));
    expect(looksGenerated(challenge.token, "pcp_cli_auth_")).toBe(true);
    expect(looksGenerated(challenge.boardApiToken, "pcp_board_")).toBe(true);
    const poll = await fetch(`${base}/api/cli-auth/challenges/${challenge.id}?token=${encodeURIComponent(challenge.token)}`);
    expect(await poll.json()).toMatchObject({
      status: "pending",
      requiresSignIn: false,
      canApprove: true,
      currentUserId: "local-board",
    });
    const approval = await fetch(`${base}/api/cli-auth/challenges/${challenge.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: challenge.token }),
    });
    expect(approval.status).toBe(200);
    expect((await approval.json() as { approved: boolean }).approved).toBe(true);
    const me = await fetch(`${base}/api/cli-auth/me`, {
      headers: { authorization: `Bearer ${challenge.boardApiToken}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ userId: "local-board", isInstanceAdmin: true, orgIds: [organizationId] });
    expect(nodePaths.length).toBe(nodeStart);

    // Exercise the actual source-built CLI against the same public Rust
    // listener. The CLI has no TTY and cannot launch a browser; this test
    // approves the challenge through the public endpoint below.
    const cliNodeStart = nodePaths.length;
    const betterAuthStart = betterAuthRequests.length;
    const cliHome = await mkdtemp(path.join(temporary, "rudder-cli-home-"));
    const cliEnvironment = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      HOME: cliHome,
      USERPROFILE: cliHome,
      RUDDER_HOME: cliHome,
      RUDDER_CLI_HTTP_TIMEOUT_MS: "5000",
    };
    const maxCliOutputBytes = 512 * 1024;
    type CliResult = {
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      outputLimitExceeded: boolean;
      spawnFailed: boolean;
    };
    const startCli = (args: string[], timeoutMs = 70_000) => {
      const child = spawn(cliBinary, [...args, "--api-base", base, "--json"], {
        cwd: repositoryRoot,
        env: cliEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let timedOut = false;
      let outputLimitExceeded = false;
      let spawnFailed = false;
      const stderrWaiters = new Set<() => void>();
      const appendBounded = (current: Buffer, chunk: Buffer) => {
        if (current.length + chunk.length > maxCliOutputBytes) {
          outputLimitExceeded = true;
          child.kill("SIGKILL");
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
        for (const waiter of stderrWaiters) waiter();
      });
      let killTimer: ReturnType<typeof setTimeout>;
      const completion = new Promise<CliResult>((resolve) => {
        child.once("error", () => {
          spawnFailed = true;
        });
        child.once("close", (code, signal) => {
          clearTimeout(killTimer);
          resolve({
            code,
            signal,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            timedOut,
            outputLimitExceeded,
            spawnFailed,
          });
        });
      });
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const waitForApprovalUrl = () => {
        const findUrl = () => stderr.toString("utf8").match(/https?:\/\/[^\s]+\/cli-auth\/[^\s?#]+\?token=[^\s]+/)?.[0];
        const existing = findUrl();
        if (existing) return Promise.resolve(existing);
        return new Promise<string>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            clearTimeout(waitTimer);
            stderrWaiters.delete(check);
          };
          const check = () => {
            const found = findUrl();
            if (found && !settled) {
              settled = true;
              cleanup();
              resolve(found);
            }
          };
          const waitTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error("CLI did not print its approval URL in time"));
            }
          }, 20_000);
          stderrWaiters.add(check);
          void completion.then(() => {
            check();
            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error("CLI exited before requesting approval"));
            }
          });
        });
      };
      return { child, completion, waitForApprovalUrl };
    };
    const requireCliSuccess = (result: CliResult) => {
      if (result.spawnFailed) throw new Error("source-built rudder-cli could not start");
      if (result.timedOut) throw new Error("source-built rudder-cli exceeded its execution timeout");
      if (result.outputLimitExceeded) throw new Error("source-built rudder-cli exceeded its output limit");
      if (result.code !== 0) throw new Error(`source-built rudder-cli exited with status ${result.code ?? result.signal}`);
      try {
        return JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {
        throw new Error("source-built rudder-cli did not return valid JSON");
      }
    };

    const login = startCli(["auth", "login", "--no-browser"]);
    try {
      const approvalText = await login.waitForApprovalUrl();
      const approvalUrl = new URL(approvalText);
      expect(approvalUrl.origin === new URL(base).origin).toBe(true);
      const challengeMatch = approvalUrl.pathname.match(/^\/cli-auth\/([0-9a-f-]+)$/i);
      if (!challengeMatch) throw new Error("CLI printed an invalid challenge path");
      const challengeId = challengeMatch[1];
      if (!challengeId) throw new Error("CLI printed an invalid challenge id");
      const challengeToken = approvalUrl.searchParams.get("token");
      if (!challengeToken) throw new Error("CLI approval URL omitted its challenge token");

      const cliApproval = await fetch(`${base}/api/cli-auth/challenges/${challengeId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: challengeToken }),
      });
      expect(cliApproval.status).toBe(200);
      expect(await cliApproval.json()).toMatchObject({ approved: true, status: "approved" });

      const loginResult = await login.completion;
      const loginJson = requireCliSuccess(loginResult);
      expect(loginJson.ok === true).toBe(true);
      expect(loginJson.apiBase === base).toBe(true);
      expect(loginJson.userId === "local-board").toBe(true);

      const storePath = path.join(cliHome, "auth.json");
      const saved = JSON.parse(await readFile(storePath, "utf8")) as {
        credentials?: Record<string, { token?: string; userId?: string }>;
      };
      const boardToken = saved.credentials?.[base]?.token;
      if (!boardToken) throw new Error("CLI did not persist its approved board credential");
      expect(boardToken.startsWith("pcp_board_")).toBe(true);
      expect(loginResult.stdout.includes(boardToken)).toBe(false);
      expect(loginResult.stderr.includes(boardToken)).toBe(false);
      const boardTokenHash = createHash("sha256").update(boardToken).digest("hex");
      const issuedRows = await db.$client`SELECT c.pending_key_hash, c.board_api_key_id::text AS key_id,
          c.approved_by_user_id, k.key_hash, k.user_id, k.revoked_at
        FROM cli_auth_challenges c
        JOIN board_api_keys k ON k.id = c.board_api_key_id
        WHERE c.id = ${challengeId}::uuid`;
      const issued = issuedRows[0];
      if (!issued) throw new Error("CLI challenge did not persist an issued key");
      expect(issued.pending_key_hash === boardTokenHash).toBe(true);
      expect(issued.key_hash === boardTokenHash).toBe(true);
      expect(issued.approved_by_user_id).toBe("local-board");
      expect(issued.user_id).toBe("local-board");
      expect(issued.revoked_at).toBeNull();

      const whoami = startCli(["auth", "whoami"]);
      const whoamiResult = await whoami.completion;
      expect(requireCliSuccess(whoamiResult)).toMatchObject({
        userId: "local-board",
        isInstanceAdmin: true,
        orgIds: [organizationId],
      });

      const members = startCli(["org", "members", "--org-id", organizationId, "--full-ids"]);
      const membersResult = await members.completion;
      const memberPage = requireCliSuccess(membersResult) as {
        total?: number;
        items?: Array<{ name?: string; type?: string; role?: string; ref?: string }>;
      };
      expect(memberPage.total).toBe(1);
      expect(memberPage.items).toEqual([
        expect.objectContaining({ name: "CLI Directory Member", type: "human", role: "member", ref: directoryMemberId }),
      ]);

      const logout = startCli(["auth", "logout"]);
      const logoutResult = await logout.completion;
      expect(requireCliSuccess(logoutResult)).toMatchObject({
        ok: true,
        revoked: true,
        removedLocalCredential: true,
      });
      const afterLogout = JSON.parse(await readFile(storePath, "utf8")) as {
        credentials?: Record<string, { token?: string }>;
      };
      expect(afterLogout.credentials?.[base]).toBeUndefined();
      const revokedRows = await db.$client`SELECT revoked_at FROM board_api_keys WHERE id = ${issued.key_id}::uuid`;
      expect(revokedRows.length).toBe(1);
      expect(revokedRows[0]?.revoked_at == null).toBe(false);

      // Local-trusted deliberately resolves missing browser credentials as
      // its implicit Board identity. After logout the actual CLI has no stored
      // credential, so whoami must fail locally instead of claiming auth or
      // opening a browser. Issuer-backed revoked-key HTTP 401 is covered by
      // the authenticated launcher cases above.
      const missingCredential = startCli(["auth", "whoami"]);
      const missingResult = await missingCredential.completion;
      expect(missingResult.spawnFailed).toBe(false);
      expect(missingResult.timedOut).toBe(false);
      expect(missingResult.outputLimitExceeded).toBe(false);
      expect(missingResult.code === 0).toBe(false);
      let missingError: { error?: string; status?: number | null; code?: string };
      try {
        missingError = JSON.parse(missingResult.stderr) as { error?: string; status?: number | null; code?: string };
      } catch {
        throw new Error("CLI without a stored credential did not return a JSON error");
      }
      expect(missingError.status === null).toBe(true);
      expect(missingError.code === "cli_error").toBe(true);
      expect(missingError.error === "Board credential is required. Run rudder-cli auth login or supply --api-key.").toBe(true);

      const nodeRequests = nodePaths.slice(cliNodeStart).map((requestPath) => requestPath.split("?", 1)[0]);
      const betterAuthPaths = betterAuthRequests.slice(betterAuthStart).map((requestPath) => requestPath.split("?", 1)[0]);
      expect(nodeRequests).toEqual([]);
      expect(betterAuthPaths).toEqual([]);
    } finally {
      if (login.child.exitCode === null && login.child.signalCode === null) {
        login.child.kill("SIGKILL");
        await login.completion;
      }
    }
  }, 120_000);
});
