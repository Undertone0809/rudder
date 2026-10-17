import { describe, expect, it } from "vitest";
import { assertAuthDeploymentConfig } from "./auth-deployment-config.js";

type Deployment = Parameters<typeof assertAuthDeploymentConfig>[0];
const local: Deployment = {
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  host: "127.0.0.1",
  authBaseUrlMode: "auto",
  authPublicBaseUrl: undefined,
};

describe("authentication deployment exposure", () => {
  it.each(["127.0.0.1", " localhost ", "::1"])("allows private local binding at %s", (host) => {
    expect(() => assertAuthDeploymentConfig({ ...local, host })).not.toThrow();
  });

  it.each(["0.0.0.0", "192.168.1.2", "localhost.attacker.test"])("rejects trusted local identity on %s", (host) => {
    expect(() => assertAuthDeploymentConfig({ ...local, host })).toThrow("requires loopback host binding");
  });

  it("rejects public exposure even with a loopback local binding", () => {
    expect(() => assertAuthDeploymentConfig({ ...local, deploymentExposure: "public" })).toThrow("only supports private exposure");
  });

  it("requires an explicit base URL for authenticated public exposure", () => {
    const publicAuth: Deployment = { ...local, deploymentMode: "authenticated", deploymentExposure: "public", host: "0.0.0.0" };
    expect(() => assertAuthDeploymentConfig(publicAuth)).toThrow("requires auth.baseUrlMode=explicit");
    expect(() => assertAuthDeploymentConfig({ ...publicAuth, authBaseUrlMode: "explicit" })).toThrow("requires auth.publicBaseUrl");
    expect(() => assertAuthDeploymentConfig({ ...publicAuth, authBaseUrlMode: "explicit", authPublicBaseUrl: "https://rudder.example" })).not.toThrow();
  });

  it("rejects a missing explicitly configured base URL for private authenticated exposure", () => {
    expect(() => assertAuthDeploymentConfig({ ...local, deploymentMode: "authenticated", authBaseUrlMode: "explicit" })).toThrow("requires auth.publicBaseUrl");
  });
});
