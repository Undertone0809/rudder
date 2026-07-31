import { createIdentityDb } from "@rudderhq/identity-db";
import { sql } from "drizzle-orm";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  readIdentityConfig,
  readSupabaseRootIdentityConfig,
} from "./config.js";
import { CapturedMailAdapter } from "./mail.js";
import type { RootIdentityAdapter } from "./root-identity-adapter.js";
import { createRootIdentityFixture } from "./root-identity-fixture.js";
import { createSupabaseRootIdentityAdapter } from "./supabase-root-identity-adapter.js";

export type IdentityRuntime = {
  config: ReturnType<typeof readIdentityConfig>;
  rootIdentity: RootIdentityAdapter;
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
  rootIdentityAdapter?: RootIdentityAdapter;
}): IdentityRuntime {
  if (singleton) return singleton;
  const config = readIdentityConfig();
  const connection = createIdentityDb(config.databaseUrl);
  const capturedMail = config.mail.mode === "capture" ? new CapturedMailAdapter() : null;
  const rootIdentityConfig = readSupabaseRootIdentityConfig({
    baseUrl: config.baseUrl,
    releaseChannel: config.releaseChannel,
  });
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
    capturedMail,
    offlineGrantSigning,
    rootIdentity:
      options?.rootIdentityAdapter ??
      (rootIdentityConfig.environment === "fixture"
        ? createRootIdentityFixture(
            rootIdentityConfig,
            capturedMail ?? (() => {
              throw new Error("In-process root-auth fixture requires captured mail");
            })(),
          )
        : createSupabaseRootIdentityAdapter(rootIdentityConfig, {
            activeSessionVerifier: async ({ sessionId, userId }) => {
              // Supabase owns the auth schema and does not permit the runtime
              // role to traverse it. A SECURITY DEFINER function exposes only
              // the active/not-active decision and no session or token data.
              const rows = await connection.db.execute(sql`
                select rudder_identity.is_active_auth_session(
                  ${sessionId}::uuid,
                  ${userId}::uuid
                ) as active
              `);
              return rows[0]?.active === true;
            },
          })),
  };
  return singleton;
}

export async function resetIdentityRuntimeForTests(): Promise<void> {
  await singleton?.close();
  singleton = undefined;
}
