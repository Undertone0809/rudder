import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { issuesApi } from "@/api/issues";
import { organizationsApi } from "@/api/orgs";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { projectsApi } from "@/api/projects";
import { useOrganization } from "@/context/OrganizationContext";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { buildOrganizationSkillMentionOptions } from "@/lib/agent-skill-mentions";
import { buildMarkdownMentionOptions } from "@/lib/markdown-mention-options";
import { queryKeys } from "@/lib/queryKeys";
import type { MentionOption } from "@/components/MarkdownEditor";

interface MarkdownMentionsContextValue {
  mentions: MentionOption[];
  onMentionQueryChange: (query: string | null) => void;
}

const MarkdownMentionsContext = createContext<MarkdownMentionsContextValue>({
  mentions: [],
  onMentionQueryChange: () => {},
});

export function MarkdownMentionsProvider({ children }: { children: ReactNode }) {
  const { selectedOrganization, selectedOrganizationId } = useOrganization();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const organizationId = viewedOrganizationId ?? selectedOrganizationId;
  const organizationUrlKey = viewedOrganization?.urlKey ?? selectedOrganization?.urlKey ?? "organization";
  const [libraryFileMentionQuery, setLibraryFileMentionQuery] = useState<string | null>(null);
  const normalizedLibraryFileMentionQuery = libraryFileMentionQuery?.trim() ?? "";

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(organizationId ?? "__none__"),
    queryFn: () => agentsApi.list(organizationId!),
    enabled: Boolean(organizationId),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(organizationId ?? "__none__"),
    queryFn: () => projectsApi.list(organizationId!),
    enabled: Boolean(organizationId),
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(organizationId ?? "__none__"),
    queryFn: () => issuesApi.list(organizationId!),
    enabled: Boolean(organizationId),
  });

  const { data: chats } = useQuery({
    queryKey: queryKeys.chats.list(organizationId ?? "__none__", "all"),
    queryFn: () => chatsApi.list(organizationId!, "all"),
    enabled: Boolean(organizationId),
  });

  const { data: libraryDocuments } = useQuery({
    queryKey: queryKeys.organizations.libraryDocuments(organizationId ?? "__none__"),
    queryFn: () => organizationsApi.listLibraryDocuments(organizationId!),
    enabled: Boolean(organizationId),
  });

  const { data: libraryMentionFiles } = useQuery({
    queryKey: [
      "organizations",
      organizationId ?? "__none__",
      "workspace-mention-files",
      normalizedLibraryFileMentionQuery,
    ] as const,
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(organizationId!, {
      query: normalizedLibraryFileMentionQuery,
      limit: normalizedLibraryFileMentionQuery ? 50 : 200,
    }),
    enabled: Boolean(organizationId),
  });

  const { data: organizationSkills } = useQuery({
    queryKey: queryKeys.organizationSkills.list(organizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(organizationId!),
    enabled: Boolean(organizationId),
  });

  const skillMentionOptions = useMemo(
    () => buildOrganizationSkillMentionOptions({
      orgUrlKey: organizationUrlKey,
      organizationSkills,
    }),
    [organizationSkills, organizationUrlKey],
  );

  const mentions = useMemo(
    () => buildMarkdownMentionOptions({
      agents,
      projects,
      issues,
      chats,
      libraryDocuments,
      libraryFiles: libraryMentionFiles?.entries,
      skillMentionOptions,
    }),
    [
      agents,
      chats,
      issues,
      libraryDocuments,
      libraryMentionFiles?.entries,
      projects,
      skillMentionOptions,
    ],
  );

  const onMentionQueryChange = useCallback((query: string | null) => {
    setLibraryFileMentionQuery(query);
  }, []);

  const value = useMemo(
    () => ({ mentions, onMentionQueryChange }),
    [mentions, onMentionQueryChange],
  );

  return (
    <MarkdownMentionsContext.Provider value={value}>
      {children}
    </MarkdownMentionsContext.Provider>
  );
}

export function useMarkdownMentions() {
  return useContext(MarkdownMentionsContext);
}
