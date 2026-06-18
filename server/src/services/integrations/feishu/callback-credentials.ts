import type { Db } from "@rudderhq/db";
import { agentIntegrations } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { badRequest } from "../../../errors.js";
import { secretService } from "../../secrets.js";

export interface FeishuCallbackCredentials {
  verificationToken?: string | null;
  encryptKey?: string | null;
}

function firstString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bodyAppId(body: Record<string, unknown>) {
  const header = body.header && typeof body.header === "object" ? body.header as Record<string, unknown> : null;
  return firstString(body.appId) ?? firstString(header?.app_id);
}

function parseCredentialValue(value: string): FeishuCallbackCredentials {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        verificationToken: firstString(record.verificationToken) ?? firstString(record.verification_token),
        encryptKey: firstString(record.encryptKey) ?? firstString(record.encrypt_key),
      };
    }
  } catch {
    // Plain string credentials are treated as the callback verification token.
  }

  return { verificationToken: firstString(value), encryptKey: null };
}

export function feishuCallbackCredentialService(db: Db) {
  const secrets = secretService(db);

  return {
    resolveForCallback: async (
      orgId: string,
      body: Record<string, unknown>,
    ): Promise<FeishuCallbackCredentials | null> => {
      const appId = bodyAppId(body);
      if (!appId) return null;

      const integration = await db
        .select({
          appCredentialSecretId: agentIntegrations.appCredentialSecretId,
        })
        .from(agentIntegrations)
        .where(
          and(
            eq(agentIntegrations.orgId, orgId),
            eq(agentIntegrations.provider, "feishu"),
            eq(agentIntegrations.externalAppId, appId),
            eq(agentIntegrations.status, "active"),
          ),
        )
        .then((rows) => {
          if (rows.length > 1) {
            throw badRequest("Ambiguous Feishu integration for callback app_id");
          }
          return rows[0] ?? null;
        });

      if (!integration) return null;

      const value = await secrets.resolveSecretValue(orgId, integration.appCredentialSecretId, "latest");
      return parseCredentialValue(value);
    },
  };
}
