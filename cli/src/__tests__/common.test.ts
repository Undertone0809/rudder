import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../client/http.js";
import { writeContext } from "../client/context.js";
import { handleCommandError, resolveCommandContext } from "../commands/client/common.js";

const ORIGINAL_ENV = { ...process.env };

function createTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-cli-common-"));
  return path.join(dir, name);
}

describe("resolveCommandContext", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RUDDER_API_URL;
    delete process.env.RUDDER_API_KEY;
    delete process.env.RUDDER_ORG_ID;
    delete process.env.RUDDER_AGENT_ID;
    delete process.env.RUDDER_RUN_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses profile defaults when options/env are not provided", () => {
    const contextPath = createTempPath("context.json");

    writeContext(
      {
        version: 1,
        currentProfile: "ops",
        profiles: {
          ops: {
            apiBase: "http://127.0.0.1:9999",
            orgId: "org-profile",
            apiKeyEnvVarName: "AGENT_KEY",
          },
        },
      },
      contextPath,
    );
    process.env.AGENT_KEY = "key-from-env";

    const resolved = resolveCommandContext({ context: contextPath }, { requireCompany: true });
    expect(resolved.api.apiBase).toBe("http://127.0.0.1:9999");
    expect(resolved.orgId).toBe("org-profile");
    expect(resolved.api.apiKey).toBe("key-from-env");
  });

  it("prefers explicit options over profile values", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://profile:3100",
            orgId: "org-profile",
          },
        },
      },
      contextPath,
    );

    const resolved = resolveCommandContext(
      {
        context: contextPath,
        apiBase: "http://override:3200",
        apiKey: "direct-token",
        orgId: "org-override",
      },
      { requireCompany: true },
    );

    expect(resolved.api.apiBase).toBe("http://override:3200");
    expect(resolved.orgId).toBe("org-override");
    expect(resolved.api.apiKey).toBe("direct-token");
  });

  it("uses RUDDER_ORG_ID when provided", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );
    process.env.RUDDER_ORG_ID = "org-from-env";

    const resolved = resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" }, { requireCompany: true });

    expect(resolved.orgId).toBe("org-from-env");
  });

  it("uses RUDDER_AGENT_ID and RUDDER_RUN_ID when provided", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );
    process.env.RUDDER_AGENT_ID = "agent-from-env";
    process.env.RUDDER_RUN_ID = "run-from-env";

    const resolved = resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" });

    expect(resolved.agentId).toBe("agent-from-env");
    expect(resolved.runId).toBe("run-from-env");
    expect(resolved.api.runId).toBe("run-from-env");
  });

  it("throws when organization is required but unresolved", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );

    expect(() =>
      resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" }, { requireCompany: true }),
    ).toThrow(/Organization ID is required/);
  });

  it("writes structured json errors to stderr when --json is present", () => {
    const originalArgv = process.argv;
    process.argv = ["node", "rudder", "issue", "done", "issue-1", "--json"];

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        handleCommandError(
          new ApiRequestError(
            409,
            "Issue checkout conflict",
            { issueId: "issue-1" },
            { error: "Issue checkout conflict", details: { issueId: "issue-1" } },
            "issue_checkout_conflict",
          ),
        ),
      ).toThrow("process.exit:1");
    } finally {
      process.argv = originalArgv;
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('"code": "issue_checkout_conflict"'),
    );
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('"status": 409'),
    );
  });
});
