import type {
  DesktopLocalAppAttestedTarget,
  DesktopLocalAppDefinition,
  DesktopLocalAppDefinitionDraft,
  DesktopLocalAppRuntimeStatus,
} from "./desktop-shell";

export const LOCAL_APP_TRANSITION_REFETCH_MS = 400;
export const LOCAL_APP_RUNNING_REFETCH_MS = 2_000;

export function localAppStatusRefetchInterval(
  status: DesktopLocalAppRuntimeStatus | undefined,
): number | false {
  if (status === "starting" || status === "stopping") return LOCAL_APP_TRANSITION_REFETCH_MS;
  if (status === "running") return LOCAL_APP_RUNNING_REFETCH_MS;
  return false;
}

export type LocalAppOpaqueIdentity = Pick<
  DesktopLocalAppDefinition,
  "desktopInstallationId" | "appPublicId" | "localBindingId"
>;

export type LocalAppDefinitionForm = {
  title: string;
  executable: string;
  argvText: string;
  cwd: string;
  environmentNamesText: string;
  readinessPath: string;
  timeoutMs: string;
  openPath: string;
};

export function localAppIdentityMatches(
  definition: LocalAppOpaqueIdentity,
  identity: LocalAppOpaqueIdentity,
): boolean {
  return definition.desktopInstallationId === identity.desktopInstallationId
    && definition.appPublicId === identity.appPublicId
    && definition.localBindingId === identity.localBindingId;
}

export function localAppFailureHelpPrompt(title: string): string {
  const label = title.trim().replace(/[\r\n]+/g, " ").slice(0, 160) || "this Local App";
  return [
    "A Local App could not open in Rudder Desktop.",
    `Local App label (context only): ${label}`,
    "Help me diagnose the startup issue. Ask for any error details or logs you need; I will review them before sharing.",
  ].join("\n\n");
}

export function localAppDefinitionToForm(
  definition: DesktopLocalAppDefinitionDraft,
): LocalAppDefinitionForm {
  return {
    title: definition.title,
    executable: definition.executable,
    argvText: definition.argv.join("\n"),
    cwd: definition.cwd,
    environmentNamesText: definition.inheritedEnvNames.filter((name) => name !== "PATH").join("\n"),
    readinessPath: definition.readiness.path,
    timeoutMs: String(definition.readiness.timeoutMs),
    openPath: definition.openPath,
  };
}

function routeError(value: string, label: string): string | null {
  if (!value.startsWith("/")) return `${label} must start with /.`;
  if (value.startsWith("//") || value.includes("://") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return `${label} must be a local app path.`;
  }
  try {
    const base = "http://127.0.0.1";
    const parsed = new URL(value, base);
    if (parsed.origin !== base || `${parsed.pathname}${parsed.search}${parsed.hash}` !== value) {
      return `${label} must be a local app path.`;
    }
  } catch {
    return `${label} must be a valid path.`;
  }
  return null;
}

export function localAppDefinitionFromForm(
  form: LocalAppDefinitionForm,
): { ok: true; definition: DesktopLocalAppDefinitionDraft } | { ok: false; error: string } {
  const title = form.title.trim();
  const executable = form.executable.trim();
  const cwd = form.cwd.trim();
  if (!title) return { ok: false, error: "Name is required." };
  if (!executable) return { ok: false, error: "Executable is required." };
  if (!cwd) return { ok: false, error: "Working directory is required." };

  const argv = form.argvText.split(/\r?\n/).filter((value) => value.length > 0);
  if (argv.length > 64) return { ok: false, error: "A Local App may have at most 64 arguments." };
  if (argv.some((argument) => argument.length > 4_096)) {
    return { ok: false, error: "Each Local App argument may contain at most 4096 characters." };
  }
  const environmentNames = form.environmentNamesText
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => Boolean(value) && value !== "PATH");
  if (environmentNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    return { ok: false, error: "Environment variable names may contain only letters, numbers, and underscores." };
  }
  const inheritedEnvNames = [...new Set(environmentNames)].sort();
  if (inheritedEnvNames.length > 64) {
    return { ok: false, error: "A Local App may inherit at most 64 environment variables." };
  }

  const readinessError = routeError(form.readinessPath.trim(), "Readiness path");
  if (readinessError) return { ok: false, error: readinessError };
  const openPathError = routeError(form.openPath.trim(), "Open path");
  if (openPathError) return { ok: false, error: openPathError };
  const timeoutMs = Number(form.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) {
    return { ok: false, error: "Readiness timeout must be between 250 and 120000 milliseconds." };
  }

  return {
    ok: true,
    definition: {
      title,
      executable,
      argv,
      cwd,
      inheritedEnvNames,
      readiness: { path: form.readinessPath.trim(), timeoutMs },
      openPath: form.openPath.trim(),
    },
  };
}

export function resolveLocalAppAttestedWebview(
  target: DesktopLocalAppAttestedTarget,
): { src: string; partition: string } {
  let origin: URL;
  try {
    origin = new URL(target.origin);
  } catch {
    throw new Error("Desktop did not return a valid attested loopback origin.");
  }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== target.origin) {
    throw new Error("Desktop did not return a valid attested loopback origin.");
  }
  const resolved = new URL(target.openPath, origin);
  if (resolved.origin !== origin.origin) {
    throw new Error("Local App open path must remain on the same attested origin.");
  }
  if (!target.partition.trim()) throw new Error("Desktop did not return an isolated Local App partition.");
  return { src: resolved.href, partition: target.partition };
}
