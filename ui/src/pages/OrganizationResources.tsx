import { OrganizationWorkspaceBrowser } from "./OrganizationWorkspaces";

export function OrganizationResources() {
  return (
    <OrganizationWorkspaceBrowser
      breadcrumbLabel="Docs"
      emptyMessage="Select an organization to browse Docs."
      editorTitle="File editor"
      noSelectionMessage="Choose a Markdown, CSV, JSON, HTML, skill, or workspace file from the Docs tree. Humans and agents share this file-native space."
    />
  );
}
