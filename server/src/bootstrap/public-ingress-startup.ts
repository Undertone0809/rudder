import detectPort from "detect-port";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { RudderAppHandle } from "../app.js";
import type { Config } from "../config.js";
import type { RudderAppOptions } from "./types.js";

export function assertPublicIngressExposure(config: Config, localAccountAuth: boolean): void {
  if (config.rustPublicIngressMode !== "required") return;
  if (!isIP(config.host)) throw new Error("Rust public ingress requires a numeric listener address");
  if (config.deploymentMode === "local_trusted" && !localAccountAuth
    && config.host !== "127.0.0.1" && config.host !== "::1") {
    throw new Error("Rust public ingress cannot expose an implicit local Board on a non-loopback listener");
  }
}

export async function preparePublicIngressStartup(config: Config, publicPort: number) {
  const enabled = config.rustPublicIngressMode === "required";
  const nodeListenHost = enabled ? "127.0.0.1" : config.host;
  const nodeListenPort = enabled ? await detectPort(publicPort === 65_535 ? 3_101 : publicPort + 1) : publicPort;
  if (enabled && nodeListenPort === publicPort) throw new Error("Public ingress and private Node listener must use distinct ports");
  const apiHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  const publicApiUrl = `http://${apiHost.includes(":") ? `[${apiHost}]` : apiHost}:${publicPort}`;
  const appOptions: Pick<RudderAppOptions, "rustFoundationActorEnvelopeKey" | "rustPublicIngressAuthKey" | "rustPublicIngress"> = {};
  if (enabled) {
    const authorizationKey = randomBytes(32).toString("hex");
    appOptions.rustFoundationActorEnvelopeKey = config.rustFoundationActorEnvelopeKey ?? randomBytes(32).toString("hex");
    appOptions.rustPublicIngressAuthKey = authorizationKey;
    appOptions.rustPublicIngress = {
      listenAddr: `${config.host.includes(":") ? `[${config.host}]` : config.host}:${publicPort}`,
      nodeUpstream: `http://127.0.0.1:${nodeListenPort}`,
      authorizationKey,
    };
  }
  return {
    nodeListenHost, nodeListenPort, publicApiUrl, appOptions,
    onListening(app: RudderAppHandle, reject: (error: unknown) => void, ready: () => void) {
      return async () => {
        try {
          if (enabled) {
            if (!app.waitForPublicIngressReady || !app.publicIngressBaseUrl) {
              throw new Error("Explicit Rust public ingress did not provide its listener identity");
            }
            await app.waitForPublicIngressReady();
          }
          ready();
        } catch (error) { reject(error); }
      };
    },
  };
}
