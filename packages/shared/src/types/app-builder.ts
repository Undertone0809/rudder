export type AppBuilderBuildStatus =
  | "preparing"
  | "building"
  | "verified_source_ready"
  | "verifying"
  | "ready"
  | "launch_failed"
  | "failed";

export interface AppBuilderApp {
  id: string;
  orgId: string;
  projectId: string | null;
  conversationId: string | null;
  name: string;
  sourceRoot: string;
  scaffoldVersion: string;
  buildStatus: AppBuilderBuildStatus;
  latestBuildRunId: string | null;
  latestVerificationRunId: string | null;
  desktopInstallationId: string | null;
  appPublicId: string | null;
  localBindingId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppBuilderOpaqueBinding {
  desktopInstallationId: string;
  appPublicId: string;
  localBindingId: string;
}
