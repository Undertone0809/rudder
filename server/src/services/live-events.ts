import type { LiveEvent, LiveEventType } from "@rudderhq/shared";
import { EventEmitter } from "node:events";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  orgId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
  dedupeKey?: string;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    orgId: input.orgId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  orgId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
  dedupeKey?: string;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.orgId, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
  dedupeKey?: string;
}) {
  const event = toLiveEvent({
    orgId: "*",
    type: input.type,
    payload: input.payload,
    dedupeKey: input.dedupeKey,
  });
  emitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(orgId: string, listener: LiveEventListener) {
  emitter.on(orgId, listener);
  return () => emitter.off(orgId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
