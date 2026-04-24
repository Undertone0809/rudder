import type {
  OrganizationSkill,
  OrganizationSkillLocalScanRequest,
  OrganizationSkillLocalScanResult,
  OrganizationSkillCreateRequest,
  OrganizationSkillDetail,
  OrganizationSkillFileDetail,
  OrganizationSkillImportResult,
  OrganizationSkillListItem,
  OrganizationSkillProjectScanRequest,
  OrganizationSkillProjectScanResult,
  OrganizationSkillUpdateStatus,
} from "@rudderhq/shared";
import { api } from "./client";

export const organizationSkillsApi = {
  list: (orgId: string) =>
    api.get<OrganizationSkillListItem[]>(`/orgs/${encodeURIComponent(orgId)}/skills`),
  detail: (orgId: string, skillId: string) =>
    api.get<OrganizationSkillDetail>(
      `/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  updateStatus: (orgId: string, skillId: string) =>
    api.get<OrganizationSkillUpdateStatus>(
      `/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}/update-status`,
    ),
  file: (orgId: string, skillId: string, relativePath: string) =>
    api.get<OrganizationSkillFileDetail>(
      `/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(relativePath)}`,
    ),
  updateFile: (orgId: string, skillId: string, path: string, content: string) =>
    api.patch<OrganizationSkillFileDetail>(
      `/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}/files`,
      { path, content },
    ),
  create: (orgId: string, payload: OrganizationSkillCreateRequest) =>
    api.post<OrganizationSkill>(
      `/orgs/${encodeURIComponent(orgId)}/skills`,
      payload,
    ),
  delete: (orgId: string, skillId: string) =>
    api.delete<OrganizationSkill>(
      `/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  importFromSource: (orgId: string, source: string) =>
    api.post<OrganizationSkillImportResult>(
      `/orgs/${encodeURIComponent(orgId)}/skills/import`,
      { source },
    ),
  scanProjects: (orgId: string, payload: OrganizationSkillProjectScanRequest = {}) =>
    api.post<OrganizationSkillProjectScanResult>(
      `/orgs/${encodeURIComponent(orgId)}/skills/scan-projects`,
      payload,
    ),
  scanLocal: (orgId: string, payload: OrganizationSkillLocalScanRequest = {}) =>
    api.post<OrganizationSkillLocalScanResult>(
      `/orgs/${encodeURIComponent(orgId)}/skills/scan-local`,
      payload,
    ),
  installUpdate: (orgId: string, skillId: string) =>
    api.post<OrganizationSkill>(
      `/orgs/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(skillId)}/install-update`,
      {},
    ),
};
