import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsActions,
  SettingsField,
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Copy, IdCard, MessageSquareText, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { AccountSettingsSections } from "./InstanceAccountSettings";

const PROFILE_IMPORT_PROMPT = `Export all of my stored memories and any context you've learned about me from past conversations. Preserve my words verbatim where possible, especially for instructions and preferences.

## Categories (output in this order):

1. **Instructions**: Rules I've explicitly asked you to follow going forward — tone, format, style, "always do X", "never do Y", and corrections to your behavior. Only include rules from stored memories, not from conversations.

2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.

3. **Career**: Current and past roles, companies, and general skill areas.

4. **Projects**: Projects I meaningfully built or committed to. Ideally ONE entry per project. Include what it does, current status, and any key decisions. Use the project name or a short descriptor as the first words of the entry.

5. **Preferences**: Opinions, tastes, and working-style preferences that apply broadly.

## Format:

Use section headers for each category. Within each category, list one entry per line, sorted by oldest date first. Format each line as:

[YYYY-MM-DD] - Entry content here.

If no date is known, use [unknown] instead.

## Output:
- Wrap the entire export in a single code block for easy copying.
- After the code block, state whether this is the complete set or if more remain.`;

export function InstanceProfileSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [nickname, setNickname] = useState("");
  const [moreAboutYou, setMoreAboutYou] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.profile") },
    ]);
  }, [setBreadcrumbs, t]);

  const profileQuery = useQuery({
    queryKey: queryKeys.instance.profileSettings,
    queryFn: () => instanceSettingsApi.getProfile(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  useEffect(() => {
    if (!profileQuery.data) return;
    setNickname(profileQuery.data.nickname);
    setMoreAboutYou(profileQuery.data.moreAboutYou);
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => instanceSettingsApi.updateProfile({ nickname, moreAboutYou }),
    onSuccess: async (next) => {
      setActionError(null);
      setNickname(next.nickname);
      setMoreAboutYou(next.moreAboutYou);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.profileSettings });
      pushToast({
        title: t("profile.toastSaved.title"),
        body: t("profile.toastSaved.body"),
        tone: "success",
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("profile.updateFailed");
      setActionError(message);
      pushToast({
        title: t("profile.toastSaveFailed.title"),
        body: message,
        tone: "error",
      });
    },
  });

  const hasChanges =
    nickname !== (profileQuery.data?.nickname ?? "") ||
    moreAboutYou !== (profileQuery.data?.moreAboutYou ?? "");

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(PROFILE_IMPORT_PROMPT);
      setPromptCopied(true);
      pushToast({
        title: t("profile.import.copied.title"),
        body: t("profile.import.copied.body"),
        tone: "success",
      });
    } catch {
      setPromptCopied(false);
      pushToast({
        title: t("profile.import.copyFailed.title"),
        body: t("profile.import.copyFailed.body"),
        tone: "error",
      });
    }
  };

  return (
    <SettingsPage>
      <SettingsPageHeader
        icon={UserRound}
        title={t("profile.title")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      {profileQuery.isLoading ? (
        <SettingsSection
          data-testid="settings-page-skeleton"
          aria-hidden="true"
          title={t("profile.about.title")}
        >
          <SettingsGroup className="flex flex-col gap-3 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
          </SettingsGroup>
        </SettingsSection>
      ) : profileQuery.error ? (
        <SettingsSection
          title={t("profile.about.title")}
        >
          <div role="alert" className="text-sm text-destructive">
            {profileQuery.error instanceof Error
              ? profileQuery.error.message
              : t("profile.loadFailed")}
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection
          title={t("profile.about.title")}
        >
          <SettingsGroup>
          <SettingsField
            htmlFor="profile-nickname"
            icon={IdCard}
            label={t("profile.nickname.label")}
          >
            <Input
              id="profile-nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={t("profile.nickname.placeholder")}
              maxLength={80}
            />
          </SettingsField>

          <SettingsField
            htmlFor="profile-more-about-you"
            icon={MessageSquareText}
            label={t("profile.moreAboutYou.label")}
            description={t("profile.moreAboutYou.help")}
          >
            <div className="flex flex-col gap-3 border-y border-[color:var(--border-soft)] py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Brain className="size-4 text-muted-foreground" />
                  {t("profile.import.helper.title")}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t("profile.import.helper.description")}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleCopyPrompt} className="shrink-0">
                {promptCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {promptCopied ? t("profile.import.copiedButton") : t("profile.import.copyPrompt")}
              </Button>
            </div>
            <Textarea
              id="profile-more-about-you"
              value={moreAboutYou}
              onChange={(event) => setMoreAboutYou(event.target.value)}
              placeholder={t("profile.moreAboutYou.placeholder")}
              maxLength={OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH}
              className="min-h-36"
            />
            <div className="flex items-center justify-end text-xs leading-5 text-muted-foreground">
              <span className="shrink-0 tabular-nums">{moreAboutYou.length}/{OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH}</span>
            </div>
          </SettingsField>

          <SettingsActions>
            <Button onClick={() => saveMutation.mutate()} disabled={!hasChanges || saveMutation.isPending}>
              {saveMutation.isPending ? t("profile.saving") : t("profile.save")}
            </Button>
          </SettingsActions>
          </SettingsGroup>
        </SettingsSection>
      )}

      <AccountSettingsSections />
    </SettingsPage>
  );
}
