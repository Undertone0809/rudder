export function shouldStartAutomaticBackupSchedulers(localEnv: string | null | undefined): boolean {
  const normalized = localEnv?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  return normalized === "prod_local" || normalized === "production";
}
