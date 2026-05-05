import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, IdCard, MessageSquareText, Upload, UserRound } from "lucide-react";
import { OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH } from "@rudderhq/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import type { TranslationKey } from "@/i18n/locales/en";

type ImportMode = "append" | "replace";

type ImportSectionKey = "instructions" | "identity" | "career" | "projects" | "preferences" | "other";

type ImportSection = {
  key: ImportSectionKey;
  titleKey: TranslationKey;
  content: string;
};

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

const IMPORT_SECTION_DEFINITIONS: Array<Omit<ImportSection, "content">> = [
  { key: "instructions", titleKey: "profile.import.category.instructions" },
  { key: "identity", titleKey: "profile.import.category.identity" },
  { key: "career", titleKey: "profile.import.category.career" },
  { key: "projects", titleKey: "profile.import.category.projects" },
  { key: "preferences", titleKey: "profile.import.category.preferences" },
  { key: "other", titleKey: "profile.import.category.other" },
];

function stripOuterCodeFence(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```(?:\s*[\s\S]*)?$/);
  return match?.[1]?.trim() ?? trimmed;
}

function resolveImportSectionKey(line: string): ImportSectionKey | null {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^\*\*(.*?)\*\*:?\s*$/, "$1")
    .replace(/[:：]\s*$/, "")
    .trim()
    .toLowerCase();

  if (normalized === "instructions") return "instructions";
  if (normalized === "identity") return "identity";
  if (normalized === "career") return "career";
  if (normalized === "projects") return "projects";
  if (normalized === "preferences") return "preferences";
  return null;
}

function parseProfileImport(rawInput: string): ImportSection[] {
  const raw = stripOuterCodeFence(rawInput);
  if (!raw) return [];

  const contentByKey = new Map<ImportSectionKey, string[]>();
  let currentKey: ImportSectionKey = "other";

  for (const line of raw.split(/\r?\n/)) {
    const nextKey = resolveImportSectionKey(line);
    if (nextKey) {
      currentKey = nextKey;
      if (!contentByKey.has(currentKey)) contentByKey.set(currentKey, []);
      continue;
    }
    if (!contentByKey.has(currentKey)) contentByKey.set(currentKey, []);
    contentByKey.get(currentKey)?.push(line);
  }

  return IMPORT_SECTION_DEFINITIONS.map((definition) => ({
    ...definition,
    content: (contentByKey.get(definition.key) ?? []).join("\n").trim(),
  })).filter((section) => section.content.length > 0);
}

function buildProfileImportDraft(sections: ImportSection[], selectedKeys: Set<ImportSectionKey>, titleFor: (section: ImportSection) => string) {
  return sections
    .filter((section) => selectedKeys.has(section.key))
    .map((section) => `${titleFor(section)}:\n${section.content.trim()}`)
    .join("\n\n")
    .trim();
}

function composeImportedProfileContext(current: string, draft: string, mode: ImportMode) {
  const normalizedDraft = draft.trim();
  if (!normalizedDraft) return current;
  if (mode === "replace") return normalizedDraft;
  return [current.trim(), normalizedDraft].filter(Boolean).join("\n\n");
}

export function InstanceProfileSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [nickname, setNickname] = useState("");
  const [moreAboutYou, setMoreAboutYou] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("append");
  const [selectedImportKeys, setSelectedImportKeys] = useState<Set<ImportSectionKey>>(() => new Set());
  const [importDraftOverride, setImportDraftOverride] = useState<string | null>(null);
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

  const importSections = useMemo(() => parseProfileImport(importInput), [importInput]);
  const importDraftBase = useMemo(
    () => buildProfileImportDraft(importSections, selectedImportKeys, (section) => t(section.titleKey)),
    [importSections, selectedImportKeys, t],
  );
  const importDraft = importDraftOverride ?? importDraftBase;
  const nextImportedProfileContext = composeImportedProfileContext(moreAboutYou, importDraft, importMode);
  const importDraftTooLong = nextImportedProfileContext.length > OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH;
  const canApplyImport = importDraft.trim().length > 0 && !importDraftTooLong;

  const resetImportDialog = () => {
    setImportInput("");
    setImportMode(moreAboutYou.trim() ? "append" : "replace");
    setSelectedImportKeys(new Set());
    setImportDraftOverride(null);
    setPromptCopied(false);
  };

  const handleImportInputChange = (value: string) => {
    const nextSections = parseProfileImport(value);
    setImportInput(value);
    setSelectedImportKeys(new Set(nextSections.map((section) => section.key)));
    setImportDraftOverride(null);
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(PROFILE_IMPORT_PROMPT);
      setPromptCopied(true);
    } catch {
      setPromptCopied(false);
      pushToast({
        title: t("profile.import.copyFailed.title"),
        body: t("profile.import.copyFailed.body"),
        tone: "error",
      });
    }
  };

  const handleToggleImportSection = (key: ImportSectionKey, checked: boolean | "indeterminate") => {
    setSelectedImportKeys((current) => {
      const next = new Set(current);
      if (checked === true) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
    setImportDraftOverride(null);
  };

  const handleApplyImport = () => {
    if (!canApplyImport) return;
    setMoreAboutYou(nextImportedProfileContext);
    setImportDialogOpen(false);
    pushToast({
      title: t("profile.import.applied.title"),
      body: t("profile.import.applied.body"),
      tone: "success",
    });
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
          <div className="flex items-center justify-between gap-3 rounded-[calc(var(--radius-md)-1px)] border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_76%,transparent)] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium text-foreground">{t("profile.import.entry.title")}</div>
              <div className="text-xs leading-5 text-muted-foreground">{t("profile.import.entry.description")}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                resetImportDialog();
                setImportDialogOpen(true);
              }}
            >
              <Upload className="h-4 w-4" />
              {t("profile.import.open")}
            </Button>
          </div>

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

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("profile.import.title")}</DialogTitle>
            <DialogDescription>{t("profile.import.description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-foreground">{t("profile.import.copyStep.title")}</h3>
                <Button type="button" variant="outline" size="sm" onClick={handleCopyPrompt}>
                  {promptCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {promptCopied ? t("profile.import.copied") : t("profile.import.copy")}
                </Button>
              </div>
              <Textarea
                readOnly
                value={PROFILE_IMPORT_PROMPT}
                className="min-h-32 resize-none bg-[color:var(--surface-inset)] font-mono text-xs leading-5"
                aria-label={t("profile.import.promptLabel")}
              />
            </section>

            <section className="space-y-2.5">
              <h3 className="text-sm font-medium text-foreground">{t("profile.import.pasteStep.title")}</h3>
              <Textarea
                value={importInput}
                onChange={(event) => handleImportInputChange(event.target.value)}
                placeholder={t("profile.import.paste.placeholder")}
                className="min-h-36"
                aria-label={t("profile.import.paste.label")}
              />
              <p className="text-xs leading-5 text-muted-foreground">{t("profile.import.paste.help")}</p>
            </section>

            {importSections.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-foreground">{t("profile.import.review.title")}</h3>
                  <div className="text-xs text-muted-foreground">
                    {t("profile.import.review.count", { count: importSections.length })}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {importSections.map((section) => (
                    <label
                      key={section.key}
                      className="flex cursor-pointer items-start gap-2 rounded-[calc(var(--radius-md)-2px)] border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] px-3 py-2.5"
                    >
                      <Checkbox
                        checked={selectedImportKeys.has(section.key)}
                        onCheckedChange={(checked) => handleToggleImportSection(section.key, checked)}
                        aria-label={t(section.titleKey)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="block text-sm font-medium text-foreground">{t(section.titleKey)}</span>
                        <span className="line-clamp-2 block text-xs leading-5 text-muted-foreground">{section.content}</span>
                      </span>
                    </label>
                  ))}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-[calc(var(--radius-md)-2px)] border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] px-3 py-2.5">
                    <input
                      type="radio"
                      name="profile-import-mode"
                      value="append"
                      checked={importMode === "append"}
                      onChange={() => setImportMode("append")}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">{t("profile.import.mode.append")}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{t("profile.import.mode.append.description")}</span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-[calc(var(--radius-md)-2px)] border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] px-3 py-2.5">
                    <input
                      type="radio"
                      name="profile-import-mode"
                      value="replace"
                      checked={importMode === "replace"}
                      onChange={() => setImportMode("replace")}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">{t("profile.import.mode.replace")}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{t("profile.import.mode.replace.description")}</span>
                    </span>
                  </label>
                </div>

                <div className="space-y-2">
                  <label htmlFor="profile-import-draft" className="text-sm font-medium text-foreground">
                    {t("profile.import.draft.label")}
                  </label>
                  <Textarea
                    id="profile-import-draft"
                    value={importDraft}
                    onChange={(event) => setImportDraftOverride(event.target.value)}
                    maxLength={OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH}
                    className="min-h-40"
                  />
                  <div className="flex items-center justify-between gap-3 text-xs leading-5">
                    <p className={importDraftTooLong ? "text-destructive" : "text-muted-foreground"}>
                      {importDraftTooLong ? t("profile.import.tooLong") : t("profile.import.draft.help")}
                    </p>
                    <span className={importDraftTooLong ? "shrink-0 tabular-nums text-destructive" : "shrink-0 tabular-nums text-muted-foreground"}>
                      {nextImportedProfileContext.length}/{OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH}
                    </span>
                  </div>
                </div>
              </section>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={handleApplyImport} disabled={!canApplyImport}>
              {t("profile.import.apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
