import { OrganizationWorkspaceBrowser } from "./OrganizationWorkspaces";

export function OrganizationResources() {
  return (
    <OrganizationWorkspaceBrowser
      breadcrumbLabel="Library"
      emptyMessage="Select an organization to browse its Library."
      filesTitle="File tree"
      editorTitle="File editor"
      noSelectionMessage="Choose a Markdown, CSV, JSON, HTML, skill, or workspace file from the Library tree. Humans and agents share this file-native space."
    />
  );
}
