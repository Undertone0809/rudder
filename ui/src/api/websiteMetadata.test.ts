import { beforeEach, describe, expect, it, vi } from "vitest";
import { websiteMetadataApi } from "./websiteMetadata";

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: {
    get: clientMocks.get,
  },
}));

describe("websiteMetadataApi", () => {
  beforeEach(() => {
    clientMocks.get.mockReset();
  });

  it("requests preview metadata by default", async () => {
    await websiteMetadataApi.get("https://example.com/post?tab=details");

    expect(clientMocks.get).toHaveBeenCalledWith(
      "/website-metadata?url=https%3A%2F%2Fexample.com%2Fpost%3Ftab%3Ddetails&purpose=preview",
    );
  });

  it("can explicitly request authoring metadata", async () => {
    await websiteMetadataApi.get("https://example.com/post", "authoring");

    expect(clientMocks.get).toHaveBeenCalledWith(
      "/website-metadata?url=https%3A%2F%2Fexample.com%2Fpost&purpose=authoring",
    );
  });
});
