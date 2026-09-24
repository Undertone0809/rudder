function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function operationAt(spec: unknown, route: string, method: string): Record<string, unknown> | null {
  const paths = record(record(spec)?.paths);
  return record(record(paths?.[route])?.[method]);
}

export function openCodeSideChatCleanupContractError(spec: unknown): string | null {
  const deleteOperation = operationAt(spec, "/session/{sessionID}", "delete");
  const deleteDescription = typeof deleteOperation?.description === "string"
    ? deleteOperation.description
    : "";
  const deleteResponse = record(record(deleteOperation?.responses)?.["200"]);
  const deleteSchema = record(record(deleteResponse?.content)?.["application/json"]);
  const deleteResultSchema = record(deleteSchema?.schema);
  if (
    deleteOperation?.operationId !== "session.delete"
    || !deleteDescription.includes("permanently remove all associated data, including messages and history")
    || deleteResultSchema?.type !== "boolean"
  ) {
    return "The installed OpenCode /doc does not attest the exact session.delete contract.";
  }

  if (operationAt(spec, "/session/{sessionID}", "get")?.operationId !== "session.get") {
    return "The installed OpenCode /doc does not attest session.get for cleanup preflight.";
  }
  const childrenOperation = operationAt(spec, "/session/{sessionID}/children", "get");
  const childrenDescription = typeof childrenOperation?.description === "string"
    ? childrenOperation.description
    : "";
  if (
    childrenOperation?.operationId !== "session.children"
    || !childrenDescription.includes("child sessions that were forked from the specified parent session")
  ) {
    return "The installed OpenCode /doc does not attest session.children for descendant protection.";
  }
  return null;
}

export function openCodeForkCleanupSafetyError(input: {
  session: unknown;
  sessionId: string;
  expectedParentSessionId: string;
  children: unknown;
}): string | null {
  const session = record(input.session);
  if (!session || session.id !== input.sessionId) {
    return "OpenCode cleanup preflight returned a different session identity.";
  }
  if (
    !input.expectedParentSessionId
    || input.expectedParentSessionId === input.sessionId
    || session.parentID !== input.expectedParentSessionId
  ) {
    return "OpenCode session is not the recorded Side Chat fork of its expected parent.";
  }
  if (!Array.isArray(input.children)) {
    return "OpenCode cleanup preflight could not verify provider-side child sessions.";
  }
  if (input.children.length > 0) {
    return "OpenCode Side Chat session has provider-side descendants and was retained.";
  }
  return null;
}
