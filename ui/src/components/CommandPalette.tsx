import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useNavigate } from "@/lib/router";
import type { Agent, IssueSearchField, OrganizationWorkspaceFileEntry, Project } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleDot,
  Clock3,
  DollarSign,
  FileText,
  Folder,
  Hexagon,
  History,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Target,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { agentsApi } from "../api/agents";
import { chatsApi } from "../api/chats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { issuesApi } from "../api/issues";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { useSidebar } from "../context/SidebarContext";
import {
  getGlobalSearchScopeDefinition,
  getPendingGlobalSearchScopeSuggestion,
  shouldConfirmGlobalSearchScopeFromKey,
  shouldConfirmGlobalSearchScopeFromValue,
  type GlobalSearchScope,
} from "../lib/global-search-scope";
import { eventMatchesShortcutAction, isEditableShortcutTarget } from "../lib/keyboard-shortcuts";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, projectUrl } from "../lib/utils";
import { AgentIdentity } from "./AgentAvatar";
import { ProjectIcon } from "./ProjectIdentity";

const GLOBAL_ISSUE_SEARCH_FIELDS: IssueSearchField[] = ["title", "description", "comment"];
const LIBRARY_SEARCH_LIMIT = 20;

function searchTokensMatch(query: string, tokens: Array<string | null | undefined>) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return tokens.some((token) => token?.toLowerCase().includes(normalizedQuery));
}

function getLibraryEntryHref(entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">) {
  const key = entry.isDirectory ? "directory" : "path";
  return `/library?${key}=${encodeURIComponent(entry.path)}`;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<GlobalSearchScope | null>(null);
  const [query, setQuery] = useState("");
  const [launchSource, setLaunchSource] = useState<"shortcut" | "primary-rail">("shortcut");
  const navigate = useNavigate();
  const { selectedOrganizationId } = useOrganization();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();
  const shortcutSettingsQuery = useQuery({
    queryKey: queryKeys.instance.shortcutSettings,
    queryFn: () => instanceSettingsApi.getShortcuts(),
    retry: false,
  });
  const shortcutSettings = shortcutSettingsQuery.data === undefined
    ? (shortcutSettingsQuery.isError ? null : undefined)
    : shortcutSettingsQuery.data;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isEditableShortcutTarget(e.target)) return;
      if (eventMatchesShortcutAction(e, "commandPalette.open", shortcutSettings)) {
        e.preventDefault();
        setLaunchSource("shortcut");
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setSidebarOpen, shortcutSettings]);

  useEffect(() => {
    function handleOpenCommandPalette(event: Event) {
      const source = event instanceof CustomEvent && event.detail?.source === "primary-rail"
        ? "primary-rail"
        : "shortcut";
      setLaunchSource(source);
      setOpen(true);
      if (isMobile) setSidebarOpen(false);
    }

    document.addEventListener("rudder:open-command-palette", handleOpenCommandPalette);
    return () => document.removeEventListener("rudder:open-command-palette", handleOpenCommandPalette);
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    if (!open) {
      setScope(null);
      setQuery("");
    }
  }, [open]);

  const scopeDefinition = scope ? getGlobalSearchScopeDefinition(scope) : null;
  const pendingScopeSuggestion = scope ? null : getPendingGlobalSearchScopeSuggestion(query);
  const pendingScopeDefinition = pendingScopeSuggestion
    ? getGlobalSearchScopeDefinition(pendingScopeSuggestion)
    : null;

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId!),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && open && (scope === null || scope === "issue"),
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedOrganizationId!, searchQuery, undefined, GLOBAL_ISSUE_SEARCH_FIELDS),
    queryFn: () => issuesApi.list(selectedOrganizationId!, {
      q: searchQuery,
      searchFields: GLOBAL_ISSUE_SEARCH_FIELDS,
    }),
    enabled: !!selectedOrganizationId
      && open
      && searchQuery.length > 0
      && (scope === null || scope === "issue"),
  });

  const { data: searchedChats = [] } = useQuery({
    queryKey: queryKeys.chats.search(selectedOrganizationId!, searchQuery),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "all", { q: searchQuery }),
    enabled: !!selectedOrganizationId
      && open
      && searchQuery.length > 0
      && (scope === null || scope === "chat"),
  });

  const { data: librarySearch = { entries: [] } } = useQuery({
    queryKey: queryKeys.organizations.workspaceMentionFiles(selectedOrganizationId!, searchQuery),
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(selectedOrganizationId!, {
      query: searchQuery,
      limit: LIBRARY_SEARCH_LIMIT,
    }),
    enabled: !!selectedOrganizationId && open && scope === "library" && searchQuery.length > 0,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && open,
  });
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const { data: allProjects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && open,
  });
  const projects = useMemo(
    () => allProjects.filter((p) => !p.archivedAt),
    [allProjects],
  );

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  function enterScope(nextScope: GlobalSearchScope) {
    setScope(nextScope);
    setQuery("");
  }

  function clearScope() {
    setScope(null);
    setQuery("");
  }

  function handleInputValueChange(value: string) {
    if (!scope) {
      const confirmedScope = shouldConfirmGlobalSearchScopeFromValue(value);
      if (confirmedScope) {
        enterScope(confirmedScope);
        return;
      }
    }
    setQuery(value);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!scope) {
      const confirmedScope = shouldConfirmGlobalSearchScopeFromKey(event.key, query);
      if (confirmedScope) {
        event.preventDefault();
        enterScope(confirmedScope);
        return;
      }
    }
    if (scope && event.key === "Backspace" && query.length === 0) {
      event.preventDefault();
      clearScope();
    }
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => {
      if (scope !== null && scope !== "issue") return [];
      return searchQuery.length > 0 ? searchedIssues : issues;
    },
    [issues, searchedIssues, searchQuery, scope],
  );
  const visibleChats = scope === null || scope === "chat" ? searchedChats : [];
  const libraryEntries = scope === "library" && searchQuery.length > 0 ? librarySearch.entries : [];
  const filteredAgents = useMemo(
    () => agents.filter((agent: Agent) => searchTokensMatch(searchQuery, [
      agent.name,
      agent.role,
      agent.title,
      agent.urlKey,
    ])),
    [agents, searchQuery],
  );
  const visibleAgents = scope === null || scope === "agent" ? filteredAgents : [];
  const filteredProjects = useMemo(
    () => projects.filter((project: Project) => searchTokensMatch(searchQuery, [
      project.name,
      project.description,
      project.urlKey,
      project.status,
    ])),
    [projects, searchQuery],
  );
  const visibleProjects = scope === null || scope === "project" ? filteredProjects : [];
  const placeholder = scopeDefinition
    ? `Search ${scopeDefinition.label}...`
    : "Search issues, chats, agents, projects, library...";
  const scopedEmptyLabel = scopeDefinition
    ? `No ${scopeDefinition.label.toLowerCase()} results found.`
    : "No results found.";

  return (
    <CommandDialog open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}
      contentStyle={isMobile ? undefined : { left: "50vw", top: "50vh" }}
      className={launchSource === "primary-rail"
        ? "command-palette-content command-palette-content--from-rail glass-popover command-palette-glass sm:max-w-2xl"
        : "command-palette-content glass-popover command-palette-glass sm:max-w-2xl"
      }>
      <CommandInput
        placeholder={placeholder}
        value={query}
        onValueChange={handleInputValueChange}
        onKeyDown={handleInputKeyDown}
        inputPrefix={scopeDefinition ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border bg-muted px-2 text-xs font-medium text-muted-foreground">
            {scopeDefinition.label}
            <button
              type="button"
              aria-label={`Clear ${scopeDefinition.label} search scope`}
              className="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-sm hover:bg-background hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearScope}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : undefined}
        className="pr-8"
      />
      <CommandList>
        {!(scope === "library" && searchQuery.length === 0) && (
          <CommandEmpty>{scopedEmptyLabel}</CommandEmpty>
        )}

        {pendingScopeDefinition && (
          <CommandGroup heading="Scope">
            <CommandItem
              value={`${query} search in ${pendingScopeDefinition.label}`}
              onSelect={() => enterScope(pendingScopeDefinition.scope)}
            >
              <span className="mr-2 flex h-4 w-4 items-center justify-center rounded-sm border text-[10px] text-muted-foreground">
                /
              </span>
              <span className="flex-1">Search in {pendingScopeDefinition.label}</span>
            </CommandItem>
          </CommandGroup>
        )}

        {scope === null && (
          <CommandGroup heading="Pages">
            <CommandItem value="dashboard" onSelect={() => go("/dashboard")}>
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Dashboard
            </CommandItem>
            <CommandItem value="messenger chat conversations" onSelect={() => go("/messenger")}>
              <MessageSquare className="mr-2 h-4 w-4" />
              Messenger
            </CommandItem>
            <CommandItem value="issues" onSelect={() => go("/issues")}>
              <CircleDot className="mr-2 h-4 w-4" />
              Issues
            </CommandItem>
            <CommandItem value="projects" onSelect={() => go("/projects")}>
              <Hexagon className="mr-2 h-4 w-4" />
              Projects
            </CommandItem>
            <CommandItem value="goals targets" onSelect={() => go("/goals")}>
              <Target className="mr-2 h-4 w-4" />
              Goals
            </CommandItem>
            <CommandItem value="heartbeats activity runs" onSelect={() => go("/heartbeats")}>
              <Clock3 className="mr-2 h-4 w-4" />
              Heartbeats
            </CommandItem>
            <CommandItem value="agents" onSelect={() => go("/agents")}>
              <Bot className="mr-2 h-4 w-4" />
              Agents
            </CommandItem>
            <CommandItem value="costs billing spend" onSelect={() => go("/costs")}>
              <DollarSign className="mr-2 h-4 w-4" />
              Costs
            </CommandItem>
            <CommandItem value="activity history" onSelect={() => go("/activity")}>
              <History className="mr-2 h-4 w-4" />
              Activity
            </CommandItem>
          </CommandGroup>
        )}

        {scope === "library" && searchQuery.length === 0 && (
          <CommandGroup heading="Library">
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              Type to search Library
            </div>
          </CommandGroup>
        )}

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Issues">
              {visibleIssues.slice(0, 10).map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={
                    searchQuery.length > 0
                      ? `${searchQuery} ${issue.identifier ?? ""} ${issue.title}`
                      : `${issue.identifier ?? ""} ${issue.title}`
                  }
                  onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
                >
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground mr-2 font-mono text-xs">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  {issue.assigneeAgentId && (() => {
                    const agent = agentById.get(issue.assigneeAgentId);
                    return agent ? <AgentIdentity name={agent.name} icon={agent.icon} role={agent.role} size="sm" className="ml-2 hidden sm:inline-flex" /> : null;
                  })()}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searchQuery.length > 0 && visibleChats.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              {visibleChats.slice(0, 10).map((chat) => {
                const preview = chat.searchPreview ?? chat.latestReplyPreview ?? chat.summary;
                return (
                  <CommandItem
                    key={chat.id}
                    value={`${searchQuery} ${chat.title} ${preview ?? ""}`}
                    onSelect={() => go(`/messenger/chat/${chat.id}`)}
                  >
                    <MessagesSquare className="mr-2 h-4 w-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{chat.title}</span>
                      {preview && (
                        <span className="truncate text-xs text-muted-foreground">{preview}</span>
                      )}
                    </span>
                    <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
                      {chat.status}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {libraryEntries.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Library">
              {libraryEntries.slice(0, 10).map((entry) => {
                const Icon = entry.isDirectory ? Folder : FileText;
                return (
                  <CommandItem
                    key={`${entry.isDirectory ? "directory" : "file"}:${entry.path}`}
                    value={`${searchQuery} ${entry.displayLabel ?? entry.name} ${entry.path}`}
                    onSelect={() => go(getLibraryEntryHref(entry))}
                  >
                    <Icon className="mr-2 h-4 w-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{entry.displayLabel ?? entry.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{entry.path}</span>
                    </span>
                    <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
                      {entry.isDirectory ? "Folder" : "File"}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {visibleAgents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {visibleAgents.slice(0, 10).map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={`${agent.name} ${agent.role} ${agent.title ?? ""} ${agent.urlKey}`}
                  onSelect={() => go(agentUrl(agent))}
                >
                  <Bot className="mr-2 h-4 w-4" />
                  {agent.name}
                  <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {visibleProjects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {visibleProjects.slice(0, 10).map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.description ?? ""} ${project.urlKey} ${project.status}`}
                  onSelect={() => go(projectUrl(project))}
                >
                  <ProjectIcon color={project.color} icon={project.icon} size="sm" className="mr-2" />
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
