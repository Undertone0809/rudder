import { describe, expect, it } from "vitest";
import {
  diagnoseOpenCodeNativeFailure,
  parseOpenCodeNativeFailureDiagnostic,
} from "./native-failure-diagnostic.js";

describe("OpenCode native failure diagnostics", () => {
  it("extracts nested provider context and re-allowlists persisted diagnostics", () => {
    const diagnostic = diagnoseOpenCodeNativeFailure({
      name: "UnknownError",
      message: { unexpected: "ignored" },
      data: {
        statusCode: 503,
        message: "Provider temporarily unavailable",
        responseBody: JSON.stringify({
          error: { type: "ProviderUnavailableError", message: "response-body-secret" },
        }),
        responseHeaders: { authorization: "header-secret" },
      },
    });

    expect(diagnostic).toEqual({
      runtime: "opencode_local",
      event: "session.error",
      source: "provider",
      errorName: "UnknownError",
      statusCode: 503,
      responseErrorType: "ProviderUnavailableError",
      messageClassification: "present",
      message: "Provider temporarily unavailable",
    });
    expect(parseOpenCodeNativeFailureDiagnostic({
      ...diagnostic,
      source: "adapter",
      rawBody: "raw-body-secret",
      responseHeaders: { authorization: "header-secret" },
    })).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toMatch(/response-body-secret|header-secret|raw-body-secret/u);
  });

  it("distinguishes an absent message from a rejected unsafe message", () => {
    const absent = diagnoseOpenCodeNativeFailure({ name: "UnknownError", data: {} });
    const rejected = diagnoseOpenCodeNativeFailure({
      name: "UnknownError",
      data: { message: "Authorization: Bearer provider-secret" },
    });

    expect(absent).toMatchObject({ messageClassification: "absent", message: null });
    expect(rejected).toMatchObject({ messageClassification: "rejected", message: null });
    expect(JSON.stringify(rejected)).not.toContain("provider-secret");
  });
});
