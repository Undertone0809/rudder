import { api } from "./client";

export interface WebsiteMetadata {
  url: string;
  siteName: string | null;
  pageTitle: string | null;
  iconUrl: string | null;
}

export type WebsiteMetadataPurpose = "preview" | "authoring";

export const websiteMetadataApi = {
  get: (url: string, purpose: WebsiteMetadataPurpose = "preview") =>
    api.get<WebsiteMetadata>(
      `/website-metadata?url=${encodeURIComponent(url)}&purpose=${encodeURIComponent(purpose)}`,
    ),
};
