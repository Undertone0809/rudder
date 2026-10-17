import type { Config } from "../config.js";

/** Validate exposure before constructing auth or opening the public listener. */
export function assertAuthDeploymentConfig(config: Pick<Config,
  "deploymentMode" | "deploymentExposure" | "host" | "authBaseUrlMode" | "authPublicBaseUrl"
>): void {
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }

  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }

  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
