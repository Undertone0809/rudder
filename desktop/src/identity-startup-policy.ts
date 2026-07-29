export function desktopAccountBypassAllowed(options: {
  isPackaged: boolean;
  bypassRequested: boolean;
}): boolean {
  return !options.isPackaged && options.bypassRequested;
}

export function desktopStartupRequiresAccount(options: {
  isPackaged: boolean;
  bypassRequested: boolean;
  identityStatus: "signed-out" | "signing-in" | "device-authorization" | "signed-in" | "error";
}): boolean {
  return !desktopAccountBypassAllowed(options) && options.identityStatus !== "signed-in";
}
