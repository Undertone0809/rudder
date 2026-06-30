import { describe, expect, it } from "vitest";
import {
  buildIntelligenceProfileConfigWithPurposeDefaults,
  organizationIntelligenceProfileService,
} from "../services/organization-intelligence-profiles.js";

describe("organization intelligence profiles", () => {
  it("filters agent identity and workspace fields from product intelligence configs", () => {
    const svc = organizationIntelligenceProfileService({} as any);

    expect(svc.sanitizeConfigForProductIntelligence({
      model: "gpt-5.4",
      modelReasoningEffort: "medium",
      promptTemplate: "{{issue.title}}",
      instructionsFilePath: "/agent/SOUL.md",
      rudderRuntimeSkills: [{ key: "rudder" }],
      workspaceStrategy: { type: "git_worktree" },
      cwd: "/repo",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
      modelFallbacks: [
        {
          agentRuntimeType: "codex_local",
          model: "gpt-5.4-mini",
          config: {
            model: "gpt-5.4-mini",
            promptTemplate: "agent prompt",
            instructionsRootPath: "/agent/instructions",
            workspaceRuntime: { services: [] },
            env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
          },
        },
      ],
    })).toEqual({
      model: "gpt-5.4",
      modelReasoningEffort: "medium",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
      modelFallbacks: [
        {
          agentRuntimeType: "codex_local",
          model: "gpt-5.4-mini",
          config: {
            model: "gpt-5.4-mini",
            env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
          },
        },
      ],
    });
  });

  it("derives Codex fast and smart defaults without copying agent identity fields", () => {
    const sourceConfig = {
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      command: "codex",
      promptTemplate: "You are the CEO.",
      instructionsFilePath: "/agent/SOUL.md",
      workspaceStrategy: { type: "git_worktree" },
      cwd: "/repo",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    };

    expect(
      buildIntelligenceProfileConfigWithPurposeDefaults("lightweight", "codex_local", sourceConfig),
    ).toEqual({
      command: "codex",
      model: "gpt-5.4-mini",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });

    expect(
      buildIntelligenceProfileConfigWithPurposeDefaults("reasoning", "codex_local", sourceConfig),
    ).toEqual({
      command: "codex",
      model: "gpt-5.4-mini",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });
  });

  it("tests and configures derived Codex profile defaults when the chain passes", async () => {
    const insertedValues: any[] = [];
    const createdAt = new Date("2026-06-18T00:00:00.000Z");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
      insert: () => ({
        values: (values: any) => {
          insertedValues.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{
                id: `profile-${values.purpose}`,
                orgId: values.orgId,
                purpose: values.purpose,
                agentRuntimeType: values.agentRuntimeType,
                agentRuntimeConfig: values.agentRuntimeConfig,
                status: values.status,
                lastError: values.lastError,
                lastVerifiedAt: values.lastVerifiedAt,
                createdAt,
                updatedAt: createdAt,
              }],
            }),
          };
        },
      }),
    };
    const svc = organizationIntelligenceProfileService(db as any);

    const testRuntimeChain = async () => {};
    const created = await svc.ensureDefaultsFromRuntime({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: "codex",
        model: "gpt-5.3-codex",
      },
      testRuntimeChain,
    });

    expect(created).toHaveLength(2);
    expect(created.every((profile) => profile.status === "configured")).toBe(true);
    expect(created.every((profile) => profile.lastVerifiedAt instanceof Date)).toBe(true);
    expect(created.map((profile) => profile.agentRuntimeConfig)).toEqual([
      {
        command: "codex",
        model: "gpt-5.4-mini",
      },
      {
        command: "codex",
        model: "gpt-5.4-mini",
      },
    ]);
    expect(insertedValues.every((values) => values.status === "configured")).toBe(true);
  });

  it("leaves derived Codex profile defaults invalid when the chain fails", async () => {
    const insertedValues: any[] = [];
    const createdAt = new Date("2026-06-18T00:00:00.000Z");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
      insert: () => ({
        values: (values: any) => {
          insertedValues.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{
                id: `profile-${values.purpose}`,
                orgId: values.orgId,
                purpose: values.purpose,
                agentRuntimeType: values.agentRuntimeType,
                agentRuntimeConfig: values.agentRuntimeConfig,
                status: values.status,
                lastError: values.lastError,
                lastVerifiedAt: values.lastVerifiedAt,
                createdAt,
                updatedAt: createdAt,
              }],
            }),
          };
        },
      }),
    };
    const svc = organizationIntelligenceProfileService(db as any);

    const created = await svc.ensureDefaultsFromRuntime({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { command: "codex" },
      testRuntimeChain: async () => {
        throw new Error("model unavailable");
      },
    });

    expect(created).toHaveLength(2);
    expect(created.every((profile) => profile.status === "invalid")).toBe(true);
    expect(created.every((profile) => profile.lastError === "model unavailable")).toBe(true);
    expect(insertedValues.every((values) => values.status === "invalid")).toBe(true);
    expect(insertedValues.every((values) => values.lastVerifiedAt === null)).toBe(true);
  });

  it("configures only the derived Codex profile whose runtime-chain test passes", async () => {
    const insertedValues: any[] = [];
    const createdAt = new Date("2026-06-18T00:00:00.000Z");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
      insert: () => ({
        values: (values: any) => {
          insertedValues.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{
                id: `profile-${values.purpose}`,
                orgId: values.orgId,
                purpose: values.purpose,
                agentRuntimeType: values.agentRuntimeType,
                agentRuntimeConfig: values.agentRuntimeConfig,
                status: values.status,
                lastError: values.lastError,
                lastVerifiedAt: values.lastVerifiedAt,
                createdAt,
                updatedAt: createdAt,
              }],
            }),
          };
        },
      }),
    };
    const svc = organizationIntelligenceProfileService(db as any);

    const created = await svc.ensureDefaultsFromRuntime({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { command: "codex" },
      testRuntimeChain: async ({ purpose }) => {
        if (purpose === "reasoning") {
          throw new Error("reasoning model unavailable");
        }
      },
    });

    expect(created).toHaveLength(2);
    expect(created.find((profile) => profile.purpose === "lightweight")).toMatchObject({
      status: "configured",
      lastError: null,
    });
    expect(created.find((profile) => profile.purpose === "lightweight")?.lastVerifiedAt).toBeInstanceOf(Date);
    expect(created.find((profile) => profile.purpose === "reasoning")).toMatchObject({
      status: "invalid",
      lastError: "reasoning model unavailable",
      lastVerifiedAt: null,
    });
    expect(insertedValues.map((values) => [values.purpose, values.status])).toEqual([
      ["lightweight", "configured"],
      ["reasoning", "invalid"],
    ]);
  });

  it("does not overwrite an existing configured profile during default seeding races", async () => {
    const configuredProfile = {
      id: "profile-lightweight-existing",
      orgId: "org-1",
      purpose: "lightweight",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4-mini" },
      status: "configured",
      lastError: null,
      lastVerifiedAt: new Date("2026-06-18T00:00:00.000Z"),
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    };
    const selectResults = [
      [],
      [configuredProfile],
      [],
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: async () => selectResults.shift() ?? [],
        }),
      }),
      insert: () => ({
        values: (values: any) => ({
          onConflictDoNothing: () => ({
            returning: async () => values.purpose === "lightweight"
              ? []
              : [{
                id: `profile-${values.purpose}`,
                orgId: values.orgId,
                purpose: values.purpose,
                agentRuntimeType: values.agentRuntimeType,
                agentRuntimeConfig: values.agentRuntimeConfig,
                status: values.status,
                lastError: values.lastError,
                lastVerifiedAt: values.lastVerifiedAt,
                createdAt: new Date("2026-06-18T00:00:00.000Z"),
                updatedAt: new Date("2026-06-18T00:00:00.000Z"),
              }],
          }),
        }),
      }),
    };
    const svc = organizationIntelligenceProfileService(db as any);

    const created = await svc.ensureDefaultsFromRuntime({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { command: "codex" },
      testRuntimeChain: async ({ purpose }) => {
        if (purpose === "lightweight") throw new Error("stale failing probe");
      },
    });

    expect(created.find((profile) => profile.purpose === "lightweight")).toMatchObject({
      id: "profile-lightweight-existing",
      status: "configured",
      lastError: null,
    });
  });
});
