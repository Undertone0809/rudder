export type AiSearchScope =
  | "issue"
  | "chat"
  | "project"
  | "agent"
  | "skill"
  | "library";

export type AiSearchResultKind =
  | "issue"
  | "chat"
  | "project"
  | "agent"
  | "skill"
  | "library_document"
  | "library_entry";

export interface AiSearchResult {
  key: string;
  kind: AiSearchResultKind;
  id: string;
  title: string;
  preview: string | null;
  reason: string | null;
  href: string;
}

export interface AiSearchResponse {
  query: string;
  answer: string | null;
  results: AiSearchResult[];
}
