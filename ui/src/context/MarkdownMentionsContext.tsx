import { agentsApi } from "@/api/agents";
import { automationsApi } from "@/api/automations";
import { chatsApi } from "@/api/chats";
import { issuesApi } from "@/api/issues";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import type { MentionOption } from "@/components/MarkdownEditor";
import { useOrganization } from "@/context/OrganizationContext";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { buildOrganizationSkillMentionOptions } from "@/lib/agent-skill-mentions";
import { buildMarkdownMentionOptions } from "@/lib/markdown-mention-options";
import { usePluginMentionCatalog } from "@/lib/plugin-mentions";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface MarkdownMentionsContextValue {
  mentions: MentionOption[];
  onMentionQueryChange: (query: string | null) => void;
}

const MarkdownMentionsContext = createContext<MarkdownMentionsContextValue>({
  mentions: [],
  onMentionQueryChange: () => {},
});

const DEFAULT_MENTION_CATALOG_LIMIT = 40;
const SEARCH_MENTION_CATALOG_LIMIT = 25;

export function MarkdownMentionsProvider({ children }: { children: ReactNode }) {
  const { selectedOrganization, selectedOrganizationId } = useOrganization();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const organizationId = viewedOrganizationId ?? selectedOrganizationId;
  const organizationUrlKey = viewedOrganization?.urlKey ?? selectedOrganization?.urlKey ?? "organization";
  const [libraryFileMentionQuery, setLibraryFileMentionQuery] = useState<string | null>(null);
  const normalizedLibraryFileMentionQuery = libraryFileMentionQuery?.trim() ?? "";
  const mentionCatalogLimit = normalizedLibraryFileMentionQuery
    ? SEARCH_MENTION_CATALOG_LIMIT
    : DEFAULT_MENTION_CATALOG_LIMIT;

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
    queryKey: [
      ...queryKeys.issues.mentionCatalog(organizationId ?? "__none__"),
      normalizedLibraryFileMentionQuery,
      mentionCatalogLimit,
    ],
    queryFn: () => issuesApi.list(organizationId!, {
      includeAutomationExecutions: Boolean(normalizedLibraryFileMentionQuery),
      q: normalizedLibraryFileMentionQuery || undefined,
      limit: mentionCatalogLimit,
    }),
    enabled: Boolean(organizationId),
  });

  const { data: automations } = useQuery({
    queryKey: queryKeys.automations.list(organizationId ?? "__none__"),
    queryFn: () => automationsApi.list(organizationId!),
    enabled: Boolean(organizationId),
  });

  const { data: chats } = useQuery({
    queryKey: normalizedLibraryFileMentionQuery
      ? queryKeys.chats.search(organizationId ?? "__none__", normalizedLibraryFileMentionQuery, "all")
      : queryKeys.chats.listPreview(organizationId ?? "__none__", "all", mentionCatalogLimit),
    queryFn: () => chatsApi.list(organizationId!, "all", {
      q: normalizedLibraryFileMentionQuery || undefined,
      limit: mentionCatalogLimit,
    }),
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
  const pluginMentions = usePluginMentionCatalog(organizationId);

  const skillMentionOptions = useMemo(
    () => buildOrganizationSkillMentionOptions({
      orgUrlKey: organizationUrlKey,
      organizationSkills,
      pluginManagedSkillIds: pluginMentions.managedSkillIds,
    }),
    [organizationSkills, organizationUrlKey, pluginMentions.managedSkillIds],
  );

  const mentions = useMemo(
    () => buildMarkdownMentionOptions({
      agents,
      automations,
      projects,
      issues,
      chats,
      libraryDocuments,
      libraryFiles: libraryMentionFiles?.entries,
      skillMentionOptions,
      pluginMentionOptions: pluginMentions.options,
    }),
    [
      agents,
      automations,
      chats,
      issues,
      libraryDocuments,
      libraryMentionFiles?.entries,
      projects,
      pluginMentions.options,
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
