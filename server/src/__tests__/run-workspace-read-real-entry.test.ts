import { executionWorkspaces, organizationMemberships, projects } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { runWorkspaceService } from "../services/execution-workspaces.js";
import { database, identities, publicServer, snapshot, wire, type Database } from "./visibility-read-fixture.js";

const construction=vi.hoisted(()=>({native:false}));
vi.mock("../services/execution-workspaces.js",async(importOriginal)=>{
  const original=await importOriginal<typeof import("../services/execution-workspaces.js")>();
  return {...original,runWorkspaceService:(...args:Parameters<typeof original.runWorkspaceService>)=>{
    const service=original.runWorkspaceService(...args);const forbidden=()=>{throw new Error("Node workspace read authority executed");};
    return construction.native?{...service,list:forbidden,getById:forbidden}:service;
  }};
});

describe.each(["off","required"] as const)("Run workspace public reads (%s ingress)",(ingress)=>{
  let fixture:Database,ids:Awaited<ReturnType<typeof identities>>,server:Awaited<ReturnType<typeof publicServer>>;
  let projectId:string,workspaceId:string,foreignWorkspace:string;
  const tables=["execution_workspaces","projects","issues","activity_log","workspace_operations"];
  function get(route:string,token=ids.agentToken){return request(server.target).get(`/api/${route}`).set("authorization",`Bearer ${token}`);}
  beforeAll(async()=>{
    fixture=await database();ids=await identities(fixture.db);projectId=randomUUID();const foreignProject=randomUUID();
    await fixture.db.insert(projects).values([{id:projectId,orgId:ids.orgId,name:"Local project"},{id:foreignProject,orgId:ids.foreign,name:"Foreign project"}]);
    workspaceId=randomUUID();foreignWorkspace=randomUUID();
    for(const [index,status] of ["active","idle","in_review","archived"].entries()){
      await fixture.db.insert(executionWorkspaces).values({id:index===0?workspaceId:randomUUID(),orgId:ids.orgId,projectId,mode:"isolated",strategyType:"git_worktree",name:status,status,
        lastUsedAt:sql`${`2026-04-01T00:00:00.000${index+1}00Z`}::timestamptz`,createdAt:new Date("2026-01-01Z"),metadata:index===0?{nested:[1,true,{"$serde_json::private::RawValue":"literal"}]}:null});
    }
    await fixture.db.insert(executionWorkspaces).values({id:foreignWorkspace,orgId:ids.foreign,projectId:foreignProject,mode:"isolated",strategyType:"git_worktree",name:"Foreign"});
    server=await publicServer(fixture,ingress,(app,bridge)=>{construction.native=true;try{app.use("/api",runWorkspaceRoutes(fixture.db,bridge));}finally{construction.native=false;}});
  },120000);
  afterAll(async()=>{await server?.close();await fixture?.close();});
  it.each(["run-workspaces","execution-workspaces"])("pairs %s list projection, filters and raw timestamp order",async(alias)=>{
    const before=await snapshot(fixture.db,tables);
    for(const filters of [{},{projectId},{projectId:randomUUID()},{status:", active, idle,,"},{status:"unknown"},{status:",,, "},{reuseEligible:true},{status:"archived,active",reuseEligible:true}]){
      const response=await get(`orgs/${ids.orgId}/${alias}`).query(filters);expect(response.status,response.text).toBe(200);
      expect(response.body).toEqual(wire(await runWorkspaceService(fixture.db).list(ids.orgId,filters)));
    }
    expect(await snapshot(fixture.db,tables)).toEqual(before);
  });
  it.each(["run-workspaces","execution-workspaces"])("retains %s repeated-query error behavior",async(alias)=>{
    for(const query of ["status=active&status=idle","projectId=invalid",`projectId=${projectId}&projectId=${projectId}`]){
      expect((await get(`orgs/${ids.orgId}/${alias}?${query}`)).status).toBe(500);
    }
    expect((await get(`orgs/${ids.orgId}/${alias}?reuseEligible=true&reuseEligible=true`)).body).toHaveLength(4);
  });
  it.each(["run-workspaces","execution-workspaces"])("pairs %s detail with both derived aliases",async(alias)=>{
    const [parent]=await fixture.db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.orgId,ids.orgId),eq(executionWorkspaces.status,"idle")));
    await fixture.db.update(executionWorkspaces).set({derivedFromExecutionWorkspaceId:parent!.id}).where(eq(executionWorkspaces.id,workspaceId));
    try{const response=await get(`${alias}/${workspaceId}`);expect(response.status,response.text).toBe(200);expect(response.body).toEqual(wire(await runWorkspaceService(fixture.db).getById(workspaceId)));
      expect(response.body.derivedFromRunWorkspaceId).toBe(parent!.id);expect(response.body.derivedFromExecutionWorkspaceId).toBe(parent!.id);
    }finally{await fixture.db.update(executionWorkspaces).set({derivedFromExecutionWorkspaceId:null}).where(eq(executionWorkspaces.id,workspaceId));}
  });
  it("pairs opaque deep JSON and projects stored timestamps as canonical UTC",async()=>{
    const [original]=await fixture.db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,workspaceId));
    for(const raw of ['{"nested":'+"[".repeat(600)+'9007199254740993'+"]".repeat(600)+'}',JSON.stringify(JSON.stringify(String.fromCharCode(0xd800))),JSON.stringify('{"literal":true}'),'123','null']){
      await fixture.db.execute(sql`UPDATE execution_workspaces SET metadata=${raw}::jsonb,opened_at='0032-01-01T00:00:00.000900Z'::timestamptz,closed_at='275760-09-13T00:00:00.000999Z'::timestamptz,cleanup_eligible_at='infinity'::timestamptz WHERE id=${workspaceId}::uuid`);
      const response=await get(`run-workspaces/${workspaceId}`);expect(response.status,response.text).toBe(200);const expected=wire(await runWorkspaceService(fixture.db).getById(workspaceId));expected.openedAt="0032-01-01T00:00:00.000Z";expect(response.body).toEqual(expected);
    }
    await fixture.db.update(executionWorkspaces).set({metadata:original!.metadata,openedAt:original!.openedAt,closedAt:original!.closedAt,cleanupEligibleAt:original!.cleanupEligibleAt}).where(eq(executionWorkspaces.id,workspaceId));
  });
  it("returns all130 large rows without receipt-size truncation",async()=>{
    const values=Array.from({length:130},(_,index)=>({orgId:ids.empty,projectId,mode:"isolated",strategyType:"git_worktree",name:`row-${index}`,lastUsedAt:new Date("2026-03-01Z"),createdAt:new Date(1700000000000+index),metadata:index===0?{payload:"x".repeat(1_050_000)}:null}));
    const inserted=await fixture.db.insert(executionWorkspaces).values(values).returning({id:executionWorkspaces.id});
    try{const response=await get(`orgs/${ids.empty}/run-workspaces`,ids.boardToken);expect(response.status,response.text).toBe(200);expect(response.body).toHaveLength(130);expect(response.text.length).toBeGreaterThan(1_048_576);expect(response.body).toEqual(wire(await runWorkspaceService(fixture.db).list(ids.empty)));}
    finally{for(const row of inserted)await fixture.db.delete(executionWorkspaces).where(eq(executionWorkspaces.id,row.id));}
  });
  it.runIf(ingress === "off").each(["delete","move"] as const)("rechecks native target after Node access resolution (%s)",async(operation)=>{
    const [original]=await fixture.db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,workspaceId));
    const read=server.bridge.runWorkspaceRead!;
    server.bridge.runWorkspaceRead=async(...args)=>{
      if(args[2].operation==="detail"){
        if(operation==="delete")await fixture.db.delete(executionWorkspaces).where(eq(executionWorkspaces.id,workspaceId));
        else await fixture.db.update(executionWorkspaces).set({orgId:ids.foreign}).where(eq(executionWorkspaces.id,workspaceId));
      }
      return read(...args);
    };
    try{const response=await get(`run-workspaces/${workspaceId}`);expect(response.status,response.text).toBe(404);expect(response.body.error).toBe("Run workspace not found");}
    finally{server.bridge.runWorkspaceRead=read;if(operation==="delete")await fixture.db.insert(executionWorkspaces).values(original!);else await fixture.db.update(executionWorkspaces).set({orgId:ids.orgId}).where(eq(executionWorkspaces.id,workspaceId));}
  });
  it.each(["run-workspaces","execution-workspaces"])("enforces missing/foreign/current Board access in %s",async(alias)=>{
    expect((await request(server.target).get(`/api/orgs/${ids.orgId}/${alias}`)).status).toBe(401);
    expect((await get(`orgs/${ids.foreign}/${alias}`)).status).toBe(403);
    expect((await get(`${alias}/${foreignWorkspace}`)).status).toBe(403);
    expect((await get(`${alias}/${randomUUID()}`)).status).toBe(404);
    expect((await get(`${alias}/invalid`)).status).toBe(500);
    expect((await get(`${alias}/${workspaceId}`,ids.boardToken)).status).toBe(200);
    await fixture.db.update(organizationMemberships).set({status:"inactive"}).where(and(eq(organizationMemberships.orgId,ids.orgId),eq(organizationMemberships.principalId,ids.userId)));
    try{expect((await get(`${alias}/${workspaceId}`,ids.boardToken)).status).toBe(403);expect((await get(`orgs/${ids.orgId}/${alias}`,ids.boardToken)).status).toBe(403);}
    finally{await fixture.db.update(organizationMemberships).set({status:"active"}).where(and(eq(organizationMemberships.orgId,ids.orgId),eq(organizationMemberships.principalId,ids.userId)));}
  });
  it.runIf(ingress === "off")("fails closed without native read transport and has no Node fallback",async()=>{
    const read=server.bridge.runWorkspaceRead;server.bridge.runWorkspaceRead=undefined;
    try{expect((await get(`orgs/${ids.orgId}/run-workspaces`)).status).toBe(503);expect((await get(`run-workspaces/${workspaceId}`)).status).toBe(503);}
    finally{server.bridge.runWorkspaceRead=read;}
  });
});
