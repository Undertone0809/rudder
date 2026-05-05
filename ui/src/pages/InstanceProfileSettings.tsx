import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, IdCard, MessageSquareText, UserRound } from "lucide-react";
import { OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH } from "@rudderhq/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";

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

  if (profileQuery.isLoading) {
    return <SettingsPageSkeleton />;
  }

  if (profileQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {profileQuery.error instanceof Error
          ? profileQuery.error.message
          : t("profile.loadFailed")}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 pb-6">
      <SettingsPageHeader
        icon={UserRound}
        title={t("profile.title")}
        description={t("profile.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection
        title={t("profile.about.title")}
        description={t("profile.about.description")}
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="profile-nickname" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <IdCard className="h-4 w-4 text-muted-foreground" />
              {t("profile.nickname.label")}
            </label>
            <Input
              id="profile-nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={t("profile.nickname.placeholder")}
              maxLength={80}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {t("profile.nickname.help")}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="profile-more-about-you" className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MessageSquareText className="h-4 w-4 text-muted-foreground" />
                {t("profile.moreAboutYou.label")}
              </label>
              <Button type="button" variant="outline" size="sm" onClick={handleCopyPrompt}>
                {promptCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
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
            <div className="flex items-center justify-between gap-3 text-xs leading-5 text-muted-foreground">
              <p>{t("profile.moreAboutYou.help")}</p>
              <span className="shrink-0 tabular-nums">{moreAboutYou.length}/{OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end pt-2">
          <Button onClick={() => saveMutation.mutate()} disabled={!hasChanges || saveMutation.isPending}>
            {saveMutation.isPending ? t("profile.saving") : t("profile.save")}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
