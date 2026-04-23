export type DesktopCapabilities = {
  badgeCount: boolean;
  notifications: boolean;
};

export function readDesktopCapabilities(
  input: { capabilities?: Partial<DesktopCapabilities> | null } | null | undefined,
): DesktopCapabilities {
  return {
    badgeCount: input?.capabilities?.badgeCount === true,
    notifications: input?.capabilities?.notifications === true,
  };
}
