import { describe, expect, it } from "vitest";
import { resolveTrustedOperatorHome } from "./codex-home.js";
import { buildCodexProfileEnvironment, codexConfiguredEnvironment } from "./profile-env.js";

describe("Codex host profile environment", () => {
  it("pins managed identity while preserving supported provider configuration", () => {
    const configured = {
      HOME: "/foreign-home", USERPROFILE: "/foreign-home", CODEX_HOME: "/shared-auth",
      AGENT_HOME: "/foreign-agent", RUDDER_OPERATOR_HOME: "/foreign-operator",
      RUDDER_AGENT_ROOT: "/foreign-agent", RUDDER_API_KEY: "foreign-run-credential",
      PATH: "/authorized/provider/bin", OPENAI_BASE_URL: "https://provider.example/v1",
      OPENAI_API_KEY: "configured-provider-key", numeric: 1,
    };
    const allowed = codexConfiguredEnvironment(configured);
    expect(allowed).toEqual({ PATH: configured.PATH, OPENAI_BASE_URL: configured.OPENAI_BASE_URL, OPENAI_API_KEY: configured.OPENAI_API_KEY });
    const env = buildCodexProfileEnvironment({ configured, codexHome: "/managed/org/agent/codex" });
    expect(env).toMatchObject({
      HOME: resolveTrustedOperatorHome(), USERPROFILE: process.env.USERPROFILE ?? resolveTrustedOperatorHome(),
      CODEX_HOME: "/managed/org/agent/codex", RUDDER_OPERATOR_HOME: resolveTrustedOperatorHome(),
      PATH: configured.PATH, OPENAI_API_KEY: configured.OPENAI_API_KEY,
    });
    expect(env.RUDDER_API_KEY).not.toBe("foreign-run-credential");
    expect(configured.CODEX_HOME).toBe("/shared-auth");
  });
});
