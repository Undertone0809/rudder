import {
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import {
  type DesktopIdentityDeviceSession,
  type DesktopIdentityState,
  readDesktopIdentity,
} from "@/lib/desktop-identity";
import { timeAgo } from "@/lib/timeAgo";
import {
  AlertCircle,
  Laptop,
  LoaderCircle,
  LogIn,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";

type PageState =
  | { kind: "desktop-only" }
  | { kind: "loading" }
  | { kind: "ready"; identity: DesktopIdentityState };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function DeviceSessionRow({
  session,
  revoking,
  onRevoke,
}: {
  session: DesktopIdentityDeviceSession;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const details = [
    session.platform,
    t("account.sessions.lastSeen", { time: timeAgo(session.lastSeenAt) }),
  ].filter(Boolean).join(" · ");

  return (
    <SettingsItem
      icon={Laptop}
      title={session.name}
      description={details}
      action={
        session.current ? (
          <span className="text-[12px] font-medium text-muted-foreground">
            {t("account.sessions.current")}
          </span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={revoking}
            onClick={onRevoke}
          >
            {revoking
              ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />
              : <Trash2 data-icon="inline-start" />}
            {revoking ? t("account.sessions.revoking") : t("account.sessions.revoke")}
          </Button>
        )
      }
    />
  );
}

export function AccountSettingsSections() {
  const { t } = useI18n();
  const [pageState, setPageState] = useState<PageState>(() =>
    readDesktopIdentity() ? { kind: "loading" } : { kind: "desktop-only" },
  );
  const [sessions, setSessions] = useState<DesktopIdentityDeviceSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<"sign-in" | "sign-out" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    const identity = readDesktopIdentity();
    if (!identity) return;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      setSessions(await identity.listDeviceSessions());
    } catch (error) {
      setSessions([]);
      setSessionsError(errorMessage(error, t("account.sessions.loadFailed")));
    } finally {
      setSessionsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const identity = readDesktopIdentity();
    if (!identity) {
      setPageState({ kind: "desktop-only" });
      return;
    }

    let cancelled = false;
    const applyState = (next: DesktopIdentityState) => {
      if (cancelled) return;
      setPageState({ kind: "ready", identity: next });
      if (next.status !== "signed-in") {
        setSessions([]);
        setSessionsError(null);
      }
    };

    const unsubscribe = identity.onStateChanged(applyState);
    void identity.getState()
      .then(applyState)
      .catch((error) => {
        applyState({
          status: "error",
          message: errorMessage(error, t("account.loadFailed")),
          recoverable: true,
        });
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [t]);

  const signedInDeviceId =
    pageState.kind === "ready" && pageState.identity.status === "signed-in"
      ? pageState.identity.deviceId
      : null;

  useEffect(() => {
    if (!signedInDeviceId) return;
    void loadSessions();
  }, [loadSessions, signedInDeviceId]);

  async function handleSignIn() {
    const identity = readDesktopIdentity();
    if (!identity) return;
    setActionPending("sign-in");
    setActionError(null);
    setPageState({ kind: "ready", identity: { status: "signing-in" } });
    try {
      const nextState = await identity.signIn();
      setPageState({ kind: "ready", identity: nextState });
    } catch (error) {
      const message = errorMessage(error, t("account.signInFailed"));
      setActionError(message);
      setPageState({ kind: "ready", identity: { status: "error", message, recoverable: true } });
    } finally {
      setActionPending(null);
    }
  }

  async function handleSignOut() {
    const identity = readDesktopIdentity();
    if (!identity) return;
    setActionPending("sign-out");
    setActionError(null);
    try {
      setPageState({ kind: "ready", identity: await identity.signOut() });
      setSessions([]);
    } catch (error) {
      setActionError(errorMessage(error, t("account.signOutFailed")));
    } finally {
      setActionPending(null);
    }
  }

  async function handleRevoke(sessionId: string) {
    const identity = readDesktopIdentity();
    if (!identity) return;
    setRevokingSessionId(sessionId);
    setSessionsError(null);
    try {
      await identity.revokeDeviceSession(sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
    } catch (error) {
      setSessionsError(errorMessage(error, t("account.sessions.revokeFailed")));
    } finally {
      setRevokingSessionId(null);
    }
  }

  const identityState = pageState.kind === "ready" ? pageState.identity : null;

  return (
    <>
      {pageState.kind === "desktop-only" ? (
        <SettingsSection title={t("account.desktopOnly.title")}>
          <SettingsGroup>
            <SettingsItem
              icon={MonitorSmartphone}
              title={t("account.desktopOnly.status")}
              description={t("account.desktopOnly.description")}
            />
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      {pageState.kind === "loading" ? (
        <SettingsSection title={t("account.status.title")}>
          <SettingsGroup>
            <SettingsItem
              icon={LoaderCircle}
              title={t("account.loading")}
              description={t("account.loadingDescription")}
            />
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      {identityState ? (
        <SettingsSection title={t("account.status.title")}>
          <SettingsGroup>
            {identityState.status === "signed-out" ? (
              <SettingsItem
                icon={LogIn}
                title={t("account.signedOut.title")}
                description={t("account.signedOut.description")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    disabled={actionPending === "sign-in"}
                    onClick={() => void handleSignIn()}
                  >
                    <LogIn data-icon="inline-start" />
                    {t("account.signIn")}
                  </Button>
                }
              />
            ) : null}

            {identityState.status === "signing-in" ? (
              <SettingsItem
                icon={LoaderCircle}
                title={t("account.signingIn.title")}
                description={t("account.signingIn.description")}
                action={
                  <Button type="button" size="sm" disabled>
                    <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />
                    {t("account.signingIn.action")}
                  </Button>
                }
              />
            ) : null}

            {identityState.status === "error" ? (
              <SettingsItem
                icon={AlertCircle}
                title={t("account.error.title")}
                description={identityState.message}
                action={
                  identityState.recoverable !== false ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleSignIn()}>
                      <RefreshCw data-icon="inline-start" />
                      {t("account.tryAgain")}
                    </Button>
                  ) : null
                }
              />
            ) : null}

            {identityState.status === "signed-in" ? (
              <SettingsItem
                icon={ShieldCheck}
                title={identityState.account.email ?? t("account.emailUnavailable")}
                description={t("account.signedIn.description")}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={actionPending === "sign-out"}
                    onClick={() => void handleSignOut()}
                  >
                    {actionPending === "sign-out"
                      ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />
                      : <LogOut data-icon="inline-start" />}
                    {actionPending === "sign-out" ? t("account.signingOut") : t("account.signOut")}
                  </Button>
                }
              />
            ) : null}
          </SettingsGroup>
          {actionError ? (
            <p role="alert" className="text-[13px] leading-5 text-destructive">{actionError}</p>
          ) : null}
        </SettingsSection>
      ) : null}

      {identityState?.status === "signed-in" ? (
        <SettingsSection
          title={t("account.sessions.title")}
          description={t("account.sessions.description")}
        >
          <SettingsGroup>
            {sessionsLoading ? (
              <SettingsItem
                icon={LoaderCircle}
                title={t("account.sessions.loading")}
              />
            ) : null}
            {!sessionsLoading && sessions.length === 0 && !sessionsError ? (
              <SettingsItem
                icon={MonitorSmartphone}
                title={t("account.sessions.empty")}
                description={t("account.sessions.emptyDescription")}
              />
            ) : null}
            {!sessionsLoading
              ? sessions.map((session) => (
                  <DeviceSessionRow
                    key={session.id}
                    session={session}
                    revoking={revokingSessionId === session.id}
                    onRevoke={() => void handleRevoke(session.id)}
                  />
                ))
              : null}
          </SettingsGroup>
          {sessionsError ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="alert" className="text-[13px] leading-5 text-destructive">{sessionsError}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => void loadSessions()}>
                <RefreshCw data-icon="inline-start" />
                {t("account.sessions.retry")}
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}

export function InstanceAccountSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.profile") },
    ]);
  }, [setBreadcrumbs, t]);

  return (
    <SettingsPage>
      <SettingsPageHeader
        icon={UserRoundCheck}
        title={t("profile.title")}
        description={t("profile.description")}
      />
      <AccountSettingsSections />
    </SettingsPage>
  );
}
