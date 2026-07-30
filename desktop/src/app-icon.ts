export function shouldOverrideDesktopDockIcon(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): boolean {
  // Packaged macOS apps already expose their canonical .icns icon to the Dock.
  // Replacing it at runtime with the cross-platform PNG drops the macOS-shaped
  // background and makes the icon visibly change as soon as the app launches.
  return platform === "darwin" && !isPackaged;
}
