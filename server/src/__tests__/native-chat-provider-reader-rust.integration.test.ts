import {
  agents,
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  organizationMemberships,
  organizations,
} from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { registerChatMessageQueryRoutes } from "../routes/chats.message-query-routes.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// This exercises the actual authenticated Express transcript route, its signed
// Rust bridge, Rust's exact-turn planner, and a synthetic process owned by the
// installed-Codex runtime boundary. No real provider or Node business fallback.
type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type PgConstructor = new (options: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
  initdbFlags: string[]; postgresFlags: string[]; onLog: () => void; onError: () => void;
}) => Pg;
type TranscriptResult = { status: number; body: Record<string, unknown> };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const THREAD_ID = "codex-reader-public-thread";
const TURN_ID = "codex-reader-public-old-turn";
const LATEST_TURN_ID = "codex-reader-public-latest-turn";
const SESSION_SECRET = "codex-reader-browser-session-fixture-secret";

async function buildCandidate() {
  const child = spawn("cargo", [
    "build", "--locked", ...(process.env.CI ? ["--release"] : []), "--manifest-path", path.join(root, "native/Cargo.toml"),
    "--bin", "rudder-server-foundation", "--bin", "rudder-process-host", "--bin", "rudder-cli", "--message-format=json",
  ], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const binaries = new Map<string, string>();
  let diagnostics = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const artifact = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string };
      if (artifact.reason === "compiler-artifact" && artifact.executable && artifact.target?.name) {
        binaries.set(artifact.target.name, artifact.executable);
      }
    } catch { /* Cargo may emit non-JSON progress in future versions. */ }
  });
  child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk}`.slice(-5000); });
  const [code] = await once(child, "exit");
  lines.close();
  if (code !== 0 || !binaries.has("rudder-server-foundation") || !binaries.has("rudder-process-host")) {
    throw new Error(`Native Codex Reader candidate build failed: ${diagnostics}`);
  }
  return binaries.get("rudder-server-foundation")!;
}

async function freePort() {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No disposable test port");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function closeServer(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function waitForFile(file: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for synthetic Codex signal: ${path.basename(file)}`);
}

describe("Codex exact-turn transcript through public Rust-backed HTTP", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Pg | undefined;
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let temporary = "";
  let databaseUrl = "";
  let binary = "";
  let nodeUrl = "";
  let instanceRoot = "";
  let fakeBin = "";
  let oldProfileHome = "";
  let switchedProfileHome = "";
  let modeFile = "";
  let readStartedFile = "";
  let releaseReadFile = "";
  let readerPidFile = "";
  let allowNodeAssociationForOutsider = false;
  let rustTranscriptCalls = 0;
  const previousHome = process.env.RUDDER_HOME;
  const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
  const orgId = randomUUID();
  const agentId = randomUUID();
  const switchedAgentId = randomUUID();
  const chatId = randomUUID();
  const foreignChatId = randomUUID();
  const foreignAssistantMessageId = randomUUID();
  const sourceMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const generationId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const spanId = randomUUID();
  const owner = `codex-reader-owner-${randomUUID()}`;
  const outsider = `codex-reader-outsider-${randomUUID()}`;
  const token = `codex-reader-board-${randomUUID()}`;
  const outsiderToken = `codex-reader-outsider-${randomUUID()}`;
  const sessionToken = `codex-reader-session-${randomUUID()}`;
  const sessionId = randomUUID();
  const instanceId = `codex-reader-${randomUUID()}`;

  async function seedTerminalTranscript(bindingId: string, segmentId: string) {
    await db.execute(sql`INSERT INTO heartbeat_runs
      (id,org_id,agent_id,status,started_at,chat_conversation_id,execution_owner_token,execution_lease_expires_at)
      VALUES (${runId}::uuid,${orgId}::uuid,${agentId}::uuid,'running',clock_timestamp(),${chatId}::uuid,
        'reader-test-owner',clock_timestamp()+interval '1 hour')`);
    await db.execute(sql`INSERT INTO heartbeat_run_attempts
      (id,org_id,run_id,agent_id,attempt_index,runtime_type,status,owner_token,attempt_epoch)
      VALUES (${attemptId}::uuid,${orgId}::uuid,${runId}::uuid,${agentId}::uuid,0,'codex_local','started',
        'reader-test-owner',7)`);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('rudder.native_chat_write','native_chat:provider_reader_e2e',true)`);
      await tx.execute(sql`INSERT INTO chat_messages
        (id,org_id,conversation_id,role,kind,status,body,turn_variant)
        VALUES (${sourceMessageId}::uuid,${orgId}::uuid,${chatId}::uuid,'user','message','completed','fixture prompt',0)`);
      await tx.execute(sql`INSERT INTO chat_generations
        (id,org_id,conversation_id,execution_authority,source_message_id,source_turn_variant,
         status,terminal_reason,control_state,attempt_epoch,provider_thread_id,provider_turn_id,
         runtime_terminal_at,completed_at)
        VALUES (${generationId}::uuid,${orgId}::uuid,${chatId}::uuid,'native_rust',${sourceMessageId}::uuid,0,
         'completed','native_provider_succeeded','terminal',7,${THREAD_ID},${TURN_ID},clock_timestamp(),clock_timestamp())`);
      await tx.execute(sql`INSERT INTO chat_messages
        (id,org_id,conversation_id,role,kind,status,body,run_id,replying_agent_id,turn_variant)
        VALUES (${assistantMessageId}::uuid,${orgId}::uuid,${chatId}::uuid,'assistant','message','completed',
          'fixture answer',${runId}::uuid,${agentId}::uuid,0)`);
      await tx.execute(sql`INSERT INTO chat_generation_events
        (org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id)
        VALUES (${orgId}::uuid,${generationId}::uuid,1,7,'terminal_projected',
          '{"status":"succeeded","generationStatus":"completed"}'::jsonb,
          ${assistantMessageId}::uuid,${runId}::uuid)`);
      await tx.execute(sql`UPDATE heartbeat_runs
        SET status='succeeded',finished_at=clock_timestamp(),process_exited_at=clock_timestamp(),
            execution_lease_expires_at=NULL,chat_generation_id=${generationId}::uuid,
            execution_authority='native_rust',scene='chat',target_type='chat_conversation',target_id=${chatId},
            idempotency_key='provider-reader-e2e',
            session_intent_json='{"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null}'::jsonb,
            native_admission_hold=false
        WHERE org_id=${orgId}::uuid AND id=${runId}::uuid`);
      await tx.execute(sql`UPDATE heartbeat_run_attempts
        SET status='succeeded',finished_at=clock_timestamp(),generation_attempt_epoch=7,connection_epoch=3,
            protocol_phase='execution_terminal_committed',
            checkpoint_json=${JSON.stringify({ phase: "execution_terminal_committed", revision: 1, threadId: THREAD_ID, turnId: TURN_ID })}::jsonb,
            provider_thread_id=${THREAD_ID},provider_turn_id=${TURN_ID}
        WHERE org_id=${orgId}::uuid AND run_id=${runId}::uuid AND id=${attemptId}::uuid`);
      await tx.execute(sql`UPDATE native_segments SET state='open',native_session_id=${THREAD_ID}
        WHERE org_id=${orgId}::uuid AND binding_id=${bindingId}::uuid AND id=${segmentId}::uuid`);
      await tx.execute(sql`INSERT INTO run_runtime_spans
        (id,org_id,run_id,binding_id,segment_id,attempt_id,attempt_ref,attempt_epoch,owner_token,ordinal,
         relation,native_execution_ref,selector_json,state,completeness,closed_at)
        VALUES (${spanId}::uuid,${orgId}::uuid,${runId}::uuid,${bindingId}::uuid,${segmentId}::uuid,
         ${attemptId}::uuid,${attemptId},7,'reader-test-owner',0,'primary',${TURN_ID},
         ${JSON.stringify({ kind: "codex_turn", threadId: THREAD_ID, turnId: TURN_ID })}::jsonb,
         'sealed','terminal_only',clock_timestamp())`);
    });
  }

  async function transcript(authToken = token): Promise<TranscriptResult> {
    const response = await request(server!)
      .get(`/api/chats/${chatId}/messages/${assistantMessageId}/transcript`)
      .set("authorization", `Bearer ${authToken}`);
    return { status: response.status, body: response.body as Record<string, unknown> };
  }

  async function messages(authToken = token) {
    const response = await request(server!)
      .get(`/api/chats/${chatId}/messages?limit=200`)
      .set("authorization", `Bearer ${authToken}`);
    return { status: response.status, body: response.body as Array<Record<string, unknown>> };
  }

  async function businessCounts() {
    const [row] = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM chat_messages WHERE org_id=${orgId}::uuid AND conversation_id=${chatId}::uuid) AS messages,
      (SELECT count(*)::int FROM chat_generations WHERE org_id=${orgId}::uuid AND conversation_id=${chatId}::uuid) AS generations,
      (SELECT count(*)::int FROM heartbeat_runs WHERE org_id=${orgId}::uuid AND chat_conversation_id=${chatId}::uuid) AS runs,
      (SELECT count(*)::int FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
        WHERE r.org_id=${orgId}::uuid AND r.chat_conversation_id=${chatId}::uuid) AS attempts,
      (SELECT count(*)::int FROM chat_control_actions WHERE org_id=${orgId}::uuid AND expected_generation_id=${generationId}::uuid) AS "controlActions",
      (SELECT count(*)::int FROM cost_events c JOIN heartbeat_runs r ON r.org_id=c.org_id AND r.id=c.heartbeat_run_id
        WHERE r.org_id=${orgId}::uuid AND r.chat_conversation_id=${chatId}::uuid) AS costs`);
    return row;
  }

  async function businessRows() {
    const [runs, attempts, controlActions, costs] = await Promise.all([
      db.execute(sql`SELECT to_jsonb(r) AS row FROM heartbeat_runs r
        WHERE r.org_id=${orgId}::uuid AND r.chat_conversation_id=${chatId}::uuid ORDER BY r.id`),
      db.execute(sql`SELECT to_jsonb(a) AS row FROM heartbeat_run_attempts a
        JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
        WHERE r.org_id=${orgId}::uuid AND r.chat_conversation_id=${chatId}::uuid ORDER BY a.id`),
      db.execute(sql`SELECT to_jsonb(c) AS row FROM chat_control_actions c
        WHERE c.org_id=${orgId}::uuid AND c.expected_generation_id=${generationId}::uuid ORDER BY c.id`),
      db.execute(sql`SELECT to_jsonb(c) AS row FROM cost_events c
        JOIN heartbeat_runs r ON r.org_id=c.org_id AND r.id=c.heartbeat_run_id
        WHERE r.org_id=${orgId}::uuid AND r.chat_conversation_id=${chatId}::uuid ORDER BY c.id`),
    ]);
    return { runs, attempts, controlActions, costs };
  }

  async function generationControlState() {
    const [row] = await db.execute(sql`SELECT status,terminal_reason,control_state,control_version,
      accepted_through_seq,stop_requested_at,runtime_terminal_at
      FROM chat_generations WHERE org_id=${orgId}::uuid AND id=${generationId}::uuid`);
    return row;
  }

  function ownerSessionCookie() {
    const signature = createHmac("sha256", SESSION_SECRET).update(sessionToken).digest("base64");
    return `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`;
  }

  async function publicStop() {
    return request(bridge!.publicIngressBaseUrl!)
      .post(`/api/chats/${chatId}/messages/stream/stop`)
      .set("cookie", ownerSessionCookie())
      .set("origin", nodeUrl)
      .send({
        controlActionId: randomUUID(),
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 7,
        expectedControlVersion: 0,
        lastCommittedRenderSeq: 0,
        renderedBodyHash: createHash("sha256").update("").digest("hex"),
      });
  }

  function expectReaderExited() {
    const pid = Number(fs.readFileSync(readerPidFile, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw error;
    }
    expect(alive).toBe(false);
  }

  function rpcLog(profile = oldProfileHome): Array<Record<string, unknown>> {
    const file = path.join(profile, "reader-rpc.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function readRequests(profile = oldProfileHome) {
    return rpcLog(profile).filter((entry) => (entry as { method?: string }).method === "thread/read");
  }

  async function addFilteredLedgerRow() {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('rudder.native_chat_write','native_chat:provider_reader_ledger_fixture',true)`);
      await tx.execute(sql`INSERT INTO chat_generation_events
        (org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id)
        VALUES (${orgId}::uuid,${generationId}::uuid,99,7,'assistant_delta','{}'::jsonb,
          ${assistantMessageId}::uuid,${runId}::uuid)`);
    });
  }

  async function removeFilteredLedgerRow() {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('rudder.native_chat_write','native_chat:provider_reader_ledger_fixture',true)`);
      await tx.execute(sql`DELETE FROM chat_generation_events
        WHERE org_id=${orgId}::uuid AND generation_id=${generationId}::uuid AND generation_seq=99`);
    });
  }

  beforeAll(async () => {
    binary = await buildCandidate();
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-native-codex-reader-public-"));
    process.env.RUDDER_HOME = path.join(temporary, "rudder-home");
    process.env.RUDDER_INSTANCE_ID = instanceId;
    instanceRoot = path.join(temporary, "instance");
    const workspaceHome = path.join(temporary, "workspace");
    const operatorHome = path.join(temporary, "operator");
    fakeBin = path.join(temporary, "bin");
    for (const directory of [instanceRoot, workspaceHome, operatorHome, path.join(operatorHome, ".codex"), fakeBin]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const organizationKey = orgId.replaceAll("-", "").slice(0, 12).toLowerCase();
    const codexHomes = path.join(instanceRoot, "organizations", organizationKey, "codex-home", "agents");
    oldProfileHome = path.join(codexHomes, agentId);
    switchedProfileHome = path.join(codexHomes, switchedAgentId);
    for (const directory of [oldProfileHome, switchedProfileHome]) fs.mkdirSync(directory, { recursive: true });
    modeFile = path.join(oldProfileHome, "reader-mode");
    readStartedFile = path.join(oldProfileHome, "read-started");
    releaseReadFile = path.join(oldProfileHome, "release-read");
    readerPidFile = path.join(oldProfileHome, "reader-pid");

    const fakeCodex = `#!${process.execPath}\nconst fs=require("node:fs");\nconst path=require("node:path");\nconst readline=require("node:readline");\nconst home=process.env.CODEX_HOME;\nconst log=path.join(home,"reader-rpc.jsonl");\nconst modeFile=path.join(home,"reader-mode");\nfs.writeFileSync(path.join(home,"reader-pid"),String(process.pid));\nconst send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");\nconst turns=[\n {id:${JSON.stringify(LATEST_TURN_ID)},status:"completed",itemsView:"full",items:[{type:"agentMessage",id:"latest-message",phase:"final_answer",text:"Latest answer must not be substituted"}]},\n {id:${JSON.stringify(TURN_ID)},status:"completed",itemsView:"full",items:[{type:"userMessage",id:"old-user",content:[{type:"text",text:"private user prompt"}]},{type:"agentMessage",id:"old-final",phase:"final_answer",text:"Old exact Codex answer"},{type:"reasoning",id:"private-reasoning",content:["PRIVATE_REASONING_MUST_NOT_LEAK"],summary:["PRIVATE_REASONING_SUMMARY_MUST_NOT_LEAK"]},{type:"commandExecution",id:"old-command",command:"printf old",commandActions:[],cwd:"/fixture",aggregatedOutput:"Old command stdout and stderr",exitCode:0,status:"completed"}]}\n];\nreadline.createInterface({input:process.stdin}).on("line",async(line)=>{\n let message; try{message=JSON.parse(line)}catch{return}\n fs.appendFileSync(log,JSON.stringify({...message,home})+"\\n");\n if(message.method==="initialize"){send({jsonrpc:"2.0",id:message.id,result:{codexHome:home}});return}\n if(message.method==="initialized")return;\n if(message.method!=="thread/read")return;\n const mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,"utf8").trim():"ok";\n if(mode==="block"){fs.writeFileSync(path.join(home,"read-started"),"started");while(!fs.existsSync(path.join(home,"release-read")))await new Promise(r=>setTimeout(r,10));}\n if(mode==="malformed"){send({jsonrpc:"2.0",id:message.id,result:{thread:{id:message.params.threadId,turns:[{id:"malformed-turn",status:"completed",itemsView:"full",items:"invalid-items"}]}}});return}\n if(mode==="malformed-wire"){process.stdout.write("{malformed-wire\\n");return}\n if(mode==="unsupported"){send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"unsupported"}});return}\n const selected=mode==="unhydrated"?turns.map(t=>t.id===${JSON.stringify(TURN_ID)}?{...t,itemsView:"summary"}:t):["interrupted","failed","inProgress"].includes(mode)?turns.map(t=>t.id===${JSON.stringify(TURN_ID)}?{...t,status:mode}:t):turns;\n send({jsonrpc:"2.0",id:message.id,result:{thread:{id:message.params.threadId,turns:selected}}});\n});\n`;
    const codexExecutable = path.join(fakeBin, "codex");
    fs.writeFileSync(codexExecutable, fakeCodex, { mode: 0o755 });
    fs.chmodSync(codexExecutable, 0o755);

    const port = await freePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as PgConstructor;
    pg = new EmbeddedPostgres({
      databaseDir: path.join(temporary, "pg"), user: "rudder", password: "rudder", port,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-k", ""],
      onLog: () => {}, onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    databaseUrl = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);
    await db.insert(organizations).values({ id: orgId, name: "Reader E2E", urlKey: `reader-${orgId}`, issuePrefix: "RDR" });
    await db.insert(authUsers).values([owner, outsider].map((id) => ({
      id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.execute(sql`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at)
      VALUES (${sessionId},${sessionToken},${owner},now()+interval '1 hour',now(),now())`);
    await db.insert(organizationMemberships).values({
      orgId, principalType: "user", principalId: owner, status: "active", membershipRole: "member",
    });
    await db.insert(boardApiKeys).values([
      { userId: owner, name: "Reader owner", keyHash: createHash("sha256").update(token).digest("hex") },
      { userId: outsider, name: "Reader outsider", keyHash: createHash("sha256").update(outsiderToken).digest("hex") },
    ]);
    await db.insert(agents).values([
      { id: agentId, orgId, name: "Historical Codex Agent", role: "general", status: "idle", agentRuntimeType: "codex_local" },
      { id: switchedAgentId, orgId, name: "Current Codex Agent", role: "general", status: "idle", agentRuntimeType: "codex_local" },
    ]);
    await db.insert(chatConversations).values([
      { id: chatId, orgId, title: "Exact-turn transcript", preferredAgentId: agentId, createdByUserId: owner },
      { id: foreignChatId, orgId, title: "Other transcript conversation", preferredAgentId: agentId, createdByUserId: owner },
    ]);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('rudder.native_chat_write','native_chat:reader_association_fixture',true)`);
      await tx.execute(sql`INSERT INTO chat_messages
        (id,org_id,conversation_id,role,kind,status,body,turn_variant)
        VALUES (${foreignAssistantMessageId}::uuid,${orgId}::uuid,${foreignChatId}::uuid,
          'assistant','message','completed','Other conversation answer',0)`);
    });

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing Express test listener");
    nodeUrl = `http://127.0.0.1:${address.port}`;

    bridge = createRustFoundationBridge({
      databaseUrl, binaryPath: binary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off",
      requestTimeoutMs: 15_000,
      publicIngress: {
        listenAddr: "127.0.0.1:0",
        nodeUpstream: nodeUrl,
        publicApiUrl: nodeUrl,
        authPublicBaseUrl: nodeUrl,
        authorizationKey: "codex-reader-public-ingress-fixture-key-32-bytes",
        deploymentMode: "authenticated",
        sessionAuth: {
          kind: "better_auth",
          secret: SESSION_SECRET,
          secureCookie: false,
          assertionKey: "44".repeat(32),
        },
        browserSessionAuth: {
          issuer: "better_auth",
          secret: SESSION_SECRET,
          secureCookie: false,
          sessionCookieName: "better-auth.session_token",
          dontRememberCookieName: "better-auth.dont_remember",
          expiresIn: 7 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
          disableSessionRefresh: false,
          trustedOrigins: Object.freeze(["http://127.0.0.1"]),
          disableSignUp: false,
          rateLimitEnabled: false,
        },
        identityAuth: {
          assertionKey: "44".repeat(32), agentJwtSecret: "codex-reader-agent-jwt-fixture-secret",
          agentJwtIssuer: "rudder", agentJwtAudience: "rudder-api", localImplicitEnabled: false,
        },
        nativeChatHost: {
          instanceId, instanceRoot, workspaceHome, operatorHome,
          codexHome: path.join(operatorHome, ".codex"),
          executableSearchPath: `${fakeBin}:/usr/bin:/bin`,
          friendlyWorkspaceHome: false,
          deploymentMode: "authenticated", deploymentExposure: "private", authRequirement: "required",
          trustedOrigins: [nodeUrl],
        },
      },
    });
    await bridge.start();
    const nativeTranscript = bridge.nativeChatTranscript!.bind(bridge);
    bridge.nativeChatTranscript = async (actor, organizationId, input) => {
      rustTranscriptCalls += 1;
      return nativeTranscript(actor, organizationId, input);
    };
    const router = express.Router();
    registerChatMessageQueryRoutes({
      router,
      svc: {},
      rustFoundationBridge: bridge,
      assertConversationAccess: async (req: any, conversationId: string) => {
        const [conversation] = await db.select().from(chatConversations)
          .where(eq(chatConversations.id, conversationId)).limit(1);
        if (!conversation || req.actor?.type !== "board") return null;
        if (!allowNodeAssociationForOutsider && !req.actor.orgIds?.includes(conversation.orgId)) return null;
        return { ...conversation, mutability: "native_chat" };
      },
    });
    app.use("/api", router);
    app.use(errorHandler);
    const actor = {
      type: "board" as const, userId: owner, source: "board_key" as const,
      sessionId: "codex-reader-public-e2e", authEpoch: 1,
    };
    const bound = await bridge.runtimeBinding!(actor, orgId, {
      operation: "ensure", target: { targetType: "chat_conversation", targetId: chatId },
      identity: { agentId, profileId: "default" },
    });
    expect(bound.status).toBe(200);
    const bindingResult = JSON.parse(bound.body.toString("utf8")) as { binding: { id: string }; segment: { id: string } };
    // Binding.ensure starts before runtime admission has resolved a concrete
    // provider profile. This fixture pins the durable identity that a
    // terminal Native attempt records after admission.
    await db.execute(sql`UPDATE runtime_bindings
      SET profile_id=${`managed-codex:${agentId}:default`},host_id=${`local:${instanceId}`}
      WHERE org_id=${orgId}::uuid AND id=${bindingResult.binding.id}::uuid`);
    const persistedBinding = await db.execute(sql`SELECT profile_id,host_id FROM runtime_bindings WHERE org_id=${orgId}::uuid AND id=${bindingResult.binding.id}::uuid`);
    expect(persistedBinding[0].profile_id).toBe(`managed-codex:${agentId}:default`);
    expect(persistedBinding[0].host_id).toBe(`local:${instanceId}`);
    await seedTerminalTranscript(bindingResult.binding.id, bindingResult.segment.id);
  }, 180_000);

  afterAll(async () => {
    try {
      await bridge?.close();
      await closeServer(server);
      await db?.$client.end({ timeout: 5 });
      await pg?.stop();
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.RUDDER_HOME; else process.env.RUDDER_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID; else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
    }
  }, 30_000);

  it("reads one exact old turn, reports incomplete sources, fences Stop, and never writes transcripts or submits prompts", async () => {
    const initialEvents = await db.execute(sql`SELECT count(*)::int AS count FROM chat_generation_events WHERE org_id=${orgId}::uuid`);
    expect(initialEvents[0].count).toBe(1);
    const beforeMessages = await db.execute(sql`SELECT to_jsonb(m) AS row FROM chat_messages m WHERE org_id=${orgId}::uuid ORDER BY id`);

    const listed = await messages();
    expect(listed.status).toBe(200);
    const listedAssistant = listed.body.find((message) => message.id === assistantMessageId);
    expect(listedAssistant?.transcriptSummary).toEqual({
      entryCount: 0,
      startedAt: null,
      endedAt: null,
      providerSource: "codex",
    });
    expect(rpcLog()).toEqual([]);

    // Node accepts the requested chat, but the real Rust authority rejects
    // an existing assistant message whose conversation association is forged.
    const rustCallsBeforeAssociation = rustTranscriptCalls;
    const forged = await request(server!)
      .get(`/api/chats/${chatId}/messages/${foreignAssistantMessageId}/transcript`)
      .set("authorization", `Bearer ${token}`);
    expect(forged.status).toBe(404);
    expect(rustTranscriptCalls).toBe(rustCallsBeforeAssociation + 1);
    expect(readRequests()).toHaveLength(0);
    expect(forged.body.transcript).toBeUndefined();

    const exact = await transcript();
    expect(exact.status).toBe(200);
    expect(exact.body.reader).toMatchObject({ source: "codex_exact_turn", availability: "complete", completeness: "terminal_only" });
    const entries = exact.body.transcript as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.text === "Old exact Codex answer")).toBe(true);
    expect(entries.some((entry) => entry.text === "Latest answer must not be substituted")).toBe(false);
    expect(JSON.stringify(exact.body)).not.toContain("private user prompt");
    expect(JSON.stringify(exact.body)).not.toContain("PRIVATE_REASONING_MUST_NOT_LEAK");
    expect(JSON.stringify(exact.body)).not.toContain("PRIVATE_REASONING_SUMMARY_MUST_NOT_LEAK");
    expect(entries.some((entry) => entry.kind === "tool_call")).toBe(true);
    expect(entries.some((entry) => entry.kind === "tool_result" && entry.content === "Old command stdout and stderr")).toBe(true);
    expect(JSON.stringify(exact.body)).not.toContain("No command output");
    expectReaderExited();
    const firstRead = readRequests();
    expect(firstRead).toHaveLength(1);
    expect(firstRead[0].params).toEqual({ threadId: THREAD_ID, includeTurns: true });
    expect(rpcLog().map((entry) => entry.method)).toEqual(["initialize", "initialized", "thread/read"]);
    expect(await db.execute(sql`SELECT count(*)::int AS count FROM chat_generation_events WHERE org_id=${orgId}::uuid`)).toEqual(initialEvents);
    expect(await db.execute(sql`SELECT to_jsonb(m) AS row FROM chat_messages m WHERE org_id=${orgId}::uuid ORDER BY id`)).toEqual(beforeMessages);

    // A preferred-Agent switch does not change the historical binding's
    // profile or provider home for this completed turn.
    await db.update(chatConversations).set({ preferredAgentId: switchedAgentId }).where(eq(chatConversations.id, chatId));
    const switched = await transcript();
    expect(switched.status).toBe(200);
    expect(switched.body.reader).toMatchObject({ source: "codex_exact_turn", availability: "complete" });
    expect(readRequests()).toHaveLength(2);
    expect(readRequests(switchedProfileHome)).toHaveLength(0);
    expectReaderExited();

    for (const [mode, reason] of [
      ["unsupported", "provider_read_unsupported"],
      ["malformed", "provider_response_malformed"],
      ["unhydrated", "provider_turn_unhydrated"],
      ["interrupted", "provider_turn_not_completed"],
      ["failed", "provider_turn_not_completed"],
      ["inProgress", "provider_turn_not_completed"],
    ] as const) {
      fs.writeFileSync(modeFile, mode);
      const response = await transcript();
      expect(response.status).toBe(200);
      expect(response.body.reader).toMatchObject({ availability: "incomplete", reason });
      expect(response.body.transcript).toEqual([]);
    }

    // An invalid JSON-RPC frame makes the transport fail closed before it can
    // consume a correlated cleanup receipt. Preserve the explicit incomplete
    // result and verify that the owned provider process is still gone.
    const readsBeforeMalformedWire = readRequests().length;
    const previousReaderPid = fs.readFileSync(readerPidFile, "utf8");
    fs.writeFileSync(modeFile, "malformed-wire");
    const malformedWire = await transcript();
    expect(malformedWire.status).toBe(200);
    expect(malformedWire.body.reader).toMatchObject({
      availability: "incomplete",
      reason: "provider_process_cleanup_unconfirmed",
    });
    expect(malformedWire.body.transcript).toEqual([]);
    expect(readRequests()).toHaveLength(readsBeforeMalformedWire + 1);
    expect(fs.readFileSync(readerPidFile, "utf8")).not.toBe(previousReaderPid);
    expectReaderExited();

    // Revocation after provider dispatch must win the fresh Rust postflight
    // authorization transaction without returning any observed native output.
    fs.rmSync(readStartedFile, { force: true });
    fs.rmSync(releaseReadFile, { force: true });
    fs.writeFileSync(modeFile, "block");
    const countsBeforeRevocation = await businessCounts();
    const rowsBeforeRevocation = await businessRows();
    const readsBeforeRevocation = readRequests().length;
    const callsBeforeRevocation = rustTranscriptCalls;
    const revocationRead = transcript();
    await waitForFile(readStartedFile);
    let revoked: TranscriptResult;
    try {
      await db.execute(sql`UPDATE organization_memberships SET status='revoked'
        WHERE org_id=${orgId}::uuid AND principal_type='user' AND principal_id=${owner}`);
      fs.writeFileSync(releaseReadFile, "release");
      revoked = await revocationRead;
    } finally {
      fs.writeFileSync(releaseReadFile, "release");
      await db.execute(sql`UPDATE organization_memberships SET status='active'
        WHERE org_id=${orgId}::uuid AND principal_type='user' AND principal_id=${owner}`);
    }
    expect(revoked.status).toBe(403);
    expect(revoked.body.transcript).toBeUndefined();
    expect(JSON.stringify(revoked.body)).not.toContain("Old exact Codex answer");
    expect(rustTranscriptCalls).toBe(callsBeforeRevocation + 1);
    expect(readRequests()).toHaveLength(readsBeforeRevocation + 1);
    expectReaderExited();
    expect(await businessCounts()).toEqual(countsBeforeRevocation);
    expect(await businessRows()).toEqual(rowsBeforeRevocation);

    // Stop is legal through the real public control route while an exact
    // historical read is in flight, but a completed generation returns the
    // durable completion receipt without changing that generation's cutoff.
    fs.rmSync(readStartedFile, { force: true });
    fs.rmSync(releaseReadFile, { force: true });
    fs.writeFileSync(modeFile, "block");
    const countsBeforeStop = await businessCounts();
    const stateBeforeStop = await generationControlState();
    const pendingRead = transcript();
    await waitForFile(readStartedFile);
    const stop = await publicStop();
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ stopped: false, disposition: "completion_committed" });
    expect(await generationControlState()).toEqual(stateBeforeStop);
    const countsAfterStop = await businessCounts();
    expect(countsAfterStop.messages).toBe(countsBeforeStop.messages);
    expect(countsAfterStop.generations).toBe(countsBeforeStop.generations);
    expect(countsAfterStop.runs).toBe(countsBeforeStop.runs);
    expect(countsAfterStop.attempts).toBe(countsBeforeStop.attempts);
    expect(countsAfterStop.costs).toBe(countsBeforeStop.costs);
    expect(countsAfterStop.controlActions).toBe(countsBeforeStop.controlActions + 1);
    fs.writeFileSync(releaseReadFile, "release");
    const racedRead = await pendingRead;
    expect(racedRead.status).toBe(200);
    expect(racedRead.body.reader).toMatchObject({ source: "codex_exact_turn", availability: "complete" });
    expect((racedRead.body.transcript as Array<Record<string, unknown>>).some((entry) => entry.text === "Old exact Codex answer")).toBe(true);
    expectReaderExited();
    const postStopReadCounts = await businessCounts();
    const postStopReadRows = await businessRows();

    fs.writeFileSync(modeFile, "ok");
    const beforeLedger = readRequests().length;
    await addFilteredLedgerRow();
    const listedWithLedgerSource = await messages();
    expect(listedWithLedgerSource.status).toBe(200);
    const ledgerListedAssistant = listedWithLedgerSource.body.find((message) => message.id === assistantMessageId);
    expect(ledgerListedAssistant?.transcriptSummary).toBeNull();
    expect(readRequests()).toHaveLength(beforeLedger);
    const ledger = await transcript();
    expect(ledger.status).toBe(200);
    expect(ledger.body.reader).toMatchObject({ source: "native_event_ledger", availability: "incomplete", reason: "ledger_source_not_projectable" });
    expect(ledger.body.transcript).toEqual([]);
    expect(readRequests()).toHaveLength(beforeLedger);
    await removeFilteredLedgerRow();

    const providerReadsBeforeDenied = readRequests().length;
    const rustCallsBeforeDenied = rustTranscriptCalls;
    allowNodeAssociationForOutsider = true;
    const denied = await transcript(outsiderToken);
    allowNodeAssociationForOutsider = false;
    expect(denied.status).toBe(403);
    expect(rustTranscriptCalls).toBe(rustCallsBeforeDenied + 1);
    expect(readRequests()).toHaveLength(providerReadsBeforeDenied);
    expect(await businessCounts()).toEqual(postStopReadCounts);
    expect(await businessRows()).toEqual(postStopReadRows);
    expect(await db.execute(sql`SELECT count(*)::int AS count FROM chat_generation_events WHERE org_id=${orgId}::uuid`)).toEqual(initialEvents);
    const allMethods = rpcLog().map((entry) => entry.method);
    expect(allMethods).not.toContain("thread/start");
    expect(allMethods).not.toContain("turn/start");
    expect(allMethods).not.toContain("turn/submit");
    expect(allMethods).not.toContain("prompt");
  }, 60_000);
});
