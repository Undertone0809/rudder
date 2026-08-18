import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createSpeechRuntime,
  resolveSpeechConfig,
  SpeechRuntimeError,
  validateSpeechInput,
} from "./speech-runtime.js";

function speechInput(requestId = "voice:test") {
  return {
    requestId,
    pcm: new Float32Array([0.25, -0.25]).buffer,
    sampleRate: 16_000,
    channels: 1 as const,
    format: "f32le" as const,
  };
}

class FakeSpeechChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly stdin = Object.assign(new EventEmitter(), {
    end: vi.fn((payload: Buffer) => {
      this.input = payload;
    }),
  });
  input: Buffer | null = null;
  readonly kill = vi.fn(() => {
    this.emit("close", null, "SIGTERM");
    return true;
  });
}

describe("Desktop speech runtime", () => {
  it("fails closed when the experiment is disabled or the packaged assets are missing", () => {
    expect(resolveSpeechConfig({ env: {} }).status).toMatchObject({
      enabled: false,
      available: false,
      reason: "disabled",
    });
    expect(resolveSpeechConfig({
      env: { RUDDER_EXPERIMENTAL_CHAT_VOICE_INPUT: "1" },
      platform: "darwin",
      arch: "arm64",
      isRegularFile: () => false,
    }).status.reason).toBe("native_unavailable");
  });

  it("requires both an absolute binary and model path before reporting ready", () => {
    const config = resolveSpeechConfig({
      env: {
        RUDDER_EXPERIMENTAL_CHAT_VOICE_INPUT: "1",
        RUDDER_SPEECH_BINARY_PATH: "/tmp/rudder-speech",
        RUDDER_SPEECH_MODEL_PATH: "/tmp/ggml-base.bin",
      },
      platform: "darwin",
      arch: "arm64",
      isRegularFile: () => true,
    });
    expect(config.status).toMatchObject({ enabled: true, available: true, reason: "ready" });
    expect(config.binaryPath).toBe("/tmp/rudder-speech");
    expect(config.modelPath).toBe("/tmp/ggml-base.bin");
    expect(resolveSpeechConfig({
      env: {
        RUDDER_EXPERIMENTAL_CHAT_VOICE_INPUT: "1",
        RUDDER_SPEECH_BINARY_PATH: "relative-worker",
      },
      platform: "darwin",
      arch: "arm64",
      isRegularFile: () => true,
    }).status.reason).toBe("configuration_invalid");
  });

  it("validates bounded mono f32le input before spawning the worker", () => {
    const valid = validateSpeechInput(speechInput());
    expect(valid.channels).toBe(1);
    expect(valid.pcm.byteLength).toBe(8);
    expect(() => validateSpeechInput({ ...speechInput(), channels: 2 })).toThrowError(SpeechRuntimeError);
    expect(() => validateSpeechInput({ ...speechInput(), requestId: "" })).toThrowError(SpeechRuntimeError);
  });

  it("keeps transcription local through the isolated worker and supports cancellation", async () => {
    const child = new FakeSpeechChild();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const runtime = createSpeechRuntime({
      env: {
        RUDDER_EXPERIMENTAL_CHAT_VOICE_INPUT: "1",
        RUDDER_SPEECH_BINARY_PATH: "/tmp/rudder-speech",
        RUDDER_SPEECH_MODEL_PATH: "/tmp/ggml-base.bin",
      },
      platform: "darwin",
      arch: "arm64",
      isRegularFile: () => true,
      spawnProcess,
      timeoutMs: 5_000,
    });

    const resultPromise = runtime.transcribe(speechInput());
    await Promise.resolve();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/tmp/rudder-speech",
      expect.arrayContaining(["transcribe", "--model", "/tmp/ggml-base.bin", "--sample-rate", "16000"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    child.stdout.emit("data", JSON.stringify({ ok: true, text: "local words", language: "en" }));
    child.emit("close", 0, null);
    await expect(resultPromise).resolves.toEqual({ text: "local words", language: "en" });
    expect(child.input).toBeInstanceOf(Buffer);

    const pendingChild = new FakeSpeechChild();
    const pendingRuntime = createSpeechRuntime({
      env: {
        RUDDER_EXPERIMENTAL_CHAT_VOICE_INPUT: "1",
        RUDDER_SPEECH_BINARY_PATH: "/tmp/rudder-speech",
        RUDDER_SPEECH_MODEL_PATH: "/tmp/ggml-base.bin",
      },
      platform: "darwin",
      arch: "arm64",
      isRegularFile: () => true,
      spawnProcess: vi.fn(() => pendingChild as unknown as ChildProcess),
      timeoutMs: 5_000,
    });
    const pending = pendingRuntime.transcribe(speechInput("voice:cancel"));
    await Promise.resolve();
    pendingRuntime.cancel("voice:cancel");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(pendingChild.kill).toHaveBeenCalledOnce();
  });
});
