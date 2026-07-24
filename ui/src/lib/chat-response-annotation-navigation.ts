import {
  chatInlineAnnotationSchema,
  type ChatInlineAnnotation,
} from "@rudderhq/shared";

const STATE_KEY = "chatResponseAnnotationSource";

type AnnotationSourceNavigation = {
  annotation: ChatInlineAnnotation;
  ordinal: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createChatResponseAnnotationNavigationState(
  annotation: ChatInlineAnnotation,
  ordinal: number,
  currentState?: unknown,
) {
  return {
    ...record(currentState),
    [STATE_KEY]: { annotation, ordinal },
  };
}

export function readChatResponseAnnotationNavigationState(
  state: unknown,
): AnnotationSourceNavigation | null {
  const candidate = record(state)[STATE_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  const parsed = chatInlineAnnotationSchema.safeParse(value.annotation);
  if (
    !parsed.success
    || typeof value.ordinal !== "number"
    || !Number.isInteger(value.ordinal)
    || value.ordinal < 1
  ) return null;
  return { annotation: parsed.data, ordinal: value.ordinal };
}

export function clearChatResponseAnnotationNavigationState(state: unknown) {
  const current = record(state);
  if (!(STATE_KEY in current)) return state;
  const { [STATE_KEY]: _removed, ...rest } = current;
  return Object.keys(rest).length > 0 ? rest : null;
}
