import { afterEach, describe, expect, it, vi } from "vitest";
import { requestOverviewRead } from "../services/overview-read-bridge.js";

const originalTimezone=process.env.TZ;
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();if(originalTimezone===undefined)delete process.env.TZ;else process.env.TZ=originalTimezone;});
describe("Overview trusted clock transport",()=>{
  it.each([
    ["UTC","2026-03-01T00:00:00.123Z","2026-03-01T00:00:00.000Z"],
    ["Pacific/Kiritimati","2026-03-01T00:00:00.123Z","2026-02-28T10:00:00.000Z"],
    ["Pacific/Honolulu","2026-03-01T00:00:00.123Z","2026-02-01T10:00:00.000Z"],
    ["America/Asuncion","2017-10-15T12:00:00.123Z","2017-10-01T04:00:00.000Z"],
    ["Pacific/Kiritimati","2026-12-31T20:00:00.123Z","2026-12-31T10:00:00.000Z"],
  ])("signs one clock bucket and %s host-local month at %s",async(zone,now,start)=>{
    process.env.TZ=zone;vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(now));
    const fetch=vi.fn(async(_url:unknown,options:RequestInit)=>{
      const body=JSON.parse(Buffer.from(options.body as unknown as Uint8Array).toString());
      const envelope=JSON.parse((options.headers as Record<string,string>)["x-rudder-actor-envelope"]!);
      expect(body.nowMs).toBe(Date.parse(now));expect(body.hostLocalMonthStartMs).toBe(Date.parse(start));
      expect(envelope.issuedAt).toBe(Math.floor(body.nowMs/1000)-1);expect(envelope.expiresAt).toBe(Math.floor(body.nowMs/1000)+60);
      return new Response("{}",{status:200,headers:{"content-type":"application/json"}});
    });vi.stubGlobal("fetch",fetch);
    await requestOverviewRead("http://127.0.0.1:1","synthetic-overview-secret",1000,{type:"agent",agentId:"reader",orgId:"organization"},"organization",{operation:"dashboard-summary",legacyDateTimezone:"UTC"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
