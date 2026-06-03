function pathnameOnly(path: string) {
  return path.split(/[?#]/, 1)[0] ?? path;
}

function parseAgentRoute(path: string) {
  const segments = pathnameOnly(path).split("/").filter(Boolean);
  const agentIndex = segments[0] === "agents"
    ? 0
    : segments[1] === "agents"
      ? 1
      : -1;
  if (agentIndex < 0 || !segments[agentIndex + 1]) return null;
  return {
    organizationPrefix: segments.slice(0, agentIndex).join("/"),
    agentRef: segments[agentIndex + 1],
    subroute: segments[agentIndex + 2] ?? null,
  };
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isRedirectOnlyBackStackEntry(currentPath: string, candidatePath: string) {
  const currentAgentRoute = parseAgentRoute(currentPath);
  const candidateAgentRoute = parseAgentRoute(candidatePath);
  if (!currentAgentRoute || !candidateAgentRoute) return false;
  return Boolean(currentAgentRoute.subroute)
    && !candidateAgentRoute.subroute
    && currentAgentRoute.organizationPrefix === candidateAgentRoute.organizationPrefix
    && (
      currentAgentRoute.agentRef === candidateAgentRoute.agentRef
      || looksLikeUuid(candidateAgentRoute.agentRef)
    );
}

export function resolveInAppBackStackTargetIndex(stack: readonly string[]) {
  if (stack.length < 2) return -1;
  const currentPath = stack[stack.length - 1];
  let targetIndex = stack.length - 2;
  while (
    currentPath
    && targetIndex > 0
    && isRedirectOnlyBackStackEntry(currentPath, stack[targetIndex] ?? "")
  ) {
    targetIndex -= 1;
  }
  return targetIndex;
}
