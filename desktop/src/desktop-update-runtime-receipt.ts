import path from "node:path";
import type { DesktopAutoUpdateCandidate } from "./desktop-auto-update-state.js";
import { resolveDesktopOwnedPorts, type LocalEnvProfile } from "./desktop-local-env.js";
import {
  desktopUpdateRuntimeReceiptsMatch,
  resolveDesktopUpdateRuntimeReceipt,
  resolveDesktopUpdateTransactionPaths,
  type DesktopUpdateHelperRequest,
  type DesktopUpdateJournalSnapshot,
  type DesktopUpdateRuntimeReceipt,
  type HelperAttestation,
} from "./desktop-update-helper.js";
import { resolveSharedRudderHomeDir } from "./runtime-cache.js";

type AutomaticUpdateRuntimeContext = {
  getBootState: () => any;
  getRuntimeReceipt?: () => DesktopUpdateRuntimeReceipt;
  isAutomaticUpdateAllowed?: () => boolean;
  hasExternalUpdateHelperCapability?: () => boolean;
  hasSignedUpdatePolicyCapability?: () => boolean;
};

export function createAutomaticDesktopUpdateRuntimeContext(input: {
  context: AutomaticUpdateRuntimeContext;
  isPackaged: () => boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}) {
  const { context } = input;

  function automaticRuntimeIdentity(): { profile: string | null; instanceId: string | null } {
    const runtime = context.getBootState()?.runtime ?? {};
    return {
      profile: typeof runtime.localEnv === "string"
        ? runtime.localEnv
        : (input.env.RUDDER_LOCAL_ENV?.trim() || null),
      instanceId: typeof runtime.instanceId === "string"
        ? runtime.instanceId
        : (input.env.RUDDER_INSTANCE_ID?.trim() || null),
    };
  }

  function automaticRuntimeReceipt(): DesktopUpdateRuntimeReceipt | null {
    if (context.getRuntimeReceipt) return context.getRuntimeReceipt();
    const identity = automaticRuntimeIdentity();
    if (identity.profile !== "prod_local" || identity.instanceId !== "default") return null;
    const profile: LocalEnvProfile = {
      name: "prod_local",
      instanceId: "default",
      port: "3200",
      embeddedPostgresPort: "54339",
    };
    const instanceRoot = context.getBootState()?.paths?.instanceRoot
      ?? path.join(resolveSharedRudderHomeDir(input.env), "instances", profile.instanceId);
    return resolveDesktopUpdateRuntimeReceiptForProfile(profile, instanceRoot, input.env);
  }

  function automaticUpdateScopeAllowed(): boolean {
    if (!input.isPackaged() || input.platform !== "darwin" || context.isAutomaticUpdateAllowed?.() === false) return false;
    const identity = automaticRuntimeIdentity();
    return identity.profile === "prod_local" && identity.instanceId === "default";
  }

  function automaticUpdatePrerequisitesAvailable(): boolean {
    return automaticUpdateScopeAllowed()
      && context.hasExternalUpdateHelperCapability?.() === true;
  }

  function automaticUpdateCapabilityAvailable(): boolean {
    return automaticUpdatePrerequisitesAvailable()
      && context.hasSignedUpdatePolicyCapability?.() === true;
  }

  return {
    automaticRuntimeIdentity,
    automaticRuntimeReceipt,
    automaticUpdateScopeAllowed,
    automaticUpdatePrerequisitesAvailable,
    automaticUpdateCapabilityAvailable,
  };
}

export function resolveDesktopUpdateRuntimeReceiptForProfile(
  profile: LocalEnvProfile,
  instanceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopUpdateRuntimeReceipt {
  const ports = resolveDesktopOwnedPorts(profile, env);
  return resolveDesktopUpdateRuntimeReceipt({
    instanceRoot,
    instanceId: profile.instanceId,
    apiPort: Number(ports.port),
    postgresPort: Number(ports.embeddedPostgresPort),
  });
}

export function createBoundDesktopUpdateRecoveryRequest(input: {
  journal: DesktopUpdateJournalSnapshot;
  candidate: DesktopAutoUpdateCandidate;
  helper: HelperAttestation | null;
  userDataPath: string;
  resourcesPath?: string;
  execPath?: string;
  runtimeReceipt: DesktopUpdateRuntimeReceipt;
}): DesktopUpdateHelperRequest | null {
  const { journal, candidate, helper, userDataPath, resourcesPath, execPath, runtimeReceipt } = input;
  const expectedPaths = resolveDesktopUpdateTransactionPaths({
    userDataPath,
    transactionId: journal.transactionId,
    resourcesPath,
    execPath,
  });
  const journalHelper = journal.helper;
  const helperMatchesJournal = Boolean(helper && journalHelper
    && helper.path === journalHelper.path
    && helper.ownerUid === journalHelper.ownerUid
    && helper.mode === journalHelper.mode
    && helper.sha256 === journalHelper.sha256);
  const journalPathsMatch = journal.installPath === expectedPaths.installPath
    && journal.lkgPath === expectedPaths.lkgPath
    && journal.checkpointPath === expectedPaths.checkpointPath
    && journal.stagedPath === candidate.stagedArtifactPath;
  const journalCandidateMatch = journal.candidateSha256 === candidate.stagedArtifactDigest
    && journal.targetVersion === candidate.version;
  const journalRuntimeReceiptMatch = desktopUpdateRuntimeReceiptsMatch(journal.runtimeReceipt, runtimeReceipt);
  if (!helper || !helperMatchesJournal || !journalPathsMatch || !journalCandidateMatch || !journal.ownerToken
    || !journal.admission || !journal.checkpoint || !journal.installPath
    || !journal.stagedPath || !journal.lkgPath || !journal.checkpointPath || !journalRuntimeReceiptMatch
    || !journal.targetVersion || !journal.candidateSha256) {
    return null;
  }

  return {
    operation: "recover",
    ownerToken: journal.ownerToken,
    transactionId: journal.transactionId,
    installPath: journal.installPath,
    stagedPath: journal.stagedPath,
    lkgPath: journal.lkgPath,
    journalPath: expectedPaths.journalPath,
    checkpointPath: journal.checkpointPath,
    ...(journal.statePath ? { statePath: journal.statePath } : {}),
    targetVersion: journal.targetVersion,
    candidateSha256: journal.candidateSha256,
    admission: journal.admission,
    checkpoint: journal.checkpoint,
    runtimeReceipt: journal.runtimeReceipt!,
    helper: journalHelper!,
    probation: {
      executable: path.join(journal.installPath, "Contents", "MacOS", "Rudder"),
      args: ["--rudder-update-probation"],
      timeoutMs: 10_000,
    },
  };
}
