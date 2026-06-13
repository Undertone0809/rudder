import type { Db } from "@rudderhq/db";
import type { StorageService } from "../../storage/types.js";
import { accessService } from "../access.js";
import { agentInstructionsService } from "../agent-instructions.js";
import { agentService } from "../agents.js";
import { assetService } from "../assets.js";
import { issueService } from "../issues.js";
import { organizationSkillService } from "../organization-skills.js";
import { organizationService } from "../orgs.js";
import { projectService } from "../projects.js";
import { createOrganizationPortabilityExportHandlers } from "./organization-portability.export.js";
import { createOrganizationPortabilityImportHandlers } from "./organization-portability.import.js";
import { createOrganizationPortabilityPreviewHandlers } from "./organization-portability.preview.js";

export type { OrganizationPortabilityExportOptions } from "./organization-portability.core.js";
export { parseGitHubSourceUrl } from "./organization-portability.package.js";

export function organizationPortabilityService(db: Db, storage?: StorageService) {
  const organizations = organizationService(db);
  const agents = agentService(db);
  const assetRecords = assetService(db);
  const instructions = agentInstructionsService();
  const access = accessService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const organizationSkills = organizationSkillService(db);

  const exportHandlers = createOrganizationPortabilityExportHandlers({
    db,
    storage,
    organizations,
    agents,
    assetRecords,
    instructions,
    organizationSkills,
  });
  const previewHandlers = createOrganizationPortabilityPreviewHandlers({
    organizations,
    agents,
    projects,
    organizationSkills,
  });
  const importHandlers = createOrganizationPortabilityImportHandlers({
    db,
    storage,
    access,
    organizations,
    agents,
    assetRecords,
    instructions,
    projects,
    issues,
    organizationSkills,
    buildPreview: previewHandlers.buildPreview,
  });

  return {
    exportBundle: exportHandlers.exportBundle,
    previewExport: exportHandlers.previewExport,
    previewImport: previewHandlers.previewImport,
    importBundle: importHandlers.importBundle,
  };
}
