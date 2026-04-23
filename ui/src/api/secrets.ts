import type { OrganizationSecret, SecretProviderDescriptor, SecretProvider } from "@rudder/shared";
import { api } from "./client";

export const secretsApi = {
  list: (orgId: string) => api.get<OrganizationSecret[]>(`/orgs/${orgId}/secrets`),
  providers: (orgId: string) =>
    api.get<SecretProviderDescriptor[]>(`/orgs/${orgId}/secret-providers`),
  create: (
    orgId: string,
    data: {
      name: string;
      value: string;
      provider?: SecretProvider;
      description?: string | null;
      externalRef?: string | null;
    },
  ) => api.post<OrganizationSecret>(`/orgs/${orgId}/secrets`, data),
  rotate: (id: string, data: { value: string; externalRef?: string | null }) =>
    api.post<OrganizationSecret>(`/secrets/${id}/rotate`, data),
  update: (
    id: string,
    data: { name?: string; description?: string | null; externalRef?: string | null },
  ) => api.patch<OrganizationSecret>(`/secrets/${id}`, data),
  remove: (id: string) => api.delete<{ ok: true }>(`/secrets/${id}`),
};
