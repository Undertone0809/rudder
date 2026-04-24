import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { organizationSecrets, organizationSecretVersions } from "@rudderhq/db";
import type { AgentEnvConfig, EnvBinding, SecretProvider } from "@rudderhq/shared";
import { envBindingSchema } from "@rudderhq/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return { type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  return {
    type: "secret_ref",
    secretId: binding.secretId,
    version: binding.version ?? "latest",
  };
}

export function secretService(db: Db) {
  async function getById(id: string) {
    return db
      .select()
      .from(organizationSecrets)
      .where(eq(organizationSecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(orgId: string, name: string) {
    return db
      .select()
      .from(organizationSecrets)
      .where(and(eq(organizationSecrets.orgId, orgId), eq(organizationSecrets.name, name)))
      .then((rows) => rows[0] ?? null);
  }

  async function getSecretVersion(secretId: string, version: number) {
    return db
      .select()
      .from(organizationSecretVersions)
      .where(
        and(
          eq(organizationSecretVersions.secretId, secretId),
          eq(organizationSecretVersions.version, version),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertSecretInCompany(orgId: string, secretId: string) {
    const secret = await getById(secretId);
    if (!secret) throw notFound("Secret not found");
    if (secret.orgId !== orgId) throw unprocessable("Secret must belong to same organization");
    return secret;
  }

  async function resolveSecretValue(
    orgId: string,
    secretId: string,
    version: number | "latest",
  ): Promise<string> {
    const secret = await assertSecretInCompany(orgId, secretId);
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const versionRow = await getSecretVersion(secret.id, resolvedVersion);
    if (!versionRow) throw notFound("Secret version not found");
    const provider = getSecretProvider(secret.provider as SecretProvider);
    return provider.resolveVersion({
      material: versionRow.material as Record<string, unknown>,
      externalRef: secret.externalRef,
    });
  }

  async function normalizeEnvConfig(
    orgId: string,
    envValue: unknown,
    opts?: { strictMode?: boolean },
  ): Promise<AgentEnvConfig> {
    const record = asRecord(envValue);
    if (!record) throw unprocessable("agentRuntimeConfig.env must be an object");

    const normalized: AgentEnvConfig = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!ENV_KEY_RE.test(key)) {
        throw unprocessable(`Invalid environment variable name: ${key}`);
      }

      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }

      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
          throw unprocessable(
            `Strict secret mode requires secret references for sensitive key: ${key}`,
          );
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(`Refusing to persist redacted placeholder for key: ${key}`);
        }
        normalized[key] = binding;
        continue;
      }

      await assertSecretInCompany(orgId, binding.secretId);
      normalized[key] = {
        type: "secret_ref",
        secretId: binding.secretId,
        version: binding.version,
      };
    }
    return normalized;
  }

  async function normalizeAdapterConfigForPersistenceInternal(
    orgId: string,
    agentRuntimeConfig: Record<string, unknown>,
    opts?: { strictMode?: boolean },
  ) {
    const normalized = { ...agentRuntimeConfig };
    if (!Object.prototype.hasOwnProperty.call(agentRuntimeConfig, "env")) {
      return normalized;
    }
    normalized.env = await normalizeEnvConfig(orgId, agentRuntimeConfig.env, opts);
    return normalized;
  }

  return {
    listProviders: () => listSecretProviders(),

    list: (orgId: string) =>
      db
        .select()
        .from(organizationSecrets)
        .where(eq(organizationSecrets.orgId, orgId))
        .orderBy(desc(organizationSecrets.createdAt)),

    getById,
    getByName,
    resolveSecretValue,

    create: async (
      orgId: string,
      input: {
        name: string;
        provider: SecretProvider;
        value: string;
        description?: string | null;
        externalRef?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await getByName(orgId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);

      const provider = getSecretProvider(input.provider);
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        const secret = await tx
          .insert(organizationSecrets)
          .values({
            orgId,
            name: input.name,
            provider: input.provider,
            externalRef: prepared.externalRef,
            latestVersion: 1,
            description: input.description ?? null,
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx.insert(organizationSecretVersions).values({
          secretId: secret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        return secret;
      });
    },

    rotate: async (
      secretId: string,
      input: { value: string; externalRef?: string | null },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const nextVersion = secret.latestVersion + 1;
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? secret.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        await tx.insert(organizationSecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        const updated = await tx
          .update(organizationSecrets)
          .set({
            latestVersion: nextVersion,
            externalRef: prepared.externalRef,
            updatedAt: new Date(),
          })
          .where(eq(organizationSecrets.id, secret.id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) throw notFound("Secret not found");
        return updated;
      });
    },

    update: async (
      secretId: string,
      patch: { name?: string; description?: string | null; externalRef?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.orgId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }

      return db
        .update(organizationSecrets)
        .set({
          name: patch.name ?? secret.name,
          description:
            patch.description === undefined ? secret.description : patch.description,
          externalRef:
            patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
          updatedAt: new Date(),
        })
        .where(eq(organizationSecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (secretId: string) => {
      const secret = await getById(secretId);
      if (!secret) return null;
      await db.delete(organizationSecrets).where(eq(organizationSecrets.id, secretId));
      return secret;
    },

    normalizeAdapterConfigForPersistence: async (
      orgId: string,
      agentRuntimeConfig: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => normalizeAdapterConfigForPersistenceInternal(orgId, agentRuntimeConfig, opts),

    normalizeHireApprovalPayloadForPersistence: async (
      orgId: string,
      payload: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => {
      const normalized = { ...payload };
      const agentRuntimeConfig = asRecord(payload.agentRuntimeConfig);
      if (agentRuntimeConfig) {
        normalized.agentRuntimeConfig = await normalizeAdapterConfigForPersistenceInternal(
          orgId,
          agentRuntimeConfig,
          opts,
        );
      }
      return normalized;
    },

    resolveEnvBindings: async (orgId: string, envValue: unknown): Promise<{ env: Record<string, string>; secretKeys: Set<string> }> => {
      const record = asRecord(envValue);
      if (!record) return { env: {} as Record<string, string>, secretKeys: new Set<string>() };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();

      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          resolved[key] = binding.value;
        } else {
          resolved[key] = await resolveSecretValue(orgId, binding.secretId, binding.version);
          secretKeys.add(key);
        }
      }
      return { env: resolved, secretKeys };
    },

    resolveAdapterConfigForRuntime: async (orgId: string, agentRuntimeConfig: Record<string, unknown>): Promise<{ config: Record<string, unknown>; secretKeys: Set<string> }> => {
      const resolved = { ...agentRuntimeConfig };
      const secretKeys = new Set<string>();
      if (!Object.prototype.hasOwnProperty.call(agentRuntimeConfig, "env")) {
        return { config: resolved, secretKeys };
      }
      const record = asRecord(agentRuntimeConfig.env);
      if (!record) {
        resolved.env = {};
        return { config: resolved, secretKeys };
      }
      const env: Record<string, string> = {};
      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          env[key] = binding.value;
        } else {
          env[key] = await resolveSecretValue(orgId, binding.secretId, binding.version);
          secretKeys.add(key);
        }
      }
      resolved.env = env;
      return { config: resolved, secretKeys };
    },
  };
}
