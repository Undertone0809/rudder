import { describe, expect, it } from "vitest";
import { chatBindingInstructionsRevision } from "./chat-assistant.binding-revision.js";
import { revisionForRuntimeConfig } from "./runtime-kernel/native-session.js";

const methods = { threadResume: true, threadRead: true, threadFork: true };
const oldConfig = {
  model: "gpt-6-luna", reasoningEffort: "max", cwd: "/workspace", codexHome: "/profile",
  providerVersion: "0.158.0-alpha.2.1", command: "/bin/codex", profileId: "default",
  instructionsFilePath: "/instructions/AGENTS.md", promptTemplate: "{{context.chatPrompt}}",
  dangerouslyBypassApprovalsAndSandbox: false, chatAppServerEnabled: true,
  rudderRuntimeSkills: [{ key: "skill", path: "/skills/skill" }],
  nativeCapabilityMethods: methods,
};
const newConfig = { ...oldConfig, nativeCapabilityMethods: { ...methods, threadItemsList: true, threadTurnsList: true } };
const legacy = (config: Record<string, unknown>) => revisionForRuntimeConfig(config, ["apiKey", "authToken", "token", "password"]);
const revision = (config: Record<string, unknown>, existingRevision?: string) => chatBindingInstructionsRevision({
  runtimeType: "codex_local", config, existingRevision,
});

describe("Chat binding semantic config revision", () => {
  it("proves the legacy three-method alias using the entire prepared config", () => {
    const oldRevision = legacy(oldConfig);
    expect(legacy(newConfig)).not.toBe(oldRevision);
    expect(revision(newConfig, oldRevision)).toBe(oldRevision);
    expect(revision(oldConfig, oldRevision)).toBe(oldRevision);
    expect(revision(newConfig, legacy(newConfig))).toBe(legacy(newConfig));
    expect(newConfig.nativeCapabilityMethods).toHaveProperty("threadItemsList", true);
  });

  it("keeps new versioned identity independent of discovered methods", () => {
    const stable = revision(oldConfig);
    expect(stable).toMatch(/^codex-chat-config-v1:[a-f0-9]{64}$/);
    expect(revision(newConfig, stable)).toBe(stable);
    expect(revision({ ...newConfig, nativeCapabilityMethods: { ...methods, threadReadFullSnapshot: true } }, stable)).toBe(stable);
  });

  it.each([
    ["model", "other-model"], ["reasoningEffort", "low"], ["cwd", "/another-workspace"],
    ["codexHome", "/another-profile"], ["profileId", "another-profile"], ["command", "/other/codex"],
    ["providerVersion", "1.0.0"], ["instructionsFilePath", "/instructions/NEW.md"],
    ["promptTemplate", "Different instructions"], ["dangerouslyBypassApprovalsAndSandbox", true],
    ["chatAppServerEnabled", false], ["rudderRuntimeSkills", [{ key: "other-skill" }]],
    ["env", { CODEX_HOME: "/another-profile" }],
  ])("does not alias semantic drift in %s", (key, value) => {
    const changed = { ...newConfig, [key as string]: value };
    expect(revision(changed, legacy(oldConfig))).not.toBe(legacy(oldConfig));
    expect(revision(changed, revision(oldConfig))).not.toBe(revision(oldConfig));
  });

  it("does not guess absent, unknown, malformed or changed legacy capability layouts", () => {
    const oldRevision = legacy(oldConfig);
    expect(revision(newConfig, "unrecoverable-old-hash")).toBe(revision(newConfig));
    expect(revision(newConfig, legacy({ ...oldConfig, nativeCapabilityMethods: undefined }))).not.toBe(
      legacy({ ...oldConfig, nativeCapabilityMethods: undefined }),
    );
    for (const map of [
      { ...newConfig.nativeCapabilityMethods, threadResume: false },
      { ...newConfig.nativeCapabilityMethods, unknownMethod: true },
      { ...newConfig.nativeCapabilityMethods, threadRead: "true" },
    ]) expect(revision({ ...newConfig, nativeCapabilityMethods: map }, oldRevision)).not.toBe(oldRevision);
  });

  it("leaves other runtime identities unchanged", () => {
    expect(chatBindingInstructionsRevision({ runtimeType: "hermes_gateway", config: oldConfig }))
      .toBe(legacy(oldConfig));
  });
});
