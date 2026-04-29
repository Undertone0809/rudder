import { describe, expect, it } from "vitest";
import type { Db } from "@rudderhq/db";
import { heartbeatOrchestrator, heartbeatService } from "../services/heartbeat.js";
import type { HeartbeatOrchestrator } from "../services/runtime-kernel/types.js";
import { organizationPortabilityFacade, organizationPortabilityService } from "../services/organization-portability.js";
import { organizationSkillFacade, organizationSkillService } from "../services/organization-skills.js";

describe("service facades", () => {
  it("keeps heartbeat facade aliases stable", () => {
    const typedFactory: (db: Db) => HeartbeatOrchestrator = heartbeatService;
    expect(typedFactory).toBe(heartbeatService);
    expect(heartbeatOrchestrator).toBe(heartbeatService);
  });

  it("keeps organization skill facade aliases stable", () => {
    expect(organizationSkillFacade).toBe(organizationSkillService);
  });

  it("keeps organization portability facade aliases stable", () => {
    expect(organizationPortabilityFacade).toBe(organizationPortabilityService);
  });
});
