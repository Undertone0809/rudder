import type { MarkdownEditorRef } from "@/components/MarkdownEditor";
import {
  readDesktopShell,
  type DesktopSpeechApi,
  type DesktopSpeechStatus,
} from "@/lib/desktop-shell";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type DesktopVoiceInputState =
  | "unavailable"
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "success"
  | "empty"
  | "error"
  | "cancelled";

export type DesktopVoiceInputErrorCode =
  | "permission_denied"
  | "microphone_unavailable"
  | "unsupported"
  | "empty_audio"
  | "engine_failed"
  | "cancelled";

type CaptureSession = {
  requestId: string;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  output: GainNode;
  chunks: Float32Array[];
  sampleCount: number;
  maxSamples: number;
  stopped: boolean;
};

type VoiceInputError = Error & {
  code?: DesktopVoiceInputErrorCode;
};

const PROCESSOR_NAME = "rudder-mono-pcm-capture";
const DEFAULT_MAX_DURATION_SECONDS = 60;
const DEFAULT_MAX_BYTES = 48_000 * DEFAULT_MAX_DURATION_SECONDS * 4;
const WORKLET_SOURCE = `
class RudderMonoPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice());
    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);
    return true;
  }
}
registerProcessor("${PROCESSOR_NAME}", RudderMonoPcmCaptureProcessor);
`;

function createVoiceInputError(
  code: DesktopVoiceInputErrorCode,
  message: string,
): VoiceInputError {
  const error = new Error(message) as VoiceInputError;
  error.code = code;
  return error;
}

function errorCodeFromUnknown(error: unknown): DesktopVoiceInputErrorCode {
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "permission_denied"
      || code === "microphone_unavailable"
      || code === "unsupported"
      || code === "empty_audio"
      || code === "engine_failed"
      || code === "cancelled"
    ) return code;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("empty_audio")) return "empty_audio";
  if (message.includes("cancelled")) return "cancelled";
  if (message.includes("NotAllowedError") || message.includes("Permission")) {
    return "permission_denied";
  }
  if (message.includes("NotFoundError") || message.includes("NotReadableError")) {
    return "microphone_unavailable";
  }
  return "engine_failed";
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

async function closeCaptureSession(session: CaptureSession): Promise<void> {
  if (session.stopped) return;
  session.stopped = true;
  session.processor.port.onmessage = null;
  try {
    session.source.disconnect();
  } catch {
    // The graph may already be disconnected during a device failure.
  }
  try {
    session.processor.disconnect();
  } catch {
    // The graph may already be disconnected during a device failure.
  }
  try {
    session.output.disconnect();
  } catch {
    // The graph may already be disconnected during a device failure.
  }
  stopStream(session.stream);
  try {
    await session.context.close();
  } catch {
    // Closing an already-closed AudioContext is harmless for this workflow.
  }
}

function audioContextConstructor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const candidate = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return candidate ?? null;
}

async function createCaptureSession(
  requestId: string,
  stream: MediaStream,
  maxSamples: number,
): Promise<CaptureSession> {
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor) {
    stopStream(stream);
    throw createVoiceInputError("unsupported", "Audio capture is not supported.");
  }

  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: AudioWorkletNode | null = null;
  let output: GainNode | null = null;
  try {
    context = new AudioContextCtor();
    if (!context.audioWorklet) {
      throw createVoiceInputError("unsupported", "AudioWorklet is not supported.");
    }
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    output = context.createGain();
    output.gain.value = 0;
    source.connect(processor);
    processor.connect(output);
    output.connect(context.destination);
    await context.resume();

    const session: CaptureSession = {
      requestId,
      stream,
      context,
      source,
      processor,
      output,
      chunks: [],
      sampleCount: 0,
      maxSamples,
      stopped: false,
    };
    return session;
  } catch (error) {
    if (source) {
      try { source.disconnect(); } catch { /* best effort */ }
    }
    if (processor) {
      try { processor.disconnect(); } catch { /* best effort */ }
    }
    if (output) {
      try { output.disconnect(); } catch { /* best effort */ }
    }
    stopStream(stream);
    try { await context?.close(); } catch { /* best effort */ }
    if (error instanceof Error && "code" in error) throw error;
    throw createVoiceInputError("engine_failed", "Could not start audio capture.");
  }
}

function pcmBufferForSession(session: CaptureSession): ArrayBuffer {
  const buffer = new ArrayBuffer(session.sampleCount * Float32Array.BYTES_PER_ELEMENT);
  const output = new Float32Array(buffer);
  let offset = 0;
  for (const chunk of session.chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

function createRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return `voice:${randomUuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export function desktopVoiceInputStatusMessage(state: DesktopVoiceInputState): string {
  switch (state) {
    case "requesting": return "Requesting microphone access...";
    case "recording": return "Recording locally. Select stop when you are done.";
    case "transcribing": return "Transcribing locally...";
    case "success": return "Voice input inserted into the draft.";
    case "empty": return "No speech detected. Your draft was kept.";
    case "cancelled": return "Voice input cancelled. Your draft was kept.";
    case "error": return "Voice input failed. Your draft was kept.";
    default: return "";
  }
}

export function useDesktopVoiceInput({
  editorRef,
  scopeKey,
  disabled = false,
}: {
  editorRef: RefObject<MarkdownEditorRef | null>;
  scopeKey: string;
  disabled?: boolean;
}) {
  const speech = readDesktopShell()?.speech ?? null;
  const speechRef = useRef<DesktopSpeechApi | null>(speech);
  speechRef.current = speech;
  const [status, setStatus] = useState<DesktopSpeechStatus | null>(null);
  const [state, setState] = useState<DesktopVoiceInputState>("unavailable");
  const [errorCode, setErrorCode] = useState<DesktopVoiceInputErrorCode | null>(null);
  const stateRef = useRef<DesktopVoiceInputState>("unavailable");
  const activeRequestIdRef = useRef<string | null>(null);
  const sessionRef = useRef<CaptureSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const scopeRef = useRef(scopeKey);
  const statusRef = useRef<DesktopSpeechStatus | null>(status);
  statusRef.current = status;

  const transition = useCallback((next: DesktopVoiceInputState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const isCurrent = useCallback((requestId: string) => (
    mountedRef.current && activeRequestIdRef.current === requestId
  ), []);

  useEffect(() => {
    let disposed = false;
    setStatus(null);
    if (!speech?.supported) {
      transition("unavailable");
      return () => { disposed = true; };
    }
    void speech.getStatus().then((nextStatus) => {
      if (disposed) return;
      setStatus(nextStatus);
      transition(nextStatus.available ? "idle" : "unavailable");
    }).catch(() => {
      if (disposed) return;
      setStatus(null);
      transition("unavailable");
    });
    return () => { disposed = true; };
  }, [speech, transition]);

  const finishTranscription = useCallback(async (
    session: CaptureSession,
    speechApi: DesktopSpeechApi,
  ) => {
    await closeCaptureSession(session);
    if (!isCurrent(session.requestId)) return;
    if (session.sampleCount === 0) {
      activeRequestIdRef.current = null;
      setErrorCode("empty_audio");
      transition("empty");
      return;
    }

    try {
      const result = await speechApi.transcribe({
        requestId: session.requestId,
        pcm: pcmBufferForSession(session),
        sampleRate: session.context.sampleRate,
        channels: 1,
        format: "f32le",
      });
      if (!isCurrent(session.requestId)) return;
      const text = result.text.trim();
      if (!text) {
        setErrorCode("empty_audio");
        transition("empty");
      } else if (editorRef.current?.insertTextAtSelection(text)) {
        setErrorCode(null);
        transition("success");
      } else {
        setErrorCode("engine_failed");
        transition("error");
      }
    } catch (error) {
      if (!isCurrent(session.requestId)) return;
      const code = errorCodeFromUnknown(error);
      setErrorCode(code);
      transition(code === "cancelled" ? "cancelled" : code === "empty_audio" ? "empty" : "error");
    } finally {
      if (activeRequestIdRef.current === session.requestId) activeRequestIdRef.current = null;
    }
  }, [editorRef, isCurrent, transition]);

  const cancel = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    activeRequestIdRef.current = null;
    clearTimer();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void closeCaptureSession(session);
    if (stateRef.current === "transcribing") {
      void speechRef.current?.cancel(requestId).catch(() => undefined);
    }
    setErrorCode("cancelled");
    transition("cancelled");
  }, [clearTimer, transition]);

  const stop = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    if (stateRef.current === "requesting" || stateRef.current === "transcribing") {
      cancel();
      return;
    }
    const session = sessionRef.current;
    if (!session || session.requestId !== requestId) return;
    sessionRef.current = null;
    clearTimer();
    transition("transcribing");
    const speechApi = speechRef.current;
    if (!speechApi) {
      activeRequestIdRef.current = null;
      setErrorCode("engine_failed");
      transition("error");
      void closeCaptureSession(session);
      return;
    }
    void finishTranscription(session, speechApi);
  }, [cancel, clearTimer, finishTranscription, transition]);

  const start = useCallback(() => {
    const speechApi = speechRef.current;
    const currentStatus = statusRef.current;
    if (
      !speechApi
      || !speechApi.supported
      || !currentStatus?.available
      || disabled
      || activeRequestIdRef.current
    ) return;

    const requestId = createRequestId();
    activeRequestIdRef.current = requestId;
    setErrorCode(null);
    transition("requesting");
    void (async () => {
      let stream: MediaStream | null = null;
      try {
        const permission = await speechApi.requestMicrophoneAccess();
        if (!isCurrent(requestId)) return;
        if (permission !== "authorized") {
          throw createVoiceInputError("permission_denied", "Microphone access was denied.");
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw createVoiceInputError("unsupported", "Microphone capture is not supported.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: false,
            channelCount: { ideal: 1, max: 1 },
            echoCancellation: false,
            noiseSuppression: false,
          },
          video: false,
        });
        if (!isCurrent(requestId)) {
          stopStream(stream);
          return;
        }
        const maxBytes = Math.min(
          currentStatus.maxBytes || DEFAULT_MAX_BYTES,
          DEFAULT_MAX_BYTES,
        );
        const maxSamples = Math.max(1, Math.floor(maxBytes / Float32Array.BYTES_PER_ELEMENT));
        const session = await createCaptureSession(requestId, stream, maxSamples);
        stream = null;
        if (!isCurrent(requestId)) {
          await closeCaptureSession(session);
          return;
        }
        sessionRef.current = session;
        session.processor.port.onmessage = (event: MessageEvent<unknown>) => {
          if (session.stopped || !isCurrent(requestId)) return;
          const data = event.data;
          const samples = data instanceof Float32Array
            ? data
            : data instanceof ArrayBuffer
              ? new Float32Array(data)
              : null;
          if (!samples || samples.length === 0) return;
          const remaining = session.maxSamples - session.sampleCount;
          if (remaining <= 0) {
            stop();
            return;
          }
          const bounded = samples.length > remaining ? samples.slice(0, remaining) : samples;
          session.chunks.push(bounded);
          session.sampleCount += bounded.length;
          if (session.sampleCount >= session.maxSamples) stop();
        };
        transition("recording");
        const maxDuration = Math.max(
          1,
          Math.min(
            currentStatus.maxDurationSeconds || DEFAULT_MAX_DURATION_SECONDS,
            DEFAULT_MAX_DURATION_SECONDS,
          ),
        );
        timerRef.current = setTimeout(stop, maxDuration * 1_000);
      } catch (error) {
        if (stream) stopStream(stream);
        if (!isCurrent(requestId)) return;
        activeRequestIdRef.current = null;
        const code = errorCodeFromUnknown(error);
        setErrorCode(code);
        transition(code === "cancelled" ? "cancelled" : "error");
      }
    })();
  }, [disabled, isCurrent, stop, transition]);

  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    cancel();
  }, [cancel, scopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      const requestId = activeRequestIdRef.current;
      activeRequestIdRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void closeCaptureSession(session);
      if (requestId && stateRef.current === "transcribing") {
        void speechRef.current?.cancel(requestId).catch(() => undefined);
      }
    };
  }, [clearTimer]);

  const visible = Boolean(speech?.supported && status?.available);
  const busy = state === "requesting" || state === "recording" || state === "transcribing";
  return {
    visible,
    state,
    busy,
    errorCode,
    status,
    statusMessage: desktopVoiceInputStatusMessage(state),
    start,
    stop,
    cancel,
  };
}
