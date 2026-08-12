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
  Camera,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";

type PageState =
  | { kind: "desktop-only" }
  | { kind: "loading" }
  | { kind: "ready"; identity: DesktopIdentityState };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

const AVATAR_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_AVATAR_FILE_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_DATA_URL_LENGTH = 480 * 1024;

function avatarInitials(name: string, email: string | null): string {
  const source = name.trim() || email?.split("@", 1)[0] || "R";
  const parts = source.split(/\s+/u).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : source.slice(0, 2))
    .toUpperCase();
}

function readAvatarFile(file: File): Promise<string> {
  if (!AVATAR_CONTENT_TYPES.has(file.type)) {
    return Promise.reject(new Error("unsupported_type"));
  }
  if (file.size > MAX_AVATAR_FILE_BYTES) {
    return Promise.reject(new Error("too_large"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_failed"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      if (
        value.length === 0
        || value.length > MAX_AVATAR_DATA_URL_LENGTH
        || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
      ) {
        reject(new Error("too_large"));
        return;
      }
      const encoded = value.slice(value.indexOf(",") + 1);
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const isPng = file.type === "image/png"
        && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
      const isJpeg = file.type === "image/jpeg"
        && bytes.slice(0, 3).every((byte, index) => byte === [255, 216, 255][index]);
      const isWebp = file.type === "image/webp"
        && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
        && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
      if (!isPng && !isJpeg && !isWebp) {
        reject(new Error("invalid_image"));
        return;
      }
      resolve(value);
    };
    reader.readAsDataURL(file);
  });
}

function AccountAvatar({
  name,
  email,
  image,
  ariaLabel,
  onClick,
  disabled,
  pending,
}: {
  name: string;
  email: string | null;
  image: string | null;
  ariaLabel: string;
  onClick: () => void;
  disabled: boolean;
  pending: boolean;
}) {
  return (
    <button
      type="button"
      className="group relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[color:var(--border-soft)] bg-muted text-lg font-semibold text-muted-foreground transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
      aria-label={ariaLabel}
      aria-busy={pending}
      onClick={onClick}
      disabled={disabled}
    >
      {image ? (
        <img src={image} alt="" className="size-full object-cover" />
      ) : (
        avatarInitials(name, email)
      )}
      <span className={`absolute inset-0 flex items-center justify-center bg-foreground/55 text-background transition-opacity ${pending ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}>
        {pending
          ? <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Camera className="size-5" aria-hidden="true" />}
      </span>
    </button>
  );
}

export function AccountAvatarControl({ nickname }: { nickname: string }) {
  const { t } = useI18n();
  const [signedInIdentity, setSignedInIdentity] = useState<Extract<DesktopIdentityState, { status: "signed-in" }> | null>(null);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const identity = readDesktopIdentity();
    if (!identity) return;

    let cancelled = false;
    const applyState = (next: DesktopIdentityState) => {
      if (!cancelled) setSignedInIdentity(next.status === "signed-in" ? next : null);
    };

    const unsubscribe = identity.onStateChanged(applyState);
    void identity.getState().then((state) => {
      applyState(state);
      if (state.status !== "signed-in") return;
      const accountId = state.account.id;
      const deviceId = state.deviceId;
      void identity.getProfile()
        .then((profile) => {
          if (cancelled) return;
          setSignedInIdentity((current) => {
            if (current?.account.id !== accountId || current.deviceId !== deviceId) return current;
            return { ...current, account: profile };
          });
        })
        .catch(() => {
          // The signed-in state already carries a usable account snapshot.
        });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function handleAvatarChange(file: File | undefined) {
    if (!file || !signedInIdentity) return;
    const identity = readDesktopIdentity();
    if (!identity) return;
    const accountId = signedInIdentity.account.id;
    const deviceId = signedInIdentity.deviceId;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      const image = await readAvatarFile(file);
      const account = await identity.updateProfile({ image });
      setSignedInIdentity((current) => {
        if (current?.account.id !== accountId || current.deviceId !== deviceId) return current;
        return { ...current, account };
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const message = code === "unsupported_type"
        ? t("account.avatar.invalidType")
        : code === "too_large"
          ? t("account.avatar.tooLarge")
          : code === "invalid_image" || code === "invalid_avatar"
            ? t("account.avatar.invalidImage")
            : t("account.avatar.saveFailed");
      setAvatarError(message);
    } finally {
      setAvatarPending(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  const account = signedInIdentity?.account ?? null;
  const avatarName = nickname.trim() || account?.name || "Rudder";
  const avatar = (
    <AccountAvatar
      name={avatarName}
      email={account?.email ?? null}
      image={account?.image ?? null}
      ariaLabel={t("account.avatar.change")}
      onClick={() => account && avatarInputRef.current?.click()}
      disabled={!account || avatarPending}
      pending={avatarPending}
    />
  );

  return (
    <div className="flex shrink-0 flex-col items-center gap-2">
      {avatar}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label={t("account.avatar.change")}
        data-testid="account-avatar-input"
        onChange={(event) => void handleAvatarChange(event.target.files?.[0])}
      />
      {avatarError ? <p role="alert" className="max-w-40 text-center text-xs leading-4 text-destructive">{avatarError}</p> : null}
    </div>
  );
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
      />
      <AccountSettingsSections />
    </SettingsPage>
  );
}
