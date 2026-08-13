export const PACKAGED_LOCAL_APPS_ERROR_CODE = "DOGFOOD_ACCOUNT_REQUIRED";

export function assertSmokeScenarioSupported(mode, scenario) {
  if (mode !== "packaged" || scenario !== "local-apps") return;

  const error = new Error(
    "Packaged Local Apps smoke requires an authenticated Desktop account "
      + `(${PACKAGED_LOCAL_APPS_ERROR_CODE}); run the packaged account-gate scenario `
      + "or run Local Apps smoke in dev mode.",
  );
  error.code = PACKAGED_LOCAL_APPS_ERROR_CODE;
  throw error;
}
