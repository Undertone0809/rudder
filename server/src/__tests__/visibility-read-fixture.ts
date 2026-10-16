// Synthetic real PostgreSQL and public HTTP fixture shared only by these read suites.
import { agentApiKeys, agents, applyPendingMigrations, authUsers, boardApiKeys, createDb, organizationMemberships, organizations, resolveOfficialPostgresBinDir, resolveOfficialPostgresBinaries } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import express from "express";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { nativeIdentityIngressFixture } from "./helpers/native-identity-ingress.js";
const execFile = promisify(execFileCallback);
export const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
export async function port() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("No test port")));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function database() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-visibility-read-"));
  const data = path.join(root, "data"), dbPort = await port();
  const binDir = resolveOfficialPostgresBinDir();
  const timezone = process.env.RUDDER_VISIBILITY_TEST_TIMEZONE ?? "UTC";
  let stop: () => Promise<void>;
  if (binDir) {
    const binary = resolveOfficialPostgresBinaries(binDir);
    await execFile(binary.initdb, ["-D", data, "--encoding=UTF8", "--locale=C", "--auth=trust", "--username=postgres", "--no-sync"]);
    await execFile(binary.pgCtl, ["-D", data, "-l", path.join(root, "postgres.log"), "-o",
      `-h 127.0.0.1 -p ${dbPort} -k '' -c shared_buffers=16MB -c max_connections=24 -c dynamic_shared_memory_type=mmap -c timezone=${timezone}`, "-w", "start"]);
    stop = async () => { await execFile(binary.pgCtl, ["-D", data, "-m", "immediate", "-w", "stop"]); };
  } else {
    // CI installs the repository's embedded provider; PostgreSQL need not be on
    // PATH. Keep the same TCP-only fixture and timezone in either provider.
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const postgres = new EmbeddedPostgres({ databaseDir: data, user: "postgres", password: "synthetic", port: dbPort,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-h", "127.0.0.1", "-c", "unix_socket_directories=", "-c", "shared_buffers=16MB",
        "-c", "max_connections=24", "-c", "dynamic_shared_memory_type=mmap", "-c", `timezone=${timezone}`],
      onLog: () => {}, onError: () => {},
    });
    await postgres.initialise(); await postgres.start();
    stop = async () => { await postgres.stop(); };
  }
  const url = `postgres://postgres:synthetic@127.0.0.1:${dbPort}/postgres`;
  await applyPendingMigrations(url);
  const db = createDb(url);
  return { db, url, close: async () => {
    await db.$client.end({ timeout: 5 });
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

export type Database = Awaited<ReturnType<typeof database>>;
export async function organization(db: Database["db"], suffix: string) {
  const orgId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: suffix, urlKey: `${suffix}-${orgId}`, issuePrefix: suffix });
  return orgId;
}

export async function identities(db: Database["db"]) {
  const orgId = await organization(db,"VIS"), foreign = await organization(db,"EXT"), empty = await organization(db,"EMP");
  const agentId = randomUUID(), userId = randomUUID();
  const agentToken = `synthetic-agent-${agentId}`, boardToken = `rudder_board_${randomUUID()}`;
  await db.insert(agents).values({ id:agentId, orgId, name:"Reader", role:"general" });
  await db.insert(agentApiKeys).values({ orgId,agentId,name:"Visibility reader",keyHash:createHash("sha256").update(agentToken).digest("hex") });
  await db.insert(authUsers).values({ id:userId,name:"Reader",email:`${userId}@example.test`,createdAt:new Date(),updatedAt:new Date() });
  await db.insert(organizationMemberships).values([orgId,empty].map((orgId)=>({orgId,principalType:"user",principalId:userId,status:"active",membershipRole:"member"})));
  await db.insert(boardApiKeys).values({userId,name:"Visibility reader",keyHash:createHash("sha256").update(boardToken).digest("hex")});
  return {orgId,foreign,empty,agentId,userId,agentToken,boardToken};
}
export const VISIBILITY_ACTOR_KEY="synthetic-visibility-actor-key-32bytes";
export async function publicServer(fixture: Database, ingress: "off"|"required",
  routes: (app:express.Express,bridge:RustFoundationBridge)=>void) {
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const binaryName=process.platform==="win32"?"rudder-server-foundation.exe":"rudder-server-foundation";
  const target=path.resolve(repo,process.env.CARGO_TARGET_DIR??"native/target");
  const explicit=process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
  const candidates=explicit?[path.resolve(repo,explicit)]:[path.join(target,"debug",binaryName),path.join(target,"release",binaryName)];
  const binary=candidates.find((candidate)=>{try{fs.accessSync(candidate,process.platform==="win32"?fs.constants.F_OK:fs.constants.X_OK);return fs.statSync(candidate).isFile();}catch{return false;}})??candidates[0]!;
  fs.accessSync(binary,process.platform==="win32"?fs.constants.F_OK:fs.constants.X_OK);
  const listenPort=ingress==="required"?await port():0;
  const nativeIdentity=ingress==="required"?nativeIdentityIngressFixture():undefined;
  const bridge=createRustFoundationBridge({databaseUrl:fixture.url,actorEnvelopeKey:VISIBILITY_ACTOR_KEY,binaryPath:binary,mode:"off",organizationBrandingMode:"off",projectGoalSetMode:"off",requestTimeoutMs:10000,
    ...(ingress==="required"?{publicIngress:{identityAuth:nativeIdentity!.identityAuth,listenAddr:"127.0.0.1:0",nodeUpstream:`http://127.0.0.1:${listenPort}`,authorizationKey:"visibility-ingress-synthetic-key-32bytes"}}:{})});
  const app=express();if(nativeIdentity)app.use(nativeIdentity.middleware());app.use(express.json());app.get("/api/health",(_req,res)=>res.json({status:"ok"}));
  app.use(actorMiddleware(fixture.db,{deploymentMode:"authenticated",authRequirement:"required"}));
  routes(app,bridge);app.use(errorHandler);
  const server=app.listen(listenPort,"127.0.0.1");await once(server,"listening");await bridge.start();
  let targetAddress: Server|string=server;
  if(ingress==="required"){await bridge.waitForPublicIngressReady!();targetAddress=bridge.publicIngressBaseUrl!;}
  return {app,bridge,target:targetAddress,close:async()=>{await new Promise<void>((resolve,reject)=>{server.close((error)=>error?reject(error):resolve());server.closeAllConnections();});await bridge.close();}};
}
export async function snapshot(db:Database["db"],tables:string[]) {
  const values:Record<string,unknown>={};
  for(const table of [...tables,"organization_mutation_state","organization_mutation_receipts"]){
    const [row]=await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text value FROM ${table} t`));values[table]=row?.value;
  }
  return values;
}
