import { startPostgresOwner } from "./postgres-owner.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

export type MigrationConnection = {
  connectionString: string;
  source: string;
  recoveryDirectory: string;
  postgresBinDir?: string;
  stop: () => Promise<void>;
};

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      recoveryDirectory: target.recoveryDirectory,
      stop: async () => {},
    };
  }

  const owner = await startPostgresOwner({
    instanceId: process.env.RUDDER_INSTANCE_ID?.trim() || "default",
    dataDir: target.dataDir,
    port: target.port,
  });
  return {
    connectionString: owner.connection_string,
    source: `rust-postgres@${owner.port}`,
    recoveryDirectory: target.recoveryDirectory,
    postgresBinDir: owner.bin_dir,
    stop: owner.stop,
  };
}
