export function desktopAccountBypassAllowed(options: {
  isPackaged: boolean;
  bypassRequested: boolean;
  packagedSmokeBypassRequested?: boolean;
}): boolean {
  return (!options.isPackaged && options.bypassRequested)
    || (options.isPackaged && options.packagedSmokeBypassRequested === true);
}

export function desktopStartupRequiresAccount(options: {
  isPackaged: boolean;
  bypassRequested: boolean;
  packagedSmokeBypassRequested?: boolean;
  identityStatus: "signed-out" | "signing-in" | "device-authorization" | "signed-in" | "error";
}): boolean {
  return !desktopAccountBypassAllowed(options) && options.identityStatus !== "signed-in";
}
