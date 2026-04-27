import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeModelFallbacks } from "@rudderhq/agent-runtime-utils";
import type { ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import type { AgentRuntimeType, OrganizationSecret } from "@rudderhq/shared";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { organizationsApi } from "../api/orgs";
import { accessApi } from "../api/access";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import { chatsApi } from "../api/chats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { Settings, Check, Download, Upload, ArchiveRestore, MessageSquareMore, Plus, Trash2, Tags } from "lucide-react";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { OrganizationPatternIcon } from "../components/OrganizationPatternIcon";
import { getOrganizationSettingsPath } from "@/lib/organization-settings-path";
import { applyOrganizationPrefix } from "@/lib/organization-routes";
import { normalizeIssueLabelName, pickIssueLabelColor } from "@/lib/issue-labels";
import { cn } from "../lib/utils";
import {
  Field,
  ToggleField,
  HintIcon,
  adapterLabels,
} from "../components/agent-config-primitives";
import {
  RuntimeProviderCard,
  defaultConfigForRuntime,
  defaultFallbackItem,
  primaryModelFallbackKey,
  runtimeProviderItemClassName,
  runtimeProviderRailClassName,
} from "../components/AgentConfigForm";
import {
  clearStoredSettingsOverlayBackgroundPath,
  preserveSettingsOverlayState,
  readSettingsOverlayBackgroundPath,
  readStoredSettingsOverlayBackgroundPath,
} from "@/lib/settings-overlay-state";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { useI18n } from "../context/I18nContext";
import type { TranslationKey } from "@/i18n/locales/en";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

const CHAT_DEFAULT_ADAPTER_OPTIONS: AgentRuntimeType[] = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
];

function asConfigRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function OrganizationSettings() {
  const { t } = useI18n();
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
    ?? "/dashboard";
  // General settings local state
  const [organizationName, setOrganizationName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [defaultChatIssueCreationMode, setDefaultChatIssueCreationMode] = useState<"manual_approval" | "auto_create">("manual_approval");
  const [defaultChatAgentRuntimeType, setDefaultChatAdapterType] = useState<AgentRuntimeType | "">("");
  const [defaultChatModel, setDefaultChatModel] = useState("");
  const [defaultChatRuntimeConfig, setDefaultChatRuntimeConfig] = useState<Record<string, unknown>>({});
  const [defaultChatFallbackModels, setDefaultChatFallbackModels] = useState<ModelFallbackConfig[]>([]);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, { name: string; color: string }>>({});

  // Sync local state from the organization currently being viewed in settings.
  useEffect(() => {
    if (!viewedOrganization) return;
    setOrganizationName(viewedOrganization.name);
    setDescription(viewedOrganization.description ?? "");
    setBrandColor(viewedOrganization.brandColor ?? "");
    setLogoUrl(viewedOrganization.logoUrl ?? "");
    setDefaultChatIssueCreationMode(viewedOrganization.defaultChatIssueCreationMode ?? "manual_approval");
    const runtimeType = viewedOrganization.defaultChatAgentRuntimeType ?? "";
    const runtimeConfig = asConfigRecord(viewedOrganization.defaultChatAgentRuntimeConfig);
    const model = typeof runtimeConfig.model === "string" ? runtimeConfig.model : "";
    setDefaultChatAdapterType(runtimeType);
    setDefaultChatModel(
      model,
    );
    setDefaultChatRuntimeConfig(runtimeConfig);
    setDefaultChatFallbackModels(
      runtimeType
        ? normalizeModelFallbacks(runtimeConfig.modelFallbacks, primaryModelFallbackKey(runtimeType, model))
        : [],
    );
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

  const generalDirty =
    !!viewedOrganization &&
    (organizationName !== viewedOrganization.name ||
      description !== (viewedOrganization.description ?? "") ||
      brandColor !== (viewedOrganization.brandColor ?? ""));

  const defaultChatAgentRuntimeConfig = useMemo<Record<string, unknown> | null>(() => {
    if (!defaultChatAgentRuntimeType) return null;
    const config = { ...defaultChatRuntimeConfig };
    if (defaultChatModel) {
      config.model = defaultChatModel;
    } else {
      delete config.model;
    }
    const modelFallbacks = normalizeModelFallbacks(
      defaultChatFallbackModels,
      primaryModelFallbackKey(defaultChatAgentRuntimeType, defaultChatModel),
    );
    if (modelFallbacks.length > 0) {
      config.modelFallbacks = modelFallbacks;
    } else {
      delete config.modelFallbacks;
    }
    return config;
  }, [defaultChatAgentRuntimeType, defaultChatFallbackModels, defaultChatModel, defaultChatRuntimeConfig]);

  const savedDefaultChatAgentRuntimeConfig = useMemo<Record<string, unknown> | null>(() => {
    if (!viewedOrganization?.defaultChatAgentRuntimeType) return null;
    const runtimeType = viewedOrganization.defaultChatAgentRuntimeType;
    const config = { ...asConfigRecord(viewedOrganization.defaultChatAgentRuntimeConfig) };
    const model = typeof config.model === "string" ? config.model : "";
    const modelFallbacks = normalizeModelFallbacks(
      config.modelFallbacks,
      primaryModelFallbackKey(runtimeType, model),
    );
    if (modelFallbacks.length > 0) {
      config.modelFallbacks = modelFallbacks;
    } else {
      delete config.modelFallbacks;
    }
    return config;
  }, [viewedOrganization?.defaultChatAgentRuntimeConfig, viewedOrganization?.defaultChatAgentRuntimeType]);

  const chatSettingsDirty =
    !!viewedOrganization &&
    (
      defaultChatIssueCreationMode !== (viewedOrganization.defaultChatIssueCreationMode ?? "manual_approval") ||
      defaultChatAgentRuntimeType !== (viewedOrganization.defaultChatAgentRuntimeType ?? "") ||
      stableJson(defaultChatAgentRuntimeConfig) !== stableJson(savedDefaultChatAgentRuntimeConfig)
    );

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
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
      defaultChatAgentRuntimeType: AgentRuntimeType | null;
      defaultChatAgentRuntimeConfig: Record<string, unknown> | null;
    }) =>
      organizationsApi.update(viewedOrganizationId!, {
        defaultChatIssueCreationMode: data.defaultChatIssueCreationMode,
        defaultChatAgentRuntimeType: data.defaultChatAgentRuntimeType,
        defaultChatAgentRuntimeConfig: data.defaultChatAgentRuntimeConfig,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "active") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "archived") });
    },
  });

  const chatRuntimeSecretsQuery = useQuery({
    queryKey: viewedOrganizationId ? queryKeys.secrets.list(viewedOrganizationId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(viewedOrganizationId!),
    enabled: Boolean(viewedOrganizationId),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  const createChatRuntimeSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!viewedOrganizationId) throw new Error("Select a organization to create secrets");
      return secretsApi.create(viewedOrganizationId, input);
    },
    onSuccess: async () => {
      if (!viewedOrganizationId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(viewedOrganizationId) });
    },
  });

  const restoreArchivedChatMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.update(chatId, { status: "active" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "active") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(viewedOrganizationId!, "archived") });
    },
  });

  const archivedChatsQuery = useQuery({
    queryKey: queryKeys.chats.list(viewedOrganizationId ?? "__none__", "archived"),
    queryFn: () => chatsApi.list(viewedOrganizationId!, "archived"),
    enabled: !!viewedOrganizationId,
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

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
      setLogoUploadError(null);
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
      { label: viewedOrganization?.name ?? "Organization", href: "/dashboard" },
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
    generalMutation.mutate({
      name: organizationName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
    });
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
      defaultChatAgentRuntimeType: defaultChatAgentRuntimeType || null,
      defaultChatAgentRuntimeConfig,
    });
  }

  function applyDefaultChatRuntimeType(nextRuntimeType: string) {
    if (!nextRuntimeType) {
      setDefaultChatAdapterType("");
      setDefaultChatModel("");
      setDefaultChatRuntimeConfig({});
      setDefaultChatFallbackModels([]);
      return;
    }
    const nextConfig = defaultConfigForRuntime(nextRuntimeType);
    setDefaultChatAdapterType(nextRuntimeType as AgentRuntimeType);
    setDefaultChatModel(typeof nextConfig.model === "string" ? nextConfig.model : "");
    setDefaultChatRuntimeConfig(nextConfig);
    setDefaultChatFallbackModels([]);
  }

  function updateDefaultChatRuntimeConfigField(field: string, value: unknown) {
    setDefaultChatRuntimeConfig((current) => {
      const next = { ...current };
      if (value === undefined) {
        delete next[field];
      } else {
        next[field] = value;
      }
      return next;
    });
  }

  function updateDefaultChatFallbackModels(nextFallbacks: ModelFallbackConfig[]) {
    if (!defaultChatAgentRuntimeType) return;
    setDefaultChatFallbackModels(
      normalizeModelFallbacks(
        nextFallbacks,
        primaryModelFallbackKey(defaultChatAgentRuntimeType, defaultChatModel),
      ),
    );
  }

  function handleArchiveOrganization() {
    if (!viewedOrganization || !viewedOrganizationId) return;

    const confirmed = window.confirm(
      t("organizationSettings.danger.confirm", { name: viewedOrganization.name }),
    );
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
      ? getOrganizationSettingsPath(nextViewedOrganization.issuePrefix)
      : null;

    archiveMutation.mutate({
      orgId: viewedOrganizationId,
      nextSelectedOrganizationId,
      nextViewedOrganizationPath,
    });
  }

  const organizationWorkspacesPath = applyOrganizationPrefix("/workspaces", viewedOrganization.issuePrefix);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("organizationSettings.title")}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.general")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={t("organizationSettings.general.name.label")}
            hint={t("organizationSettings.general.name.hint")}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </Field>
          <Field
            label={t("organizationSettings.general.description.label")}
            hint={t("organizationSettings.general.description.hint")}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={t("organizationSettings.general.description.placeholder")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.appearance")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <OrganizationPatternIcon
                organizationName={organizationName || viewedOrganization.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={t("organizationSettings.appearance.logo.label")}
                hint={t("organizationSettings.appearance.logo.hint")}
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending
                          ? t("organizationSettings.appearance.logo.removing")
                          : t("organizationSettings.appearance.logo.remove")}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : t("organizationSettings.appearance.logo.uploadFailed"))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">{t("organizationSettings.appearance.logo.uploading")}</span>
                  )}
                </div>
              </Field>
              <Field
                label={t("organizationSettings.appearance.brandColor.label")}
                hint={t("organizationSettings.appearance.brandColor.hint")}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder={t("organizationSettings.appearance.brandColor.auto")}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {t("organizationSettings.appearance.brandColor.clear")}
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !organizationName.trim()}
          >
            {generalMutation.isPending ? t("organizationSettings.save.saving") : t("organizationSettings.save.button")}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{t("organizationSettings.save.saved")}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : t("organizationSettings.save.failed")}
            </span>
          )}
        </div>
      )}

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.workspace")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={t("organizationSettings.workspace.rootPath.label")}
            hint={t("organizationSettings.workspace.rootPath.hint")}
          >
            <div
              className="overflow-x-auto whitespace-nowrap rounded-md border border-border bg-muted/20 px-2.5 py-2 text-sm font-mono text-muted-foreground"
              title={workspaceRootQuery.data?.rootPath ?? undefined}
            >
              {workspaceRootQuery.data?.rootPath ?? t("organizationSettings.workspace.rootPath.loading")}
            </div>
          </Field>

          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to={organizationWorkspacesPath}>{t("organizationSettings.workspace.open")}</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.labels")}
        </div>
        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-3 rounded-md border border-border/70 bg-card/40 px-3 py-3">
            <div className="rounded-full border border-border/60 bg-background/80 p-2">
              <Tags className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t("organizationSettings.labels.intro.title")}</div>
              <p className="text-sm text-muted-foreground">
                {t("organizationSettings.labels.intro.description")}
              </p>
            </div>
          </div>

          <div className="rounded-md border border-border/70">
            <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
              <input
                className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={newLabelName}
                placeholder={t("organizationSettings.labels.new.placeholder")}
                onChange={(event) => setNewLabelName(event.target.value)}
              />
              <input
                type="color"
                value={newLabelColor}
                onChange={(event) => setNewLabelColor(event.target.value)}
                className="color-input-circle h-8 w-8 shrink-0 border border-border bg-transparent"
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
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {createLabelMutation.isPending ? t("organizationSettings.labels.adding") : t("organizationSettings.labels.add")}
              </Button>
            </div>

            {labelsQuery.isLoading ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">{t("organizationSettings.labels.loading")}</div>
            ) : (labelsQuery.data ?? []).length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">{t("organizationSettings.labels.empty")}</div>
            ) : (
              <div className="divide-y divide-border/60">
                {(labelsQuery.data ?? []).map((label) => {
                  const draft = labelDrafts[label.id] ?? { name: label.name, color: label.color };
                  const normalizedDraftName = normalizeIssueLabelName(draft.name);
                  const dirty = normalizedDraftName !== label.name || draft.color !== label.color;
                  const saving = updateLabelMutation.isPending && updateLabelMutation.variables?.id === label.id;
                  const showSaveButton = dirty || saving;
                  const deleting = deleteLabelMutation.isPending && deleteLabelMutation.variables === label.id;
                  return (
                    <div key={label.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: draft.color }} />
                      <input
                        className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        type="text"
                        value={draft.name}
                        onChange={(event) => updateLabelDraft(label.id, { name: event.target.value })}
                        aria-label={`Label name for ${label.name}`}
                      />
                      <input
                        type="color"
                        value={draft.color}
                        onChange={(event) => updateLabelDraft(label.id, { color: event.target.value })}
                        className="color-input-circle h-8 w-8 shrink-0 border border-border bg-transparent"
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
                              data: {
                                name: normalizedDraftName,
                                color: draft.color,
                              },
                            })
                          }
                        >
                          {saving ? t("organizationSettings.labels.saving") : t("organizationSettings.labels.save")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete label ${label.name}`}
                          className="text-muted-foreground hover:text-destructive"
                          disabled={deleting}
                          onClick={() => deleteLabelMutation.mutate(label.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="sr-only">{t("organizationSettings.labels.delete", { name: label.name })}</span>
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {createLabelMutation.isError ? (
            <div className="text-xs text-destructive">
              {createLabelMutation.error instanceof Error ? createLabelMutation.error.message : t("organizationSettings.labels.failedCreate")}
            </div>
          ) : null}
          {updateLabelMutation.isError ? (
            <div className="text-xs text-destructive">
              {updateLabelMutation.error instanceof Error ? updateLabelMutation.error.message : t("organizationSettings.labels.failedUpdate")}
            </div>
          ) : null}
          {deleteLabelMutation.isError ? (
            <div className="text-xs text-destructive">
              {deleteLabelMutation.error instanceof Error ? deleteLabelMutation.error.message : t("organizationSettings.labels.failedDelete")}
            </div>
          ) : null}
        </div>
      </div>

      {/* Hiring */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.hiring")}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={t("organizationSettings.hiring.requireApproval.label")}
            hint={t("organizationSettings.hiring.requireApproval.hint")}
            checked={!!viewedOrganization.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.chat")}
        </div>
        <div className="space-y-4 rounded-xl border border-border/70 bg-card/60 px-4 py-4">
          <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3">
            <div className="rounded-full border border-border/60 bg-background/80 p-2">
              <MessageSquareMore className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t("organizationSettings.chat.copilot.title")}</div>
              <p className="text-sm text-muted-foreground">
                {t("organizationSettings.chat.copilot.description")}
              </p>
            </div>
          </div>

          {defaultChatAgentRuntimeType ? (
            <div className="space-y-3">
              <div className={runtimeProviderRailClassName}>
                <RuntimeProviderCard
                  title="Primary"
                  className={runtimeProviderItemClassName}
                  runtimeType={defaultChatAgentRuntimeType}
                  model={defaultChatModel}
                  config={{ ...defaultChatRuntimeConfig, ...(defaultChatModel ? { model: defaultChatModel } : {}) }}
                  selectedOrganizationId={viewedOrganizationId}
                  availableSecrets={chatRuntimeSecretsQuery.data ?? []}
                  onCreateSecret={(name, value): Promise<OrganizationSecret> =>
                    createChatRuntimeSecret.mutateAsync({ name, value })
                  }
                  onRuntimeTypeChange={applyDefaultChatRuntimeType}
                  onModelChange={(model) => {
                    const normalizedFallbacks = normalizeModelFallbacks(
                      defaultChatFallbackModels,
                      primaryModelFallbackKey(defaultChatAgentRuntimeType, model),
                    );
                    setDefaultChatModel(model);
                    updateDefaultChatRuntimeConfigField("model", model || undefined);
                    setDefaultChatFallbackModels(normalizedFallbacks);
                  }}
                  onConfigFieldChange={updateDefaultChatRuntimeConfigField}
                  hideInstructionsFile
                  triggerTestId="chat-primary-model"
                />

                {defaultChatFallbackModels.map((fallback, index) => (
                  <RuntimeProviderCard
                    key={`${fallback.agentRuntimeType}-${index}`}
                    title={`Fallback ${index + 1}`}
                    className={runtimeProviderItemClassName}
                    runtimeType={fallback.agentRuntimeType}
                    model={fallback.model}
                    config={{ ...(fallback.config ?? {}), model: fallback.model }}
                    selectedOrganizationId={viewedOrganizationId}
                    availableSecrets={chatRuntimeSecretsQuery.data ?? []}
                    onCreateSecret={(name, value): Promise<OrganizationSecret> =>
                      createChatRuntimeSecret.mutateAsync({ name, value })
                    }
                    hideInstructionsFile
                    onRemove={() =>
                      updateDefaultChatFallbackModels(defaultChatFallbackModels.filter((_, itemIndex) => itemIndex !== index))
                    }
                    onRuntimeTypeChange={(nextRuntimeType) => {
                      const nextConfig = defaultConfigForRuntime(nextRuntimeType);
                      const next = [...defaultChatFallbackModels];
                      next[index] = {
                        agentRuntimeType: nextRuntimeType,
                        model: typeof nextConfig.model === "string" ? nextConfig.model : "",
                        config: nextConfig,
                      };
                      updateDefaultChatFallbackModels(next);
                    }}
                    onModelChange={(model) => {
                      const next = [...defaultChatFallbackModels];
                      next[index] = {
                        ...fallback,
                        model,
                        config: {
                          ...(fallback.config ?? {}),
                          model,
                        },
                      };
                      updateDefaultChatFallbackModels(next);
                    }}
                    onConfigFieldChange={(field, value) => {
                      const next = [...defaultChatFallbackModels];
                      const nextConfig = { ...(fallback.config ?? {}) };
                      if (value === undefined) {
                        delete nextConfig[field];
                      } else {
                        nextConfig[field] = value;
                      }
                      next[index] = {
                        ...fallback,
                        config: nextConfig,
                      };
                      updateDefaultChatFallbackModels(next);
                    }}
                    triggerTestId={`chat-fallback-model-${index + 1}`}
                  />
                ))}

                <button
                  type="button"
                  className={cn(
                    runtimeProviderItemClassName,
                    "min-h-[180px] rounded-lg border border-dashed border-border/80 px-4 py-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30",
                  )}
                  onClick={() =>
                    updateDefaultChatFallbackModels([
                      ...defaultChatFallbackModels,
                      defaultFallbackItem(defaultChatAgentRuntimeType),
                    ])
                  }
                >
                  <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <span className="rounded-full border border-border p-2">
                      <Plus className="h-4 w-4" />
                    </span>
                    <span>Add fallback</span>
                  </div>
                </button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => applyDefaultChatRuntimeType("")}
              >
                {t("organizationSettings.chat.runtime.none")}
              </Button>
            </div>
          ) : (
            <Field
              label={t("organizationSettings.chat.runtime.label")}
              hint={t("organizationSettings.chat.runtime.hint")}
            >
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={defaultChatAgentRuntimeType}
                onChange={(event) => applyDefaultChatRuntimeType(event.target.value)}
              >
                <option value="">{t("organizationSettings.chat.runtime.none")}</option>
                {CHAT_DEFAULT_ADAPTER_OPTIONS.map((agentRuntimeType) => (
                  <option key={agentRuntimeType} value={agentRuntimeType}>
                    {adapterLabels[agentRuntimeType] ?? agentRuntimeType}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label={t("organizationSettings.chat.issueMode.label")}
            hint={t("organizationSettings.chat.issueMode.hint")}
          >
            <select
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={defaultChatIssueCreationMode}
              onChange={(event) => {
                const value = event.target.value as "manual_approval" | "auto_create";
                setDefaultChatIssueCreationMode(value);
              }}
            >
              <option value="manual_approval">{t("organizationSettings.chat.issueMode.manual")}</option>
              <option value="auto_create">{t("organizationSettings.chat.issueMode.auto")}</option>
            </select>
          </Field>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveChatSettings}
              disabled={!chatSettingsDirty || chatSettingsMutation.isPending}
            >
              {chatSettingsMutation.isPending ? t("organizationSettings.save.saving") : t("organizationSettings.chat.save")}
            </Button>
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
          </div>
        </div>

        <div className="space-y-3 rounded-xl border border-border/70 bg-card/60 px-4 py-4">
          <div>
            <div className="text-sm font-medium">{t("organizationSettings.chat.archived.title")}</div>
            <p className="text-sm text-muted-foreground">
              {t("organizationSettings.chat.archived.description")}
            </p>
          </div>
          {archivedChatsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">{t("organizationSettings.chat.archived.loading")}</div>
          ) : (archivedChatsQuery.data ?? []).length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
              {t("organizationSettings.chat.archived.empty")}
            </div>
          ) : (
            <div className="space-y-2">
              {(archivedChatsQuery.data ?? []).map((conversation) => (
                <div
                  key={conversation.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/40 px-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{conversation.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {conversation.chatRuntime.sourceLabel}
                      {conversation.chatRuntime.model ? ` · ${conversation.chatRuntime.model}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoreArchivedChatMutation.isPending}
                    onClick={() => restoreArchivedChatMutation.mutate(conversation.id)}
                  >
                    <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                    {t("organizationSettings.chat.archived.restore")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Invites */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.invites")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {t("organizationSettings.invites.description")}
            </span>
            <HintIcon text={t("organizationSettings.invites.hint")} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? t("organizationSettings.invites.generating")
                : t("organizationSettings.invites.generate")}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {t("organizationSettings.invites.promptTitle")}
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    {t("organizationSettings.invites.copied")}
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied ? t("organizationSettings.invites.copiedSnippet") : t("organizationSettings.invites.copy")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("organizationSettings.section.packages")}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("organizationSettings.packages.description.before")}{" "}
            <Link
              to={applyOrganizationPrefix("/org", viewedOrganization.issuePrefix)}
              className="underline hover:text-foreground"
            >
              {t("organizationSettings.packages.structureLink")}
            </Link>{" "}
            {t("organizationSettings.packages.description.after")}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to={applyOrganizationPrefix("/organization/export", viewedOrganization.issuePrefix)}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("organizationSettings.packages.export")}
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to={applyOrganizationPrefix("/organization/import", viewedOrganization.issuePrefix)}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("organizationSettings.packages.import")}
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {t("organizationSettings.section.dangerZone")}
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("organizationSettings.danger.description")}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                viewedOrganization.status === "archived"
              }
              onClick={handleArchiveOrganization}
            >
              {archiveMutation.isPending
                ? t("organizationSettings.danger.archiving")
                : viewedOrganization.status === "archived"
                ? t("organizationSettings.danger.alreadyArchived")
                : t("organizationSettings.danger.archive")}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : t("organizationSettings.danger.failed")}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
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
