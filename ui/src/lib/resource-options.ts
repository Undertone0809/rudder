import {
  ORGANIZATION_RESOURCE_KINDS,
  PROJECT_RESOURCE_ATTACHMENT_ROLES,
  type OrganizationResourceKind,
  type ProjectResourceAttachmentRole,
} from "@rudder/shared";

export const organizationResourceKindOptions: Array<{
  value: OrganizationResourceKind;
  label: string;
}> = [
  { value: "directory", label: "Directory" },
  { value: "file", label: "File" },
  { value: "url", label: "URL" },
  { value: "connector_object", label: "Connector object" },
];

export const projectResourceRoleOptions: Array<{
  value: ProjectResourceAttachmentRole;
  label: string;
}> = [
  { value: "working_set", label: "Working set" },
  { value: "reference", label: "Reference" },
  { value: "tracking", label: "Tracking" },
  { value: "deliverable", label: "Deliverable" },
  { value: "background", label: "Background" },
];

export function organizationResourceKindLabel(kind: OrganizationResourceKind) {
  return organizationResourceKindOptions.find((option) => option.value === kind)?.label
    ?? kind.replace(/_/g, " ");
}

export function isLocalPathOrganizationResourceKind(kind: OrganizationResourceKind) {
  return kind === "directory" || kind === "file";
}

export function organizationResourceLocatorPlaceholder(kind: OrganizationResourceKind) {
  switch (kind) {
    case "directory":
      return "~/projects/rudder or https://linear.app/acme/project/...";
    case "file":
      return "~/projects/rudder/README.md or /Users/you/projects/rudder/README.md";
    case "connector_object":
      return "linear://project/123 or github://repo/acme/rudder";
    case "url":
    default:
      return "https://linear.app/acme/project/...";
  }
}

export function projectResourceRoleLabel(role: ProjectResourceAttachmentRole) {
  return projectResourceRoleOptions.find((option) => option.value === role)?.label
    ?? role.replace(/_/g, " ");
}

export function isOrganizationResourceKind(value: string): value is OrganizationResourceKind {
  return (ORGANIZATION_RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isProjectResourceRole(value: string): value is ProjectResourceAttachmentRole {
  return (PROJECT_RESOURCE_ATTACHMENT_ROLES as readonly string[]).includes(value);
}
