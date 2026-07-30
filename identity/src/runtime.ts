import { createIdentityDb } from "@rudderhq/identity-db";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { createIdentityAuth } from "./auth.js";
import { readIdentityConfig } from "./config.js";
import {
  CapturedMailAdapter,
  ResendMailAdapter,
  type IdentityMailAdapter,
} from "./mail.js";

export type IdentityRuntime = {
  config: ReturnType<typeof readIdentityConfig>;
  auth: ReturnType<typeof createIdentityAuth>;
  mail: IdentityMailAdapter;
  capturedMail: CapturedMailAdapter | null;
  db: ReturnType<typeof createIdentityDb>["db"];
  offlineGrantSigning: {
    keyId: string;
    privateKey: KeyObject;
    publicKeySpki: string;
  } | null;
  close: () => Promise<void>;
};

let singleton: IdentityRuntime | undefined;

export function getIdentityRuntime(options?: {
  backgroundTaskHandler?: (promise: Promise<unknown>) => void;
}): IdentityRuntime {
  if (singleton) return singleton;
  const config = readIdentityConfig();
  const connection = createIdentityDb(config.databaseUrl);
  const capturedMail = config.mail.mode === "capture" ? new CapturedMailAdapter() : null;
  const mail = config.mail.mode === "capture"
    ? capturedMail!
    : new ResendMailAdapter(config.mail.apiKey, config.mail.from);
  const offlineGrantSigning = config.offlineGrant
    ? (() => {
        const privateKey = createPrivateKey({
          key: Buffer.from(config.offlineGrant.privateKeyPkcs8, "base64url"),
          format: "der",
          type: "pkcs8",
        });
        const publicKey = createPublicKey(privateKey);
        if (publicKey.asymmetricKeyType !== "ed25519") {
          throw new Error("IDENTITY_OFFLINE_GRANT_PRIVATE_KEY must be an Ed25519 PKCS8 key");
        }
        return {
          keyId: config.offlineGrant.keyId,
          privateKey,
          publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        };
      })()
    : null;
  singleton = {
    config,
    db: connection.db,
    close: connection.close,
    mail,
    capturedMail,
    offlineGrantSigning,
    auth: createIdentityAuth({
      db: connection.db,
      config,
      mail,
      backgroundTaskHandler: options?.backgroundTaskHandler,
    }),
  };
  return singleton;
}

export async function resetIdentityRuntimeForTests(): Promise<void> {
  await singleton?.close();
  singleton = undefined;
}
