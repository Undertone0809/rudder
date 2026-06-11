import { OrganizationWorkspaceBrowser } from "./OrganizationWorkspaces";
import { useI18n } from "../context/I18nContext";
import { libraryCopy } from "../lib/library-copy";

export function OrganizationResources() {
  const { locale } = useI18n();
  return (
    <OrganizationWorkspaceBrowser
      breadcrumbLabel={libraryCopy("library", locale)}
      emptyMessage={locale === "zh-CN" ? "选择一个组织来浏览文档。" : "Select an organization to browse Library."}
      editorTitle="File editor"
      noSelectionMessage="Select a file to preview or edit."
    />
  );
}
