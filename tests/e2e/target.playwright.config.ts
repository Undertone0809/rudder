import baseConfig from "./playwright.config";

export default {
  ...baseConfig,
  testDir: "/Users/zeeland/projects/rudder-oss/tests/e2e",
  testMatch: "chat-response-annotations.spec.ts",
};
