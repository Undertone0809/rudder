import { agents, approvals, budgetIncidents, budgetPolicies, costEvents, issues, organizationMemberships, organizations } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { costRoutes } from "../routes/costs.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { budgetService } from "../services/budgets.js";
import { dashboardService } from "../services/dashboard.js";
import { createRustActorEnvelope } from "../services/rust-foundation-bridge.js";
import { database, identities, publicServer, snapshot, VISIBILITY_ACTOR_KEY, wire, type Database } from "./visibility-read-fixture.js";

const construction = vi.hoisted(() => ({ native:false }));
vi.mock("../services/budgets.js",async(importOriginal)=>{
  const original=await importOriginal<typeof import("../services/budgets.js")>();
  return {...original,budgetService:(...args:Parameters<typeof original.budgetService>)=>{
    const service=original.budgetService(...args);
    return construction.native?{...service,overview:()=>{throw new Error("Node Budget overview authority executed");}}:service;
  }};
});
vi.mock("../services/dashboard.js",async(importOriginal)=>{
  const original=await importOriginal<typeof import("../services/dashboard.js")>();
  return {...original,dashboardService:(...args:Parameters<typeof original.dashboardService>)=>{
    if(construction.native)throw new Error("Node Dashboard authority constructed");return original.dashboardService(...args);
  }};
});

describe.each(["off","required"] as const)("Overview public reads (%s ingress)",(ingress)=>{
  let fixture:Database, ids:Awaited<ReturnType<typeof identities>>, server:Awaited<ReturnType<typeof publicServer>>;
  let policyId:string, incidentId:string;
  const tables=["organizations","agents","issues","cost_events","budget_policies","budget_incidents","approvals","activity_log"];
  async function get(suffix:string,token=ids.agentToken){return request(server.target).get(`/api/orgs/${ids.orgId}/${suffix}`).set("authorization",`Bearer ${token}`);}
  beforeAll(async()=>{
    fixture=await database();ids=await identities(fixture.db);const {db}=fixture;
    await db.update(organizations).set({budgetMonthlyCents:1001}).where(eq(organizations.id,ids.orgId));
    await db.update(agents).set({status:"idle"}).where(eq(agents.id,ids.agentId));
    await db.insert(agents).values(["running","paused","error","terminated"].map((status)=>({orgId:ids.orgId,name:status,role:"general",status})));
    await db.insert(issues).values(["backlog","in_progress","blocked","done","cancelled","custom"].map((status)=>({orgId:ids.orgId,title:status,status,hiddenAt:new Date()})));
    policyId=randomUUID();incidentId=randomUUID();
    await db.insert(budgetPolicies).values({id:policyId,orgId:ids.orgId,scopeType:"agent",scopeId:ids.agentId,windowKind:"calendar_month_utc",amount:333});
    const approvalId=randomUUID();await db.insert(approvals).values({id:approvalId,orgId:ids.orgId,type:"budget",payload:{},status:"pending"});
    const now=new Date(),start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
    await db.insert(budgetIncidents).values({id:incidentId,orgId:ids.orgId,policyId,scopeType:"agent",scopeId:ids.agentId,metric:"billed_cents",windowKind:"calendar_month_utc",windowStart:start,windowEnd:end,thresholdType:"hard_stop",amountLimit:333,amountObserved:334,approvalId});
    const local=new Date(now.getFullYear(),now.getMonth(),1);
    for(const [index,stamp] of [new Date(start.getTime()-1),start,new Date(local.getTime()-1),local,new Date(end.getTime()-1),end,new Date(end.getTime()+1000)].entries()) {
      await db.insert(costEvents).values({orgId:ids.orgId,agentId:ids.agentId,provider:"fixture",model:"synthetic",costCents:index+1,inputTokens:0,outputTokens:0,occurredAt:stamp});
    }
    server=await publicServer(fixture,ingress,(app,bridge)=>{construction.native=true;try{app.use("/api",costRoutes(fixture.db,bridge));app.use("/api",dashboardRoutes(fixture.db,bridge));}finally{construction.native=false;}});
  },120000);
  afterAll(async()=>{await server?.close();await fixture?.close();});

  it.each(["dashboard","budgets/overview"])("pairs %s including local/UTC boundary and future costs",async(suffix)=>{
    const before=await snapshot(fixture.db,tables);
    const expected=suffix==="dashboard"?await dashboardService(fixture.db).summary(ids.orgId):await budgetService(fixture.db).overview(ids.orgId);
    const response=await get(suffix);expect(response.status,response.text).toBe(200);expect(response.body).toEqual(wire(expected));
    if(suffix==="dashboard"){expect(response.body.tasks).toEqual({open:4,inProgress:1,blocked:1,done:1});expect(response.body.agents).toEqual({active:1,running:1,paused:1,error:1});}
    expect(await snapshot(fixture.db,tables)).toEqual(before);
  });
  it("retains no-row missing-org Budget200 versus Dashboard404",async()=>{
    const missing=randomUUID();const actor={type:"board" as const,userId:ids.userId,source:"session" as const};
    const overview=await server.bridge.overviewRead!(actor,missing,{operation:"budget-overview",legacyDateTimezone:"UTC"});
    expect(overview.status).toBe(200);expect(JSON.parse(overview.body.toString())).toEqual({orgId:missing,policies:[],activeIncidents:[],pausedAgentCount:0,pendingApprovalCount:0});
    const dashboard=await server.bridge.overviewRead!(actor,missing,{operation:"dashboard-summary",legacyDateTimezone:"UTC"});
    expect(dashboard.status).toBe(404);expect(JSON.parse(dashboard.body.toString()).error).toBe("Organization not found");
  });
  it.each(["agent","organization"])("rejects foreign %s Budget policy scopes instead of exposing their names",async(scopeType)=>{
    const foreignAgent=randomUUID();if(scopeType==="agent")await fixture.db.insert(agents).values({id:foreignAgent,orgId:ids.foreign,name:"Foreign private name",role:"general"});
    const id=randomUUID();await fixture.db.insert(budgetPolicies).values({id,orgId:ids.orgId,scopeType,scopeId:scopeType==="agent"?foreignAgent:ids.foreign,windowKind:"lifetime",amount:100});
    try{
      const legacy=await budgetService(fixture.db).overview(ids.orgId);expect(legacy.policies.some((row)=>row.policyId===id)).toBe(true);
      for(const suffix of ["budgets/overview","dashboard"]){const response=await get(suffix);expect(response.status,response.text).toBe(404);expect(response.body.error).toBe(scopeType==="agent"?"Agent not found":"Organization not found");}
    }finally{await fixture.db.delete(budgetPolicies).where(eq(budgetPolicies.id,id));if(scopeType==="agent")await fixture.db.delete(agents).where(eq(agents.id,foreignAgent));}
  });
  it.each(["agent","organization"])("rejects foreign %s incident scope references",async(scopeType)=>{
    const foreignAgent=randomUUID();if(scopeType==="agent")await fixture.db.insert(agents).values({id:foreignAgent,orgId:ids.foreign,name:"Foreign incident",role:"general"});
    await fixture.db.update(budgetIncidents).set({scopeType,scopeId:scopeType==="agent"?foreignAgent:ids.foreign}).where(eq(budgetIncidents.id,incidentId));
    try{const response=await get("budgets/overview");expect(response.status,response.text).toBe(404);expect(response.body.error).toBe(scopeType==="agent"?"Agent not found":"Organization not found");}
    finally{await fixture.db.update(budgetIncidents).set({scopeType:"agent",scopeId:ids.agentId}).where(eq(budgetIncidents.id,incidentId));if(scopeType==="agent")await fixture.db.delete(agents).where(eq(agents.id,foreignAgent));}
  });
  it("nulls foreign approval hydration while retaining its incident and approvalId",async()=>{
    const approvalId=randomUUID();await fixture.db.insert(approvals).values({id:approvalId,orgId:ids.foreign,type:"budget",payload:{},status:"pending"});
    const [original]=await fixture.db.select().from(budgetIncidents).where(eq(budgetIncidents.id,incidentId));
    await fixture.db.update(budgetIncidents).set({approvalId}).where(eq(budgetIncidents.id,incidentId));
    try{const legacy=wire(await budgetService(fixture.db).overview(ids.orgId));expect(legacy.pendingApprovalCount).toBe(1);
      const response=await get("budgets/overview");expect(response.status,response.text).toBe(200);
      legacy.activeIncidents[0].approvalStatus=null;legacy.pendingApprovalCount=0;expect(response.body).toEqual(legacy);
    }finally{await fixture.db.update(budgetIncidents).set({approvalId:original!.approvalId}).where(eq(budgetIncidents.id,incidentId));await fixture.db.delete(approvals).where(eq(approvals.id,approvalId));}
  });
  it("preserves lifetime/unknown windows, inactive filtering and non-billed metrics",async()=>{
    const inserted=await fixture.db.insert(budgetPolicies).values([
      {orgId:ids.orgId,scopeType:"organization",scopeId:ids.orgId,windowKind:"lifetime",amount:0},
      {orgId:ids.orgId,scopeType:"organization",scopeId:ids.orgId,windowKind:"unknown",amount:3},
      {orgId:ids.orgId,scopeType:"agent",scopeId:ids.agentId,windowKind:"lifetime",metric:"unknown",amount:123},
      {orgId:ids.orgId,scopeType:"project",scopeId:randomUUID(),windowKind:"lifetime",amount:1},
      {orgId:ids.orgId,scopeType:"agent",scopeId:randomUUID(),windowKind:"lifetime",amount:1,isActive:false},
    ]).returning({id:budgetPolicies.id});
    try{const expected=await budgetService(fixture.db).overview(ids.orgId);const response=await get("budgets/overview");expect(response.status,response.text).toBe(200);expect(response.body).toEqual(wire(expected));}
    finally{for(const row of inserted)await fixture.db.delete(budgetPolicies).where(eq(budgetPolicies.id,row.id));}
  });
  it("orders overview exact ties by UUID after raw microseconds and infinities", async () => {
    const stamps = ["infinity", "2032-01-01T00:00:00.000900Z", "2032-01-01T00:00:00.000900Z",
      "2032-01-01T00:00:00.000100Z", "-infinity", "infinity"];
    const policyIds = stamps.map((_, index) => `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const incidentIds = stamps.map((_, index) => `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const start = new Date("2032-01-01T00:00:00Z"), end = new Date("2032-02-01T00:00:00Z");
    await fixture.db.insert(budgetPolicies).values(policyIds.map((id, index) => ({
      id, orgId: ids.orgId, scopeType: "organization", scopeId: ids.orgId,
      windowKind: "lifetime", metric: `order-${index}`, amount: 10,
    })));
    try {
      await fixture.db.insert(budgetIncidents).values(incidentIds.map((id, index) => ({
        id, orgId: ids.orgId, policyId: policyIds[index]!, scopeType: "organization", scopeId: ids.orgId,
        metric: `order-${index}`, windowKind: "lifetime", windowStart: start, windowEnd: end,
        thresholdType: "hard_stop", amountLimit: 10, amountObserved: 11,
      })));
      for (const [index, stamp] of stamps.entries()) {
        await fixture.db.execute(sql`UPDATE budget_policies SET updated_at=${stamp}::timestamptz WHERE id=${policyIds[index]}::uuid`);
        await fixture.db.execute(sql`UPDATE budget_incidents SET created_at=${stamp}::timestamptz WHERE id=${incidentIds[index]}::uuid`);
      }
      const expected = wire(await budgetService(fixture.db).overview(ids.orgId));
      const response = await get("budgets/overview");
      expect(response.status, response.text).toBe(200);
      // Compare complete wire arrays without sorting either side. Exact ties
      // deliberately gain a UUID tie-break; distinct microseconds still win.
      expect(response.body).toEqual(expected);
      const order = [5, 0, 2, 1, 3, 4];
      expect(response.body.policies.filter((row: { policyId: string }) => policyIds.includes(row.policyId))
        .map((row: { policyId: string }) => row.policyId)).toEqual(order.map((index) => policyIds[index]));
      expect(response.body.activeIncidents.filter((row: { id: string }) => incidentIds.includes(row.id))
        .map((row: { id: string }) => row.id)).toEqual(order.map((index) => incidentIds[index]));
    } finally {
      for (const id of incidentIds) await fixture.db.delete(budgetIncidents).where(eq(budgetIncidents.id, id));
      for (const id of policyIds) await fixture.db.delete(budgetPolicies).where(eq(budgetPolicies.id, id));
    }
  });
  it("preserves negative-zero JSON and remaining amounts beyond signed32",async()=>{
    const amount=2147483647;
    const [cost]=await fixture.db.insert(costEvents).values({orgId:ids.orgId,agentId:ids.agentId,provider:"negative",model:"synthetic",costCents:-100,inputTokens:0,outputTokens:0,occurredAt:new Date()}).returning({id:costEvents.id});
    await fixture.db.update(budgetPolicies).set({amount}).where(eq(budgetPolicies.id,policyId));
    try{const response=await get("budgets/overview");expect(response.status,response.text).toBe(200);expect(response.body).toEqual(wire(await budgetService(fixture.db).overview(ids.orgId)));
      expect(response.body.policies[0].remainingAmount).toBeGreaterThan(2147483647);expect(Object.is(response.body.policies[0].utilizationPercent,-0)).toBe(false);
    }finally{await fixture.db.delete(costEvents).where(eq(costEvents.id,cost!.id));await fixture.db.update(budgetPolicies).set({amount:333}).where(eq(budgetPolicies.id,policyId));}
  });
  it("projects incident timestamps as canonical UTC and preserves TimeClip",async()=>{
    const [original]=await fixture.db.select().from(budgetIncidents).where(eq(budgetIncidents.id,incidentId));
    await fixture.db.execute(sql`UPDATE budget_incidents SET window_start='0032-01-01T00:00:00.000900Z'::timestamptz,window_end='275760-09-13T00:00:00.000999Z'::timestamptz,resolved_at='infinity'::timestamptz WHERE id=${incidentId}::uuid`);
    try{const response=await get("budgets/overview");expect(response.status,response.text).toBe(200);const expected=wire(await budgetService(fixture.db).overview(ids.orgId));expected.activeIncidents.find((row:{id:string})=>row.id===incidentId)!.windowStart="0032-01-01T00:00:00.000Z";expect(response.body).toEqual(expected);}
    finally{await fixture.db.update(budgetIncidents).set({windowStart:original!.windowStart,windowEnd:original!.windowEnd,resolvedAt:original!.resolvedAt}).where(eq(budgetIncidents.id,incidentId));}
  });
  it.runIf(ingress === "off")("rejects fresh signatures carrying stale, future or malformed clocks before any row read",async()=>{
    const nativeFetch=globalThis.fetch;
    const before=await snapshot(fixture.db,tables);
    for(const change of ["stale","future","fractional","unsafe","null","future-start","old-start","midmonth","tampered"]){
      const spy=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,options)=>{
        if(!String(url).endsWith("/overview-reads"))return nativeFetch(url,options);
        const body=JSON.parse(Buffer.from(options!.body as unknown as Uint8Array).toString());const now=body.nowMs;
        if(change==="stale")body.nowMs-=60000;
        else if(change==="future")body.nowMs+=60000;
        else if(change==="fractional")body.nowMs+=0.5;
        else if(change==="unsafe")body.nowMs=Number.MAX_SAFE_INTEGER+1;
        else if(change==="null")body.nowMs=null;
        else if(change==="future-start")body.hostLocalMonthStartMs=now+1;
        else if(change==="old-start")body.hostLocalMonthStartMs=now-32*86400000;
        else if(change==="midmonth")body.hostLocalMonthStartMs-=15*86400000;
        else body.operation="dashboard-summary";
        const bytes=Buffer.from(JSON.stringify(body));const headers={...options!.headers as Record<string,string>};
        if(change!=="tampered")headers["x-rudder-actor-envelope"]=JSON.stringify(createRustActorEnvelope({actor:{type:"agent",agentId:ids.agentId,orgId:ids.orgId},organizationId:ids.orgId,method:"POST",path:new URL(String(url)).pathname,
          action:"overview.read",body:bytes,secret:VISIBILITY_ACTOR_KEY,requestId:headers["x-rudder-request-id"],nowSeconds:Math.floor(now/1000)}));
        return nativeFetch(url,{...options,headers,body:bytes as unknown as BodyInit});
      });
      try{const response=await get("budgets/overview");expect(response.status,`${change}: ${response.text}`).toBe(change==="tampered"?401:422);}
      finally{spy.mockRestore();}
    }
    expect(await snapshot(fixture.db,tables)).toEqual(before);
  });
  it("returns complete large policy overviews without a generic receipt cap",async()=>{
    const [org]=await fixture.db.select().from(organizations).where(eq(organizations.id,ids.orgId));
    await fixture.db.update(organizations).set({name:"x".repeat(9000)}).where(eq(organizations.id,ids.orgId));
    const rows=await fixture.db.insert(budgetPolicies).values(Array.from({length:130},(_,index)=>({orgId:ids.orgId,scopeType:"organization",scopeId:ids.orgId,windowKind:"lifetime",metric:`volume-${index}`,amount:10}))).returning({id:budgetPolicies.id});
    try{const response=await get("budgets/overview");expect(response.status,response.text).toBe(200);expect(response.body.policies).toHaveLength(131);expect(response.text.length).toBeGreaterThan(1048576);expect(response.body).toEqual(wire(await budgetService(fixture.db).overview(ids.orgId)));}
    finally{for(const row of rows)await fixture.db.delete(budgetPolicies).where(eq(budgetPolicies.id,row.id));await fixture.db.update(organizations).set({name:org!.name}).where(eq(organizations.id,ids.orgId));}
  });
  it("resolves a missing scope before an otherwise overflowing observed sum",async()=>{
    const missingScope=randomUUID(),reader=randomUUID(),policy=randomUUID();
    await fixture.db.insert(agents).values({id:reader,orgId:ids.empty,name:"Precedence reader",role:"general"});
    await fixture.db.insert(budgetPolicies).values({id:policy,orgId:ids.empty,scopeType:"organization",scopeId:missingScope,windowKind:"lifetime",amount:100});
    const costs=await fixture.db.insert(costEvents).values([1,2].map(()=>({orgId:ids.empty,agentId:reader,provider:"precedence",model:"synthetic",costCents:1073741824,inputTokens:0,outputTokens:0,occurredAt:new Date()}))).returning({id:costEvents.id});
    const read=()=>request(server.target).get(`/api/orgs/${ids.empty}/budgets/overview`).set("authorization",`Bearer ${ids.boardToken}`);
    try{
      await expect(budgetService(fixture.db).overview(ids.empty)).rejects.toMatchObject({status:404,message:"Organization not found"});
      const missing=await read();expect(missing.status,missing.text).toBe(404);expect(missing.body.error).toBe("Organization not found");
      await fixture.db.update(budgetPolicies).set({scopeId:ids.empty}).where(eq(budgetPolicies.id,policy));
      await expect(budgetService(fixture.db).overview(ids.empty)).rejects.toThrow();expect((await read()).status).toBe(500);
      for(const row of costs)await fixture.db.update(costEvents).set({costCents:1}).where(eq(costEvents.id,row.id));
      const resolved=await read();expect(resolved.status,resolved.text).toBe(200);expect(resolved.body).toEqual(wire(await budgetService(fixture.db).overview(ids.empty)));
      await fixture.db.update(budgetPolicies).set({scopeId:missingScope}).where(eq(budgetPolicies.id,policy));
      expect((await read()).status).toBe(404);
    }finally{
      for(const row of costs)await fixture.db.delete(costEvents).where(eq(costEvents.id,row.id));
      await fixture.db.delete(budgetPolicies).where(eq(budgetPolicies.id,policy));await fixture.db.delete(agents).where(eq(agents.id,reader));
    }
  });
  it("preserves SQL signed32 sum overflow as500",async()=>{
    const [cost]=await fixture.db.insert(costEvents).values({orgId:ids.orgId,agentId:ids.agentId,provider:"overflow",model:"synthetic",costCents:2147483647,inputTokens:0,outputTokens:0,occurredAt:new Date()}).returning({id:costEvents.id});
    try{await expect(budgetService(fixture.db).overview(ids.orgId)).rejects.toThrow();expect((await get("budgets/overview")).status).toBe(500);expect((await get("dashboard")).status).toBe(500);}
    finally{await fixture.db.delete(costEvents).where(eq(costEvents.id,cost!.id));}
  });
  it.each(["dashboard","budgets/overview"])("enforces current public actor access for %s",async(suffix)=>{
    expect((await request(server.target).get(`/api/orgs/${ids.orgId}/${suffix}`)).status).toBe(401);
    expect((await request(server.target).get(`/api/orgs/${ids.foreign}/${suffix}`).set("authorization",`Bearer ${ids.agentToken}`)).status).toBe(403);
    expect((await get(suffix,ids.boardToken)).status).toBe(200);
    await fixture.db.update(organizationMemberships).set({status:"inactive"}).where(and(eq(organizationMemberships.orgId,ids.orgId),eq(organizationMemberships.principalId,ids.userId)));
    try{expect((await get(suffix,ids.boardToken)).status).toBe(403);expect((await get(suffix)).status).toBe(200);}
    finally{await fixture.db.update(organizationMemberships).set({status:"active"}).where(and(eq(organizationMemberships.orgId,ids.orgId),eq(organizationMemberships.principalId,ids.userId)));}
  });
});
