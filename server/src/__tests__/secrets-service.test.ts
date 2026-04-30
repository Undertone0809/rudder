import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationSecretVersions, organizationSecrets } from "@rudderhq/db";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

const TEST_SECRET_MASTER_KEY = "12345678901234567890123456789012";
const originalSecretMasterKey = process.env.RUDDER_SECRETS_MASTER_KEY;

async function createFakeDb(secretValue = "resolved-secret") {
  const createdVersion = await localEncryptedProvider.createVersion({ value: secretValue });
  const secretRow = {
    id: "11111111-1111-1111-1111-111111111111",
    orgId: "org-1",
    name: "ANTHROPIC_API_KEY",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 1,
  };
  const versionRow = {
    secretId: secretRow.id,
    version: 1,
    material: createdVersion.material,
    valueSha256: createdVersion.valueSha256,
  };

  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === organizationSecrets) {
                return Promise.resolve([secretRow]);
              }
              if (table === organizationSecretVersions) {
                return Promise.resolve([versionRow]);
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as any;
}

describe("secretService runtime config helpers", () => {
  beforeAll(() => {
    process.env.RUDDER_SECRETS_MASTER_KEY = TEST_SECRET_MASTER_KEY;
  });

  afterAll(() => {
    if (originalSecretMasterKey === undefined) {
      delete process.env.RUDDER_SECRETS_MASTER_KEY;
      return;
    }
    process.env.RUDDER_SECRETS_MASTER_KEY = originalSecretMasterKey;
  });

  it("resolves secret refs inside fallback runtime env config", async () => {
    const svc = secretService(await createFakeDb());

    const { config, secretKeys } = await svc.resolveAdapterConfigForRuntime("org-1", {
      model: "gpt-primary",
      modelFallbacks: [
        {
          agentRuntimeType: "claude_local",
          model: "claude-sonnet-4-6",
          config: {
            command: "claude",
            env: {
              ANTHROPIC_API_KEY: {
                type: "secret_ref",
                secretId: "11111111-1111-1111-1111-111111111111",
              },
            },
          },
        },
      ],
    });

    expect(config).toEqual({
      model: "gpt-primary",
      modelFallbacks: [
        {
          agentRuntimeType: "claude_local",
          model: "claude-sonnet-4-6",
          config: {
            command: "claude",
            env: {
              ANTHROPIC_API_KEY: "resolved-secret",
            },
          },
        },
      ],
    });
    expect([...secretKeys]).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("validates nested fallback env bindings during persistence normalization", async () => {
    const svc = secretService(await createFakeDb());

    await expect(
      svc.normalizeAdapterConfigForPersistence("org-1", {
        model: "gpt-primary",
        modelFallbacks: [
          {
            agentRuntimeType: "claude_local",
            model: "claude-sonnet-4-6",
            config: {
              env: {
                "BAD-KEY": "value",
              },
            },
          },
        ],
      }),
    ).rejects.toThrow("Invalid environment variable name: BAD-KEY");
  });
});
