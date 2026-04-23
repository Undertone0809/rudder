import type { SidebarBadges } from "@rudder/shared";
import { api } from "./client";

export const sidebarBadgesApi = {
  get: (orgId: string) => api.get<SidebarBadges>(`/orgs/${orgId}/sidebar-badges`),
};
