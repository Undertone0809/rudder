import { loadServerRuntimeModule } from "./server-entry.js";
import { resolveCliVersion } from "../version.js";

type DatabaseRuntimeModule = {
  checkDatabaseConnection?: (dbUrl: string) => Promise<void>;
};

export async function checkPostgresConnection(connectionString: string): Promise<void> {
  const version = resolveCliVersion(import.meta.url);
  const runtimeModule = await loadServerRuntimeModule({
    version: version === "0.0.0" ? "latest" : version,
  }) as DatabaseRuntimeModule;
  if (typeof runtimeModule.checkDatabaseConnection !== "function") {
    throw new Error("Rudder server runtime did not export checkDatabaseConnection().");
  }
  await runtimeModule.checkDatabaseConnection(connectionString);
}
