export type GlobalSearchScope = "issue" | "library" | "chat" | "agent" | "project";

export interface GlobalSearchScopeDefinition {
  scope: GlobalSearchScope;
  label: string;
  aliases: readonly string[];
}

export const GLOBAL_SEARCH_SCOPE_DEFINITIONS: readonly GlobalSearchScopeDefinition[] = [
  { scope: "issue", label: "Issues", aliases: ["issue", "issues"] },
  { scope: "library", label: "Library", aliases: ["library", "docs", "doc"] },
  { scope: "chat", label: "Chats", aliases: ["chat", "chats"] },
  { scope: "agent", label: "Agents", aliases: ["agent", "agents"] },
  { scope: "project", label: "Projects", aliases: ["project", "projects"] },
];

export interface ParsedGlobalSearchQuery {
  scope: GlobalSearchScope | null;
  query: string;
  pendingScopeSuggestion: GlobalSearchScope | null;
}

const ALIAS_TO_SCOPE = new Map<GlobalSearchScopeDefinition["aliases"][number], GlobalSearchScope>(
  GLOBAL_SEARCH_SCOPE_DEFINITIONS.flatMap((definition) =>
    definition.aliases.map((alias) => [alias, definition.scope] as const),
  ),
);

export function getGlobalSearchScopeDefinition(scope: GlobalSearchScope) {
  return GLOBAL_SEARCH_SCOPE_DEFINITIONS.find((definition) => definition.scope === scope) ?? null;
}

export function getGlobalSearchScopeForAlias(value: string): GlobalSearchScope | null {
  return ALIAS_TO_SCOPE.get(value.trim().toLowerCase()) ?? null;
}

export function getPendingGlobalSearchScopeSuggestion(value: string): GlobalSearchScope | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /\s/.test(normalized)) return null;
  if (ALIAS_TO_SCOPE.has(normalized)) return null;
  return GLOBAL_SEARCH_SCOPE_DEFINITIONS.find((definition) =>
    definition.aliases.some((alias) => alias.startsWith(normalized)),
  )?.scope ?? null;
}

export function shouldConfirmGlobalSearchScopeFromValue(value: string): GlobalSearchScope | null {
  if (!/\s$/.test(value)) return null;
  return getGlobalSearchScopeForAlias(value);
}

export function shouldConfirmGlobalSearchScopeFromKey(key: string, value: string): GlobalSearchScope | null {
  if (key !== " " && key !== "Tab" && key !== "Enter") return null;
  return getGlobalSearchScopeForAlias(value);
}

export function parseGlobalSearchQuery(
  value: string,
  scope: GlobalSearchScope | null = null,
): ParsedGlobalSearchQuery {
  return {
    scope,
    query: value,
    pendingScopeSuggestion: scope ? null : getPendingGlobalSearchScopeSuggestion(value),
  };
}
