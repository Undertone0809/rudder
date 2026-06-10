import { OrganizationWorkspaceBrowser } from "./OrganizationWorkspaces";

export function OrganizationResources() {
  return (
    <OrganizationWorkspaceBrowser
      breadcrumbLabel="Library"
      emptyMessage="Select an organization to browse Library."
      editorTitle="File editor"
      noSelectionMessage="Select a file to preview or edit."
    />
  );
}
