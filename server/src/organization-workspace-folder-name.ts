const ORGANIZATION_WORKSPACE_FOLDER_RE = /^[a-zA-Z0-9._-]+$/;

export function validateOrganizationWorkspaceFolderName(value: string): string {
  const folderName = value.trim();
  if (folderName !== value) {
    throw new Error("Organization workspace folder mapping must not contain leading or trailing whitespace.");
  }
  if (
    !ORGANIZATION_WORKSPACE_FOLDER_RE.test(folderName)
    || folderName === "."
    || folderName === ".."
    || folderName.endsWith(".")
  ) {
    throw new Error(`Invalid organization workspace folder for workspace path '${value}'.`);
  }
  return folderName;
}
