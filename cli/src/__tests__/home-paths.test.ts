import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveRudderHomeDir,
  resolveRudderInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.rudder and default instance", () => {
    delete process.env.RUDDER_HOME;
    delete process.env.RUDDER_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".rudder"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".rudder", "instances", "default", "config.json"));
  });

  it("supports RUDDER_HOME and explicit instance ids", () => {
    process.env.RUDDER_HOME = "~/rudder-home";

    const home = resolveRudderHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "rudder-home"));
    expect(resolveRudderInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveRudderInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
