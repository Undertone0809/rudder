import { randomUUID } from "node:crypto";

const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

type NativeRunTarget = {
  organizationId: string;
  conversationId: string;
  generationId: string;
};

type NativeControl = {
  executionAuthority: "native_rust";
  orgId: string;
  conversationId: string;
  generationId: string;
  attemptEpoch: number;
  controlVersion: number;
  lastSequence: number;
  lastClientCheckpointSeq: number | null;
  lastClientCheckpointHash: string | null;
  runtimeTerminal: boolean;
};

function integer(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= 2_147_483_647;
}

function controlSnapshot(value: unknown, target: NativeRunTarget): NativeControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rudder could not verify the response being stopped.");
  }
  const control = value as NativeControl;
  if (control.executionAuthority !== "native_rust"
    || control.orgId !== target.organizationId
    || control.conversationId !== target.conversationId
    || control.generationId !== target.generationId
    || !integer(control.attemptEpoch, 1)
    || !integer(control.controlVersion, 0)
    || !integer(control.lastSequence, 0)
    || typeof control.runtimeTerminal !== "boolean"
    || ((control.lastClientCheckpointSeq === null) !== (control.lastClientCheckpointHash === null))
    || (control.lastClientCheckpointSeq !== null && (
      !integer(control.lastClientCheckpointSeq, 0)
      || control.lastClientCheckpointSeq > control.lastSequence
      || typeof control.lastClientCheckpointHash !== "string"
      || !HASH.test(control.lastClientCheckpointHash)
    ))) {
    throw new Error("Rudder could not verify the response being stopped.");
  }
  return control;
}

/** Desktop is a client of Rust's fenced Stop API, never a second Run writer. */
export async function stopNativeChatRun(options: {
  target: NativeRunTarget;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  signal: AbortSignal;
}): Promise<void> {
  const { target, request, signal } = options;
  if (!Object.values(target).every((id) => typeof id === "string" && UUID.test(id))) {
    throw new Error("Rudder could not identify the response being stopped.");
  }
  const prefix = `/chats/${encodeURIComponent(target.conversationId)}/messages/stream`;
  const read = async () => {
    signal.throwIfAborted();
    return controlSnapshot(await request<unknown>(
      `${prefix}/control?generationId=${encodeURIComponent(target.generationId)}`, { signal },
    ), target);
  };
  const control = await read();
  if (control.runtimeTerminal) return;
  const controlActionId = randomUUID();
  const result = await request<{ controlActionId: string; generationId: string; disposition?: string }>(`${prefix}/stop`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      controlActionId,
      expectedGenerationId: target.generationId,
      expectedAttemptEpoch: control.attemptEpoch,
      expectedControlVersion: control.controlVersion,
      lastCommittedRenderSeq: control.lastClientCheckpointSeq ?? 0,
      renderedBodyHash: control.lastClientCheckpointHash ?? EMPTY_BODY_HASH,
    }),
  });
  if (!result || result.controlActionId !== controlActionId || result.generationId !== target.generationId) {
    throw new Error("Rudder could not confirm the stop request.");
  }
  if (result.disposition === "control_lost") {
    throw new Error("This run was interrupted. Its process cleanup still needs confirmation.");
  }
  // Recording a cutoff is not proof that the provider stopped. The enclosing
  // quit deadline bounds this readback, including a lost or stalled executor.
  while (!(await read()).runtimeTerminal) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 100);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
