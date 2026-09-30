import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("OpenCode session codec", () => {
  it("preserves the managed profile data identity through resume serialization", () => {
    const params = {
      sessionId: "ses_native-session",
      hostId: "local",
      profileId: "default",
      profileBindingId: "binding-1",
      profileOrgId: "org-1",
      openCodeProfileDataId: "0a3e1faf4f5416d5a6435c3874d59d06",
      exportEnv: {
        XDG_DATA_HOME: "/managed/opencode/provider-data/0a3e1faf4f5416d5a6435c3874d59d06",
      },
    };

    const decoded = sessionCodec.deserialize(params);

    expect(decoded).toMatchObject({
      openCodeProfileDataId: params.openCodeProfileDataId,
      exportEnv: params.exportEnv,
    });
    expect(sessionCodec.serialize(decoded ?? null)).toMatchObject({
      openCodeProfileDataId: params.openCodeProfileDataId,
      exportEnv: params.exportEnv,
    });
  });
});
