import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, redactSensitiveText, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts high-signal credentials embedded in Request text", () => {
    expect(redactSensitiveText(
      "Use bearer ghp_example, token: abc123, GitHub ghp_1234567890abcdefghij, " +
      "JWT abcdefgh.ijklmnop.qrstuvwx after OTP 123456; normal issue 6543210 stays visible.",
    )).toBe(
      "Use bearer [REDACTED], token: [REDACTED], GitHub [REDACTED_SECRET], " +
      "JWT [REDACTED_JWT] after OTP [REDACTED_OTP]; normal issue 6543210 stays visible.",
    );
  });

  it("redacts PEM private keys from multiline Request text", () => {
    expect(redactSensitiveText(
      "Credential:\n-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\nContinue.",
    )).toBe("Credential:\n[REDACTED_PRIVATE_KEY]\nContinue.");
  });

  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        RUDDER_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      RUDDER_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });
});
