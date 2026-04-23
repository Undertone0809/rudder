import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IdCard, MessageSquareText, UserRound } from "lucide-react";
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

export function InstanceProfileSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [nickname, setNickname] = useState("");
  const [moreAboutYou, setMoreAboutYou] = useState("");
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

  const hasChanges =
    nickname !== (profileQuery.data?.nickname ?? "") ||
    moreAboutYou !== (profileQuery.data?.moreAboutYou ?? "");

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
            <label htmlFor="profile-more-about-you" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MessageSquareText className="h-4 w-4 text-muted-foreground" />
              {t("profile.moreAboutYou.label")}
            </label>
            <Textarea
              id="profile-more-about-you"
              value={moreAboutYou}
              onChange={(event) => setMoreAboutYou(event.target.value)}
              placeholder={t("profile.moreAboutYou.placeholder")}
              maxLength={2000}
              className="min-h-36"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {t("profile.moreAboutYou.help")}
            </p>
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
