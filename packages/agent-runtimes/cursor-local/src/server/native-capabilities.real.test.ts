import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCursorLocalProviderCapabilities,
  executeCursorNativeChat,
  type CursorLocalProfileTransport,
  type CursorProviderBindingRef,
} from "./native-capabilities.js";

const integrationEnabled = process.env.RUDDER_CURSOR_ACP_INTEGRATION === "1";
const configuredRequestTimeoutMs = Number(process.env.RUDDER_CURSOR_ACP_REQUEST_TIMEOUT_MS);
const requestTimeoutMs = Number.isFinite(configuredRequestTimeoutMs) && configuredRequestTimeoutMs >= 250
  ? configuredRequestTimeoutMs
  : 120_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe.skipIf(!integrationEnabled)("Cursor ACP installed runtime", () => {
  it("continues across ACP processes and keeps transcript boundaries fail-closed", async () => {
    const command = process.env.RUDDER_CURSOR_AGENT_COMMAND?.trim() || "cursor-agent";
    const providerVersion = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
    const cwd = await mkdtemp(path.join(tmpdir(), "rudder-cursor-acp-"));
    const binding: CursorProviderBindingRef = {
      hostId: "local-cursor-acp-integration",
      profileId: `integration-${Date.now()}`,
      capabilityRevision: "cursor-acp-v1",
    };
    const profile: CursorLocalProfileTransport = {
      binding,
      command,
      cwd,
      providerVersion,
      protocolVersion: 1,
      requestTimeoutMs,
    };
    const logs: string[] = [];
    const onLog = async (_stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
    };
    const marker = "RUDDER_NATIVE_W10_CONTINUITY_6F2A";

    try {
      const created = await executeCursorNativeChat({
        profile,
        binding,
        prompt: `Remember the exact marker ${marker}. Reply only with STORED. Do not use tools or modify files.`,
        model: "",
        onLog,
      });
      expect(
        created.exitCode,
        `${created.errorMessage ?? "Cursor did not create the native session."} ${JSON.stringify(record(created.resultJson).acpRequestTrace ?? [])}`,
      ).toBe(0);
      expect(typeof created.sessionId).toBe("string");
      expect(created.sessionParams).toBeTruthy();

      const continued = await executeCursorNativeChat({
        profile,
        binding,
        sessionId: created.sessionId,
        sessionParams: created.sessionParams,
        prompt: "Return only the exact marker I asked you to remember. Do not use tools or modify files.",
        model: "",
        onLog,
      });
      expect(
        continued.exitCode,
        `${continued.errorMessage ?? "Cursor did not continue the loaded native session."} ${JSON.stringify(record(continued.resultJson).acpRequestTrace ?? [])}`,
      ).toBe(0);
      expect(continued.summary).toContain(marker);

      const sessionId = String(created.sessionId);
      const resultJson = record(continued.resultJson);
      const boundary = record(resultJson.transcriptBoundary);
      const executionRef = typeof resultJson.executionRef === "string" ? resultJson.executionRef : null;
      const nativeRangeRef = typeof resultJson.nativeRangeRef === "string" ? resultJson.nativeRangeRef : null;
      const transcript = await createCursorLocalProviderCapabilities(profile).transcript.readRange({
        runtimeType: "cursor",
        session: {
          sessionId,
          sessionDisplayId: sessionId,
          sessionParams: record(continued.sessionParams),
        },
        selector: { kind: "cursor_execution", sessionId, executionRef, nativeRangeRef },
        binding,
      });

      expect(transcript.completeness).not.toBe("complete");
      if (boundary.status === "ok" && (executionRef || nativeRangeRef)) {
        if (transcript.availability === "available") {
          expect(transcript.items.length).toBeGreaterThan(0);
        } else {
          expect(["missing", "incompatible"]).toContain(transcript.availability);
        }
      } else {
        expect(["missing", "incompatible"]).toContain(transcript.availability);
        expect(["partial", "unknown"]).toContain(transcript.completeness);
      }

      const createdMode = record(created.resultJson).modeId;
      const continuedMode = resultJson.modeId;
      if (typeof createdMode === "string") expect(continuedMode).toBe(createdMode);
      const modePreserved = typeof createdMode === "string" && createdMode === continuedMode;
      process.stdout.write(`${JSON.stringify({
        providerVersion,
        continuation: "passed",
        modePreserved: typeof createdMode === "string" ? modePreserved : "not-reported-by-provider",
        promptBoundaryStatus: boundary.status ?? "missing",
        transcriptAvailability: transcript.availability,
        transcriptCompleteness: transcript.completeness,
        transcriptItemCount: transcript.items.length,
        loggedProtocolEvents: logs.length,
      })}\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
