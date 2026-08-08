import path from "node:path";
import { buildDesktopApiRequestUrl } from "./api-url.js";

type DesktopApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function resolveAppBuilderWorkspaceRoot(options: {
  apiBaseUrl: string;
  organizationId: string;
  fetchApi: DesktopApiFetch;
}): Promise<string> {
  const response = await options.fetchApi(
    buildDesktopApiRequestUrl(
      options.apiBaseUrl,
      `/orgs/${encodeURIComponent(options.organizationId)}/workspace/files`,
    ),
    {
      headers: { Accept: "application/json" },
      credentials: "include",
    },
  );
  if (!response.ok) {
    throw new Error(`Unable to resolve the App Builder workspace (${response.status})`);
  }
  const workspace = await response.json() as { rootPath?: unknown };
  const root = workspace.rootPath;
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("The organization workspace is not available on this device.");
  }
  return root;
}
