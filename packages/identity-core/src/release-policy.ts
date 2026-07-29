export type IdentityReleaseChannel = "development" | "test" | "preview" | "production";

export type IdentityReleasePolicy = {
  channel: IdentityReleaseChannel;
  issuer: string;
  allowCapturedMail: boolean;
  allowTestClients: boolean;
};

export function assertIdentityReleasePolicy(policy: IdentityReleasePolicy): void {
  const issuer = new URL(policy.issuer);
  if (policy.channel === "production" || policy.channel === "preview") {
    const releaseName = policy.channel === "production" ? "Production" : "Preview";
    if (issuer.protocol !== "https:") throw new Error(`${releaseName} Identity issuer must use HTTPS`);
    if (policy.allowCapturedMail) throw new Error(`${releaseName} Identity cannot use captured mail`);
    if (policy.allowTestClients) throw new Error(`${releaseName} Identity cannot accept test clients`);
    if (
      issuer.username ||
      issuer.password ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash
    ) {
      throw new Error(`${releaseName} Identity issuer must be an origin`);
    }
  }
  if (
    policy.channel === "production" &&
    issuer.origin !== "https://accounts.rudderhq.dev"
  ) {
    throw new Error("Production Identity issuer must be https://accounts.rudderhq.dev");
  }
  if (
    (policy.channel === "development" || policy.channel === "test") &&
    issuer.protocol !== "https:" &&
    !["127.0.0.1", "::1", "localhost"].includes(issuer.hostname)
  ) {
    throw new Error("Non-HTTPS Identity issuer must be loopback");
  }
}
