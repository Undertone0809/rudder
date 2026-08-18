// @vitest-environment jsdom

import type { MarkdownEditorRef } from "@/components/MarkdownEditor";
import type {
  DesktopSpeechApi,
  DesktopSpeechResult,
  DesktopSpeechStatus,
} from "@/lib/desktop-shell";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDesktopVoiceInput,
} from "./useDesktopVoiceInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status: DesktopSpeechStatus = {
  enabled: true,
  available: true,
  reason: "ready",
  maxDurationSeconds: 60,
  maxBytes: 48_000 * 60 * 4,
  minSampleRate: 8_000,
  maxSampleRate: 48_000,
};

class FakeAudioNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    return new FakeAudioNode() as unknown as MediaStreamAudioSourceNode;
  }
  createGain() {
    return Object.assign(new FakeAudioNode(), { gain: { value: 1 } }) as unknown as GainNode;
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static instances: FakeAudioWorkletNode[] = [];
  port: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = { onmessage: null };
  constructor() {
    super();
    FakeAudioWorkletNode.instances.push(this);
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function installSpeechBridge(speech: DesktopSpeechApi) {
  (window as typeof window & { desktopShell?: { speech: DesktopSpeechApi } }).desktopShell = { speech };
}

function createSpeechBridge(overrides: Partial<DesktopSpeechApi> = {}): DesktopSpeechApi {
  return {
    supported: true,
    getStatus: vi.fn().mockResolvedValue(status),
    requestMicrophoneAccess: vi.fn().mockResolvedValue("authorized"),
    transcribe: vi.fn().mockResolvedValue({ text: "hello from voice", language: "en" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function VoiceHarness({
  insertText,
  scopeKey = "scope-a",
}: {
  insertText: (text: string) => boolean;
  scopeKey?: string;
}) {
  const editorRef = { current: { insertTextAtSelection: insertText } as MarkdownEditorRef };
  const voice = useDesktopVoiceInput({ editorRef, scopeKey });
  return (
    <div
      data-state={voice.state}
      data-visible={voice.visible ? "true" : "false"}
      data-message={voice.statusMessage}
    >
      <button type="button" data-start onClick={voice.start}>Start</button>
      <button type="button" data-stop onClick={voice.stop}>Stop</button>
      <button type="button" data-cancel onClick={voice.cancel}>Cancel</button>
    </div>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHarness(props: { insertText: (text: string) => boolean; scopeKey?: string }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<VoiceHarness {...props} />);
    await Promise.resolve();
  });
  await flush();
}

function streamWithTrack() {
  const track = { stop: vi.fn() };
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    track,
  };
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:voice") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  FakeAudioContext.instances = [];
  FakeAudioWorkletNode.instances = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useDesktopVoiceInput", () => {
  it("keeps the voice entry hidden without the Desktop bridge", async () => {
    const insertText = vi.fn(() => true);
    await renderHarness({ insertText });

    expect(container?.firstElementChild?.getAttribute("data-visible")).toBe("false");
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("unavailable");
  });

  it("captures bounded PCM and inserts the local result into the editor selection", async () => {
    const { stream, track } = streamWithTrack();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const insertText = vi.fn(() => true);
    const speech = createSpeechBridge();
    installSpeechBridge(speech);
    await renderHarness({ insertText });

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-start]")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("recording");
    const processor = FakeAudioWorkletNode.instances[0];
    processor?.port.onmessage?.({ data: new Float32Array([0.25, -0.25, 0.5]) } as MessageEvent<unknown>);

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-stop]")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(speech.transcribe).toHaveBeenCalledOnce();
    const input = vi.mocked(speech.transcribe).mock.calls[0]?.[0];
    expect(input?.sampleRate).toBe(48_000);
    expect(input?.channels).toBe(1);
    expect(input?.format).toBe("f32le");
    expect(new Float32Array(input?.pcm ?? new ArrayBuffer(0))).toEqual(new Float32Array([0.25, -0.25, 0.5]));
    expect(insertText).toHaveBeenCalledWith("hello from voice");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("success");
  });

  it("keeps the draft and ignores a late native result after cancellation", async () => {
    const { stream } = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    const resolveTranscription: { current: ((result: DesktopSpeechResult) => void) | null } = {
      current: null,
    };
    const speech = createSpeechBridge({
      transcribe: vi.fn((_input) => new Promise<DesktopSpeechResult>((resolve) => {
        resolveTranscription.current = resolve;
      })),
    });
    installSpeechBridge(speech);
    const insertText = vi.fn(() => true);
    await renderHarness({ insertText });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-start]")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    FakeAudioWorkletNode.instances[0]?.port.onmessage?.({ data: new Float32Array([0.2]) } as MessageEvent<unknown>);
    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-stop]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("transcribing");

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-cancel]")?.click();
      await Promise.resolve();
    });
    expect(speech.cancel).toHaveBeenCalledOnce();
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("cancelled");
    resolveTranscription.current?.({ text: "late result", language: "en" });
    await flush();
    expect(insertText).not.toHaveBeenCalled();
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("cancelled");
  });

  it("turns permission and device failures into a draft-preserving error state", async () => {
    const speech = createSpeechBridge({
      requestMicrophoneAccess: vi.fn().mockResolvedValue("denied"),
    });
    installSpeechBridge(speech);
    const insertText = vi.fn(() => true);
    await renderHarness({ insertText });

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-start]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("error");
    expect(container?.firstElementChild?.getAttribute("data-message")).toContain("failed");
    expect(insertText).not.toHaveBeenCalled();
  });

  it("cancels an active capture when the chat scope changes", async () => {
    const { stream, track } = streamWithTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    const speech = createSpeechBridge();
    installSpeechBridge(speech);
    const insertText = vi.fn(() => true);
    await renderHarness({ insertText, scopeKey: "scope-a" });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>("[data-start]")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("recording");
    await act(async () => root?.render(<VoiceHarness insertText={insertText} scopeKey="scope-b" />));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container?.firstElementChild?.getAttribute("data-state")).toBe("cancelled");
  });
});
