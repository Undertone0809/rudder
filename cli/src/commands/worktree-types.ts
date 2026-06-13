type WorktreeInitOptions = {
  name?: string;
  instance?: string;
  home?: string;
  fromConfig?: string;
  fromDataDir?: string;
  fromInstance?: string;
  sourceConfigPathOverride?: string;
  serverPort?: number;
  dbPort?: number;
  seed?: boolean;
  seedMode?: string;
  force?: boolean;
};

type WorktreeMakeOptions = WorktreeInitOptions & {
  startPoint?: string;
};

type WorktreeEnvOptions = {
  config?: string;
  json?: boolean;
};

type WorktreeListOptions = {
  json?: boolean;
};

type WorktreeMergeHistoryOptions = {
  from?: string;
  to?: string;
  company?: string;
  scope?: string;
  apply?: boolean;
  dry?: boolean;
  yes?: boolean;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

type EmbeddedPostgresHandle = {
  port: number;
  startedByThisProcess: boolean;
  stop: () => Promise<void>;
};

type GitWorkspaceInfo = {
  root: string;
  commonDir: string;
  gitDir: string;
  hooksPath: string;
};

type CopiedGitHooksResult = {
  sourceHooksPath: string;
  targetHooksPath: string;
  copied: boolean;
};

type SeedWorktreeDatabaseResult = {
  backupSummary: string;
  reboundWorkspaces: Array<{
    name: string;
    fromCwd: string;
    toCwd: string;
  }>;
};

export type {
  CopiedGitHooksResult,
  EmbeddedPostgresCtor,
  EmbeddedPostgresHandle,
  GitWorkspaceInfo,
  SeedWorktreeDatabaseResult,
  WorktreeEnvOptions,
  WorktreeInitOptions,
  WorktreeListOptions,
  WorktreeMakeOptions,
  WorktreeMergeHistoryOptions
};
