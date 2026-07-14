import { PageTabBar } from "@/components/PageTabBar";
import { OrganizationIntelligenceProfilesSettings } from "@/components/settings/OrganizationIntelligenceProfilesSettings";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsActions,
  SettingsField,
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import type { TranslationKey } from "@/i18n/locales/en";
import { isFeishuBackedConversation } from "@/lib/chat-source";
import { formatDisplayPath } from "@/lib/display-path";
import { normalizeIssueLabelName, pickIssueLabelColor } from "@/lib/issue-labels";
import { invalidateMessengerThreadSummaryQueries } from "@/lib/messenger-query-cache";
import { applyOrganizationPrefix, DEFAULT_ORGANIZATION_HOME_PATH, getOrganizationRouteKey } from "@/lib/organization-routes";
import { buildOrganizationGeneralPatch } from "@/lib/organization-settings-patch";
import { getOrganizationSettingsPath } from "@/lib/organization-settings-path";
import { Link, useLocation, useNavigate } from "@/lib/router";
import {
  clearStoredSettingsOverlayBackgroundPath,
  preserveSettingsOverlayState,
  readSettingsOverlayBackgroundPath,
  readStoredSettingsOverlayBackgroundPath,
} from "@/lib/settings-overlay-state";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Check, Download, Plus, Settings, Trash2, Upload } from "lucide-react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { chatsApi } from "../api/chats";
import { issuesApi } from "../api/issues";
import { organizationsApi } from "../api/orgs";
import { OrganizationPatternIcon } from "../components/OrganizationPatternIcon";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useI18n } from "../context/I18nContext";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

type OrganizationSettingsView = "general" | "workspace" | "intelligence" | "chat" | "access";

export function OrganizationSettings() {
  const { t } = useI18n();
  const { confirm } = useDialog();
  const {
    organizations,
    loading: organizationsLoading,
    selectedOrganization: currentOrganization,
    selectedOrganizationId: currentOrganizationId,
    setSelectedOrganizationId,
  } = useOrganization();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const overlayState = preserveSettingsOverlayState(location.state);
  const overlayBackgroundPath = readSettingsOverlayBackgroundPath(location.state)
    ?? readStoredSettingsOverlayBackgroundPath()
    ?? DEFAULT_ORGANIZATION_HOME_PATH;
  // General settings local state
  const [organizationName, setOrganizationName] = useState("");
  const [issuePrefix, setIssuePrefix] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const logoFileInputRef = useRef<HTMLInputElement | null>(null);
  const [logoFileName, setLogoFileName] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [defaultChatIssueCreationMode, setDefaultChatIssueCreationMode] = useState<"manual_approval" | "auto_create">("manual_approval");
  const [archivedChatSearch, setArchivedChatSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, { name: string; color: string }>>({});
  const [activeView, setActiveView] = useState<OrganizationSettingsView>("general");

  // Sync local state from the organization currently being viewed in settings.
  useEffect(() => {
    if (!viewedOrganization) return;
    setOrganizationName(viewedOrganization.name);
    setIssuePrefix(viewedOrganization.issuePrefix);
    setDescription(viewedOrganization.description ?? "");
    setBrandColor(viewedOrganization.brandColor ?? "");
    setLogoUrl(viewedOrganization.logoUrl ?? "");
    setDefaultChatIssueCreationMode(viewedOrganization.defaultChatIssueCreationMode ?? "manual_approval");
  }, [viewedOrganization]);

  useEffect(() => {
    if (!newLabelName.trim()) return;
    setNewLabelColor(pickIssueLabelColor(newLabelName));
  }, [newLabelName]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);
  const isViewingSelectedOrganization =
    !!viewedOrganizationId && viewedOrganizationId === currentOrganizationId;
  const archivedChatsScrollRef = useScrollbarActivityRef("organization-settings:archived-chats");

  const generalDirty =
    !!viewedOrganization &&
    (organizationName !== viewedOrganization.name ||
      issuePrefix !== viewedOrganization.issuePrefix ||
      description !== (viewedOrganization.description ?? "") ||
      brandColor !== (viewedOrganization.brandColor ?? ""));

  const chatSettingsDirty =
    !!viewedOrganization &&
    defaultChatIssueCreationMode !== (viewedOrganization.defaultChatIssueCreationMode ?? "manual_approval");

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      issuePrefix?: string;
      description: string | null;
      brandColor: string | null;
    }) => organizationsApi.update(viewedOrganizationId!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      organizationsApi.update(viewedOrganizationId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
    },
  });

  const chatSettingsMutation = useMutation({
    mutationFn: (data: {
      defaultChatIssueCreationMode: "manual_approval" | "auto_create";
    }) =>
      organizationsApi.update(viewedOrganizationId!, {
        defaultChatIssueCreationMode: data.defaultChatIssueCreationMode,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "active") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "archived") });
    },
  });

  const restoreArchivedChatMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.update(chatId, { status: "active" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "active") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "archived") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "all") });
      await invalidateMessengerThreadSummaryQueries(queryClient, viewedOrganizationId!);
    },
  });

  const deleteArchivedChatMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.remove(chatId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "active") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "archived") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "all") });
      await invalidateMessengerThreadSummaryQueries(queryClient, viewedOrganizationId!);
    },
  });

  const archivedChatsQuery = useQuery({
    queryKey: queryKeys.chats.list(viewedOrganizationId ?? "__none__", "archived"),
    queryFn: () => chatsApi.list(viewedOrganizationId!, "archived"),
    enabled: !!viewedOrganizationId,
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  const archivedChats = archivedChatsQuery.data ?? [];
  const filteredArchivedChats = useMemo(() => {
    const query = archivedChatSearch.trim().toLowerCase();
    if (!query) return archivedChats;
    return archivedChats.filter((conversation) => {
      const runtime = [
        conversation.chatRuntime.sourceLabel,
        conversation.chatRuntime.model,
      ].filter(Boolean).join(" ");
      return `${conversation.title} ${runtime}`.toLowerCase().includes(query);
    });
  }, [archivedChatSearch, archivedChats]);

  const labelsQuery = useQuery({
    queryKey: queryKeys.issues.labels(viewedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.listLabels(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  useEffect(() => {
    const nextDrafts = Object.fromEntries(
      (labelsQuery.data ?? []).map((label) => [label.id, { name: label.name, color: label.color }]),
    );
    setLabelDrafts(nextDrafts);
  }, [labelsQuery.data]);

  const invalidateLabelSurfaces = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(viewedOrganizationId!) });
    await queryClient.invalidateQueries({ queryKey: ["issues"] });
  };

  const createLabelMutation = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(viewedOrganizationId!, data),
    onSuccess: async () => {
      await invalidateLabelSurfaces();
      setNewLabelName("");
      setNewLabelColor("#6366f1");
    },
  });

  const updateLabelMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; color?: string } }) => issuesApi.updateLabel(id, data),
    onSuccess: async () => {
      await invalidateLabelSurfaces();
    },
  });

  const deleteLabelMutation = useMutation({
    mutationFn: (labelId: string) => issuesApi.deleteLabel(labelId),
    onSuccess: async () => {
      await invalidateLabelSurfaces();
    },
  });

  const workspaceRootQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, ""),
    enabled: !!viewedOrganizationId,
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(viewedOrganizationId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        }, t);
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        }, t);
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(viewedOrganizationId!),
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : t("organizationSettings.invites.failed"),
      );
    },
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadOrganizationLogo(viewedOrganizationId!, file)
        .then((asset) => organizationsApi.update(viewedOrganizationId!, { logoAssetId: asset.assetId })),
    onSuccess: (organization) => {
      syncLogoState(organization.logoUrl);
      setLogoFileName("");
      setLogoUploadError(null);
    },
    onError: () => {
      setLogoFileName("");
    },
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => organizationsApi.update(viewedOrganizationId!, { logoAssetId: null }),
    onSuccess: (organization) => {
      setLogoUploadError(null);
      syncLogoState(organization.logoUrl);
    },
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoFileName(file.name);
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [viewedOrganizationId]);

  const archiveMutation = useMutation({
    mutationFn: ({
      orgId,
      nextSelectedOrganizationId,
      nextViewedOrganizationPath,
    }: {
      orgId: string;
      nextSelectedOrganizationId: string | null;
      nextViewedOrganizationPath: string | null;
    }) => organizationsApi.archive(orgId).then(() => ({ nextSelectedOrganizationId, nextViewedOrganizationPath })),
    onSuccess: async ({ nextSelectedOrganizationId, nextViewedOrganizationPath }) => {
      if (nextSelectedOrganizationId) {
        setSelectedOrganizationId(nextSelectedOrganizationId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.all,
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.stats,
      });

      if (nextViewedOrganizationPath) {
        navigate(
          nextViewedOrganizationPath,
          overlayState ? { replace: true, state: overlayState } : { replace: true },
        );
        return;
      }

      clearStoredSettingsOverlayBackgroundPath();
      navigate(overlayBackgroundPath, { replace: true });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: viewedOrganization?.name ?? "Organization", href: DEFAULT_ORGANIZATION_HOME_PATH },
      { label: t("organizationSettings.breadcrumb") },
    ]);
  }, [setBreadcrumbs, t, viewedOrganization?.name]);

  if (!viewedOrganization && organizationsLoading) {
    return <SettingsPageSkeleton />;
  }

  if (!viewedOrganization) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("notFound.title.organization")}
      </div>
    );
  }

  function handleSaveGeneral() {
    if (!viewedOrganization) return;
    generalMutation.mutate(buildOrganizationGeneralPatch({
      name: organizationName.trim(),
      issuePrefix,
      persistedIssuePrefix: viewedOrganization.issuePrefix,
      description,
      brandColor,
    }));
  }

  function updateLabelDraft(id: string, patch: Partial<{ name: string; color: string }>) {
    setLabelDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { name: "", color: "#6366f1" }),
        ...patch,
      },
    }));
  }

  function handleSaveChatSettings() {
    chatSettingsMutation.mutate({
      defaultChatIssueCreationMode,
    });
  }

  async function handleDeleteArchivedChat(chatId: string, title: string) {
    const confirmed = await confirm({
      title: t("organizationSettings.chat.archived.deleteConfirmTitle"),
      description: t("organizationSettings.chat.archived.deleteConfirmDescription", { title }),
      confirmLabel: t("organizationSettings.chat.archived.delete"),
      tone: "destructive",
    });
    if (!confirmed) return;
    deleteArchivedChatMutation.mutate(chatId);
  }

  async function handleArchiveOrganization() {
    if (!viewedOrganization || !viewedOrganizationId) return;

    const confirmed = await confirm({
      title: "Archive organization?",
      description: t("organizationSettings.danger.confirm", { name: viewedOrganization.name }),
      confirmLabel: "Archive",
      tone: "destructive",
    });
    if (!confirmed) return;

    const nextAvailableOrganization = organizations.find(
      (organization) =>
        organization.id !== viewedOrganizationId &&
        organization.status !== "archived",
    ) ?? null;
    const nextSelectedOrganizationId = isViewingSelectedOrganization
      ? nextAvailableOrganization?.id ?? null
      : null;
    const nextViewedOrganization = isViewingSelectedOrganization
      ? nextAvailableOrganization
      : currentOrganization && currentOrganization.id !== viewedOrganizationId && currentOrganization.status !== "archived"
        ? currentOrganization
        : nextAvailableOrganization;
    const nextViewedOrganizationPath = nextViewedOrganization
      ? getOrganizationSettingsPath(getOrganizationRouteKey(nextViewedOrganization))
      : null;

    archiveMutation.mutate({
      orgId: viewedOrganizationId,
      nextSelectedOrganizationId,
      nextViewedOrganizationPath,
    });
  }

  const organizationRouteKey = getOrganizationRouteKey(viewedOrganization);
  const organizationLibraryPath = applyOrganizationPrefix("/library", organizationRouteKey);
  const organizationWorkspaceBackupsPath = applyOrganizationPrefix(
    "/workspaces/backups",
    organizationRouteKey,
  );
  const workspaceRootDisplayPath = workspaceRootQuery.data?.rootPath
    ? formatDisplayPath(workspaceRootQuery.data.rootPath)
    : t("organizationSettings.workspace.rootPath.loading");
  const settingsViews = [
    { value: "general", label: t("organizationSettings.section.general") },
    { value: "workspace", label: t("organizationSettings.section.workspace") },
    { value: "intelligence", label: t("organizationSettings.view.intelligence") },
    { value: "chat", label: t("organizationSettings.section.chat") },
    { value: "access", label: t("organizationSettings.view.accessData") },
  ];

  return (
    <SettingsPage width="wide" className="gap-6" data-testid="organization-settings-page">
      <SettingsPageHeader
        eyebrow={viewedOrganization.name}
        icon={Settings}
        title={t("organizationSettings.title")}
      />

      <Tabs
        value={activeView}
        onValueChange={(value) => setActiveView(value as OrganizationSettingsView)}
        className="flex min-w-0 flex-col gap-6"
      >
        <div className="scrollbar-auto-hide min-w-0 overflow-x-auto pb-1">
          <PageTabBar
            ariaLabel={t("organizationSettings.view.label")}
            align="start"
            mobileMode="scrollable-tabs"
            items={settingsViews}
            value={activeView}
            onValueChange={(value) => setActiveView(value as OrganizationSettingsView)}
          />
        </div>

        <TabsContent value="general" className="flex min-w-0 flex-col gap-6">
          <SettingsSection title={t("organizationSettings.section.general")}>
            <SettingsGroup>
              <SettingsField
                htmlFor="organization-settings-name"
                label={t("organizationSettings.general.name.label")}
                description={t("organizationSettings.general.name.hint")}
              >
                <Input
                  id="organization-settings-name"
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                />
              </SettingsField>
              <SettingsField
                htmlFor="organization-settings-issue-key"
                label={t("organizationSettings.general.issueKey.label")}
                description={t("organizationSettings.general.issueKey.hint")}
              >
                <Input
                  id="organization-settings-issue-key"
                  className="font-mono uppercase"
                  value={issuePrefix}
                  onChange={(event) => setIssuePrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
                />
              </SettingsField>
              <SettingsField
                htmlFor="organization-settings-description"
                label={t("organizationSettings.general.description.label")}
                description={t("organizationSettings.general.description.hint")}
              >
                <Input
                  id="organization-settings-description"
                  value={description}
                  placeholder={t("organizationSettings.general.description.placeholder")}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </SettingsField>
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title={t("organizationSettings.section.appearance")}>
            <SettingsGroup>
              <SettingsField
                label={t("organizationSettings.appearance.logo.label")}
                description={t("organizationSettings.appearance.logo.hint")}
              >
                <div className="grid min-w-0 gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
                  <OrganizationPatternIcon
                    organizationName={organizationName || viewedOrganization.name}
                    logoUrl={logoUrl || null}
                    brandColor={brandColor || null}
                    className="size-14 rounded-lg"
                  />
                  <div className="flex min-w-0 flex-col gap-2">
                    <input
                      ref={logoFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      onChange={handleLogoFileChange}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="hidden"
                    />
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => logoFileInputRef.current?.click()}
                      >
                        {t("organizationSettings.appearance.logo.chooseFile")}
                      </Button>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {logoFileName || t("organizationSettings.appearance.logo.noFileChosen")}
                      </span>
                      {logoUrl ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={handleClearLogo}
                          disabled={clearLogoMutation.isPending}
                        >
                          {clearLogoMutation.isPending
                            ? t("organizationSettings.appearance.logo.removing")
                            : t("organizationSettings.appearance.logo.remove")}
                        </Button>
                      ) : null}
                    </div>
                    {logoUploadMutation.isPending ? (
                      <span className="text-xs text-muted-foreground">
                        {t("organizationSettings.appearance.logo.uploading")}
                      </span>
                    ) : null}
                    {logoUploadMutation.isError || logoUploadError ? (
                      <span className="text-xs text-destructive">
                        {logoUploadError ??
                          (logoUploadMutation.error instanceof Error
                            ? logoUploadMutation.error.message
                            : t("organizationSettings.appearance.logo.uploadFailed"))}
                      </span>
                    ) : null}
                    {clearLogoMutation.isError ? (
                      <span className="text-xs text-destructive">{clearLogoMutation.error.message}</span>
                    ) : null}
                  </div>
                </div>
              </SettingsField>

              <SettingsField
                htmlFor="organization-settings-brand-color"
                label={t("organizationSettings.appearance.brandColor.label")}
                description={t("organizationSettings.appearance.brandColor.hint")}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(event) => setBrandColor(event.target.value)}
                    className="size-8 cursor-pointer rounded-[var(--control-radius)] border border-border bg-transparent p-0"
                    aria-label={t("organizationSettings.appearance.brandColor.label")}
                  />
                  <Input
                    id="organization-settings-brand-color"
                    value={brandColor}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "" || /^#[0-9a-fA-F]{0,6}$/.test(value)) {
                        setBrandColor(value);
                      }
                    }}
                    placeholder={t("organizationSettings.appearance.brandColor.auto")}
                    className="w-32 font-mono"
                  />
                  {brandColor ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setBrandColor("")}>
                      {t("organizationSettings.appearance.brandColor.clear")}
                    </Button>
                  ) : null}
                </div>
              </SettingsField>

              {generalDirty ? (
                <SettingsActions>
                  {generalMutation.isSuccess ? (
                    <span className="text-xs text-muted-foreground">{t("organizationSettings.save.saved")}</span>
                  ) : null}
                  {generalMutation.isError ? (
                    <span className="text-xs text-destructive">
                      {generalMutation.error instanceof Error
                        ? generalMutation.error.message
                        : t("organizationSettings.save.failed")}
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={handleSaveGeneral}
                    disabled={generalMutation.isPending || !organizationName.trim() || !issuePrefix.trim()}
                  >
                    {generalMutation.isPending
                      ? t("organizationSettings.save.saving")
                      : t("organizationSettings.save.button")}
                  </Button>
                </SettingsActions>
              ) : null}
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title={t("organizationSettings.section.dangerZone")}>
            <SettingsGroup className="border-destructive/35 bg-destructive/5">
              <SettingsItem
                title={t("organizationSettings.danger.archive")}
                description={t("organizationSettings.danger.description")}
                action={(
                  <div className="flex flex-wrap items-center gap-2">
                    {archiveMutation.isError ? (
                      <span className="text-xs text-destructive">
                        {archiveMutation.error instanceof Error
                          ? archiveMutation.error.message
                          : t("organizationSettings.danger.failed")}
                      </span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={archiveMutation.isPending || viewedOrganization.status === "archived"}
                      onClick={handleArchiveOrganization}
                    >
                      {archiveMutation.isPending
                        ? t("organizationSettings.danger.archiving")
                        : viewedOrganization.status === "archived"
                          ? t("organizationSettings.danger.alreadyArchived")
                          : t("organizationSettings.danger.archive")}
                    </Button>
                  </div>
                )}
              />
            </SettingsGroup>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="workspace" className="flex min-w-0 flex-col gap-6">
          <SettingsSection title={t("organizationSettings.section.workspace")}>
            <SettingsGroup>
              <SettingsItem
                headingLevel={2}
                title={t("organizationSettings.workspace.shared.title")}
                description={(
                  <div className="flex min-w-0 flex-col gap-2">
                    <span>{t("organizationSettings.workspace.shared.description")}</span>
                    <code
                      className="block max-w-full overflow-x-auto whitespace-nowrap rounded-[var(--control-radius)] border border-border bg-background/55 px-2.5 py-2 text-xs"
                      title={workspaceRootQuery.data?.rootPath ? workspaceRootDisplayPath : undefined}
                    >
                      {workspaceRootDisplayPath}
                    </code>
                  </div>
                )}
                action={(
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link to={organizationLibraryPath}>{t("organizationSettings.workspace.open")}</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link to={organizationWorkspaceBackupsPath}>{t("organizationSettings.workspace.backups")}</Link>
                    </Button>
                  </div>
                )}
              />
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection
            title={t("organizationSettings.section.labels")}
            description={t("organizationSettings.labels.intro.description")}
          >
            <SettingsGroup>
              <div data-slot="settings-item" className="grid min-w-0 gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor="organization-settings-new-label" className="text-[14px] font-medium text-foreground">
                    {t("organizationSettings.labels.intro.title")}
                  </label>
                  <Input
                    id="organization-settings-new-label"
                    value={newLabelName}
                    placeholder={t("organizationSettings.labels.new.placeholder")}
                    onChange={(event) => setNewLabelName(event.target.value)}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <input
                    type="color"
                    value={newLabelColor}
                    onChange={(event) => setNewLabelColor(event.target.value)}
                    className="color-input-circle size-8 shrink-0 border border-border bg-transparent"
                    aria-label={t("organizationSettings.labels.new.colorAria")}
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      createLabelMutation.mutate({
                        name: normalizeIssueLabelName(newLabelName),
                        color: newLabelColor,
                      })
                    }
                    disabled={!normalizeIssueLabelName(newLabelName) || createLabelMutation.isPending}
                  >
                    <Plus data-icon="inline-start" />
                    {createLabelMutation.isPending
                      ? t("organizationSettings.labels.adding")
                      : t("organizationSettings.labels.add")}
                  </Button>
                </div>
              </div>

              {labelsQuery.isLoading ? (
                <div data-slot="settings-item" className="px-4 py-4 text-sm text-muted-foreground">
                  {t("organizationSettings.labels.loading")}
                </div>
              ) : (labelsQuery.data ?? []).length === 0 ? (
                <div data-slot="settings-item" className="px-4 py-4 text-sm text-muted-foreground">
                  {t("organizationSettings.labels.empty")}
                </div>
              ) : (
                (labelsQuery.data ?? []).map((label) => {
                  const draft = labelDrafts[label.id] ?? { name: label.name, color: label.color };
                  const normalizedDraftName = normalizeIssueLabelName(draft.name);
                  const dirty = normalizedDraftName !== label.name || draft.color !== label.color;
                  const saving = updateLabelMutation.isPending && updateLabelMutation.variables?.id === label.id;
                  const showSaveButton = dirty || saving;
                  const deleting = deleteLabelMutation.isPending && deleteLabelMutation.variables === label.id;

                  return (
                    <div
                      key={label.id}
                      data-slot="settings-item"
                      className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: draft.color }} />
                        <Input
                          className="min-w-0"
                          value={draft.name}
                          onChange={(event) => updateLabelDraft(label.id, { name: event.target.value })}
                          aria-label={`Label name for ${label.name}`}
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <input
                          type="color"
                          value={draft.color}
                          onChange={(event) => updateLabelDraft(label.id, { color: event.target.value })}
                          className="color-input-circle size-8 shrink-0 border border-border bg-transparent"
                          aria-label={`Label color for ${label.name}`}
                        />
                        {showSaveButton ? (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Save label ${normalizedDraftName || label.name}`}
                            disabled={!normalizedDraftName || saving}
                            onClick={() =>
                              updateLabelMutation.mutate({
                                id: label.id,
                                data: { name: normalizedDraftName, color: draft.color },
                              })
                            }
                          >
                            {saving
                              ? t("organizationSettings.labels.saving")
                              : t("organizationSettings.labels.save")}
                          </Button>
                        ) : (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete label ${label.name}`}
                            className="text-muted-foreground hover:text-destructive"
                            disabled={deleting}
                            onClick={() => deleteLabelMutation.mutate(label.id)}
                          >
                            <Trash2 />
                            <span className="sr-only">
                              {t("organizationSettings.labels.delete", { name: label.name })}
                            </span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}

              {createLabelMutation.isError || updateLabelMutation.isError || deleteLabelMutation.isError ? (
                <div data-slot="settings-item" role="alert" className="flex flex-col gap-1 px-4 py-3 text-xs text-destructive">
                  {createLabelMutation.isError ? (
                    <span>
                      {createLabelMutation.error instanceof Error
                        ? createLabelMutation.error.message
                        : t("organizationSettings.labels.failedCreate")}
                    </span>
                  ) : null}
                  {updateLabelMutation.isError ? (
                    <span>
                      {updateLabelMutation.error instanceof Error
                        ? updateLabelMutation.error.message
                        : t("organizationSettings.labels.failedUpdate")}
                    </span>
                  ) : null}
                  {deleteLabelMutation.isError ? (
                    <span>
                      {deleteLabelMutation.error instanceof Error
                        ? deleteLabelMutation.error.message
                        : t("organizationSettings.labels.failedDelete")}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title={t("organizationSettings.section.hiring")}>
            <SettingsGroup>
              <SettingsItem
                title={t("organizationSettings.hiring.requireApproval.label")}
                description={t("organizationSettings.hiring.requireApproval.hint")}
                action={(
                  <SettingsToggle
                    checked={!!viewedOrganization.requireBoardApprovalForNewAgents}
                    disabled={settingsMutation.isPending}
                    aria-label={t("organizationSettings.hiring.requireApproval.label")}
                    onClick={() => settingsMutation.mutate(!viewedOrganization.requireBoardApprovalForNewAgents)}
                  />
                )}
              />
            </SettingsGroup>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="intelligence" className="flex min-w-0 flex-col gap-6">
          <SettingsSection
            title="Intelligence"
            description="Organization-level AI profiles for product features that are not agent work."
          >
            {viewedOrganizationId ? (
              <OrganizationIntelligenceProfilesSettings orgId={viewedOrganizationId} />
            ) : null}
          </SettingsSection>
        </TabsContent>

        <TabsContent value="chat" className="flex min-w-0 flex-col gap-6">
          <SettingsSection title={t("organizationSettings.section.chat")}>
            <SettingsGroup>
              <SettingsField
                label={t("organizationSettings.chat.issueMode.label")}
                description={t("organizationSettings.chat.issueMode.hint")}
              >
                <Select
                  value={defaultChatIssueCreationMode}
                  onValueChange={(value) => {
                    if (value === "manual_approval" || value === "auto_create") {
                      setDefaultChatIssueCreationMode(value);
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-64" aria-label={t("organizationSettings.chat.issueMode.label")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectGroup>
                      <SelectItem value="manual_approval">
                        {t("organizationSettings.chat.issueMode.manual")}
                      </SelectItem>
                      <SelectItem value="auto_create">
                        {t("organizationSettings.chat.issueMode.auto")}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingsField>
              <SettingsActions>
                {chatSettingsMutation.isSuccess && !chatSettingsMutation.isPending ? (
                  <span className="text-xs text-muted-foreground">{t("organizationSettings.save.saved")}</span>
                ) : null}
                {chatSettingsMutation.isError ? (
                  <span className="text-xs text-destructive">
                    {chatSettingsMutation.error instanceof Error
                      ? chatSettingsMutation.error.message
                      : t("organizationSettings.chat.failed")}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  onClick={handleSaveChatSettings}
                  disabled={!chatSettingsDirty || chatSettingsMutation.isPending}
                >
                  {chatSettingsMutation.isPending
                    ? t("organizationSettings.save.saving")
                    : t("organizationSettings.chat.save")}
                </Button>
              </SettingsActions>
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection
            title={t("organizationSettings.chat.archived.title")}
            description={t("organizationSettings.chat.archived.description")}
          >
            <SettingsGroup>
              <div data-slot="settings-item" className="flex min-w-0 flex-col gap-3 px-4 py-4">
                <div className="text-xs text-muted-foreground">
                  {t("organizationSettings.chat.archived.count", {
                    visible: filteredArchivedChats.length,
                    total: archivedChats.length,
                  })}
                </div>
                {archivedChatsQuery.isLoading ? (
                  <div className="text-sm text-muted-foreground">
                    {t("organizationSettings.chat.archived.loading")}
                  </div>
                ) : archivedChats.length === 0 ? (
                  <div className="rounded-[var(--control-radius)] border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    {t("organizationSettings.chat.archived.empty")}
                  </div>
                ) : (
                  <>
                    <Input
                      type="search"
                      value={archivedChatSearch}
                      placeholder={t("organizationSettings.chat.archived.searchPlaceholder")}
                      onChange={(event) => setArchivedChatSearch(event.target.value)}
                    />
                    {filteredArchivedChats.length === 0 ? (
                      <div className="rounded-[var(--control-radius)] border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                        {t("organizationSettings.chat.archived.noResults")}
                      </div>
                    ) : (
                      <div
                        ref={archivedChatsScrollRef}
                        data-testid="archived-chats-scroll-region"
                        className="scrollbar-auto-hide flex max-h-[min(360px,calc(100dvh-22rem))] flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1"
                      >
                        {filteredArchivedChats.map((conversation) => {
                          const restoring = restoreArchivedChatMutation.isPending
                            && restoreArchivedChatMutation.variables === conversation.id;
                          const deleting = deleteArchivedChatMutation.isPending
                            && deleteArchivedChatMutation.variables === conversation.id;

                          return (
                            <div
                              key={conversation.id}
                              data-testid={`archived-chat-row-${conversation.id}`}
                              className="flex min-w-0 flex-col gap-3 rounded-[var(--control-radius)] border border-border bg-background/55 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">{conversation.title}</div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {conversation.chatRuntime.sourceLabel}
                                  {conversation.chatRuntime.model ? ` · ${conversation.chatRuntime.model}` : ""}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={restoring || deleting}
                                  onClick={() => restoreArchivedChatMutation.mutate(conversation.id)}
                                >
                                  <ArchiveRestore data-icon="inline-start" />
                                  {t("organizationSettings.chat.archived.restore")}
                                </Button>
                                {!isFeishuBackedConversation(conversation) ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-muted-foreground hover:text-destructive"
                                    disabled={restoring || deleting}
                                    aria-label={t("organizationSettings.chat.archived.deleteAria", { title: conversation.title })}
                                    onClick={() => void handleDeleteArchivedChat(conversation.id, conversation.title)}
                                  >
                                    <Trash2 data-icon="inline-start" />
                                    {t("organizationSettings.chat.archived.delete")}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
                {deleteArchivedChatMutation.isError ? (
                  <div className="text-xs text-destructive">
                    {deleteArchivedChatMutation.error instanceof Error
                      ? deleteArchivedChatMutation.error.message
                      : t("organizationSettings.chat.archived.deleteFailed")}
                  </div>
                ) : null}
                {restoreArchivedChatMutation.isError ? (
                  <div className="text-xs text-destructive">
                    {restoreArchivedChatMutation.error instanceof Error
                      ? restoreArchivedChatMutation.error.message
                      : t("organizationSettings.chat.archived.restoreFailed")}
                  </div>
                ) : null}
              </div>
            </SettingsGroup>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="access" className="flex min-w-0 flex-col gap-6">
          <SettingsSection
            title={t("organizationSettings.section.invites")}
            description={t("organizationSettings.invites.description")}
          >
            <SettingsGroup>
              <SettingsItem
                title={t("organizationSettings.invites.generate")}
                description={t("organizationSettings.invites.hint")}
                action={(
                  <Button
                    size="sm"
                    onClick={() => inviteMutation.mutate()}
                    disabled={inviteMutation.isPending}
                  >
                    {inviteMutation.isPending
                      ? t("organizationSettings.invites.generating")
                      : t("organizationSettings.invites.generate")}
                  </Button>
                )}
              />
              {inviteError ? (
                <div data-slot="settings-item" role="alert" className="px-4 py-3 text-sm text-destructive">
                  {inviteError}
                </div>
              ) : null}
              {inviteSnippet ? (
                <SettingsField
                  htmlFor="organization-openclaw-invite-prompt"
                  label={t("organizationSettings.invites.promptTitle")}
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <Textarea
                      id="organization-openclaw-invite-prompt"
                      className="min-h-44 max-h-[min(22rem,45dvh)] resize-y font-mono text-xs leading-5"
                      value={inviteSnippet}
                      readOnly
                    />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {snippetCopied ? (
                        <span key={snippetCopyDelightId} className="flex items-center gap-1 text-xs text-[color:var(--accent-strong)]">
                          <Check className="size-3" />
                          {t("organizationSettings.invites.copied")}
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(inviteSnippet);
                            setSnippetCopied(true);
                            setSnippetCopyDelightId((previous) => previous + 1);
                            setTimeout(() => setSnippetCopied(false), 2000);
                          } catch {
                            // Clipboard access may be unavailable in restricted environments.
                          }
                        }}
                      >
                        {snippetCopied
                          ? t("organizationSettings.invites.copiedSnippet")
                          : t("organizationSettings.invites.copy")}
                      </Button>
                    </div>
                  </div>
                </SettingsField>
              ) : null}
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title={t("organizationSettings.section.packages")}>
            <SettingsGroup>
              <SettingsItem
                title={t("organizationSettings.section.packages")}
                description={(
                  <span>
                    {t("organizationSettings.packages.description.before")}{" "}
                    <Link
                      to={applyOrganizationPrefix("/org", organizationRouteKey)}
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      {t("organizationSettings.packages.structureLink")}
                    </Link>{" "}
                    {t("organizationSettings.packages.description.after")}
                  </span>
                )}
                action={(
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link to={applyOrganizationPrefix("/organization/export", organizationRouteKey)}>
                        <Download data-icon="inline-start" />
                        {t("organizationSettings.packages.export")}
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link to={applyOrganizationPrefix("/organization/import", organizationRouteKey)}>
                        <Upload data-icon="inline-start" />
                        {t("organizationSettings.packages.import")}
                      </Link>
                    </Button>
                  </div>
                )}
              />
            </SettingsGroup>
          </SettingsSection>
        </TabsContent>
      </Tabs>
    </SettingsPage>
  );
}

function buildAgentSnippet(
  input: AgentSnippetInput,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : t("organizationSettings.invites.prompt.noCandidates");

  const connectivityBlock =
    candidateUrls.length === 0
      ? t("organizationSettings.invites.prompt.connectivityNoCandidates")
      : t("organizationSettings.invites.prompt.connectivityHasCandidates");

  const resolutionLine = resolutionTestUrl
    ? t("organizationSettings.invites.prompt.resolutionLine", {
        url: resolutionTestUrl,
      })
    : "";

  return t("organizationSettings.invites.prompt.body", {
    candidateList,
    connectivityBlock,
    resolutionLine,
  });
}

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
