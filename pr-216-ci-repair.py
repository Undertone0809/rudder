from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
expected_head = 'c5393f5c5bfd32d8104ff41dac3f350c182f5b4d'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == expected_head
changed = set()

def edit(path, before, after):
    target = root / path
    source = target.read_text()
    assert source.count(before) == 1, (path, source.count(before), before[:150])
    target.write_text(source.replace(before, after))
    changed.add(path)

# Keep the cheap feature gate outside a redundant memo, reducing the oversized
# views without weakening the architecture baseline or moving unrelated code.
for path in ['ui/src/pages/Chat.tsx', 'ui/src/components/MessengerContextSidebar.tsx']:
    edit(path, '''  const canRegenerateChatTitles = useMemo(() => {
    const profiles = intelligenceProfilesQuery.data ?? [];
    return isOrganizationIntelligenceEnabled(profiles, "lightweight");
  }, [intelligenceProfilesQuery.data]);''', '''  const canRegenerateChatTitles =
    isOrganizationIntelligenceEnabled(intelligenceProfilesQuery.data, "lightweight");''')

edit('ui/src/components/OnboardingWizard.runtime-config.test.tsx',
     'it("defaults Codex onboarding to GPT-5.6-sol",',
     'it("defaults Codex onboarding to GPT-5.6 Luna with Medium reasoning",')
edit('ui/src/components/OnboardingWizard.runtime-config.test.tsx',
     '    expect(findButton(surface, "GPT-5.6-sol")).toBeTruthy();',
     '    expect(findButton(surface, "GPT-5.6-luna")).toBeTruthy();\n    expect(findButton(surface, "Medium")).toBeTruthy();')

# Put creation-time model/effort defaults next to the execution defaults; retain
# explicit modern/legacy overrides and leave permission flags in their owner.
path = 'packages/agent-runtimes/codex-local/src/defaults.ts'
source = (root / path).read_text()
assert 'withCodexLocalModelDefaults' not in source
(root / path).write_text(source + '''
/** Fill omitted creation settings without mutating caller-owned configuration. */
export function withCodexLocalModelDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  if (!nonEmptyString(next.model)) next.model = DEFAULT_CODEX_LOCAL_MODEL;
  if (!nonEmptyString(next.modelReasoningEffort) && !nonEmptyString(next.reasoningEffort)) {
    next.modelReasoningEffort = DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
  }
  return next;
}
''')
changed.add(path)
edit('packages/agent-runtimes/codex-local/src/index.ts',
     '  resolveCodexLocalReasoningEffort,\n} from "./defaults.js";',
     '  resolveCodexLocalReasoningEffort,\n  withCodexLocalModelDefaults,\n} from "./defaults.js";')
edit('server/src/routes/agents.ts',
     '  DEFAULT_CODEX_LOCAL_MODEL,\n  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,\n',
     '  withCodexLocalModelDefaults,\n')
edit('server/src/routes/agents.ts', '''  function applyCreateDefaultsByAdapterType(
    agentRuntimeType: string | null | undefined,
    agentRuntimeConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...agentRuntimeConfig };
    if (agentRuntimeType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_LOCAL_MODEL;
      }
      if (!asNonEmptyString(next.modelReasoningEffort) && !asNonEmptyString(next.reasoningEffort)) {
        next.modelReasoningEffort = DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
      }''', '''  function applyCreateDefaultsByAdapterType(
    agentRuntimeType: string | null | undefined,
    agentRuntimeConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = agentRuntimeType === "codex_local"
      ? withCodexLocalModelDefaults(agentRuntimeConfig)
      : { ...agentRuntimeConfig };
    if (agentRuntimeType === "codex_local") {''')
edit('packages/agent-runtimes/codex-local/src/defaults.test.ts',
     '  resolveCodexLocalReasoningEffort,\n} from "./defaults.js";',
     '  resolveCodexLocalReasoningEffort,\n  withCodexLocalModelDefaults,\n} from "./defaults.js";')
path = 'packages/agent-runtimes/codex-local/src/defaults.test.ts'
with (root / path).open('a') as handle:
    handle.write('''
describe("Codex creation model defaults", () => {
  it("fills blank settings without changing the input or unrelated controls", () => {
    const source = { model: "  ", reasoningEffort: "", search: false, env: { KEY: "value" } };
    expect(withCodexLocalModelDefaults(source)).toEqual({
      ...source,
      model: "gpt-5.6-luna",
      modelReasoningEffort: "medium",
    });
    expect(source.model).toBe("  ");
    expect(source).not.toHaveProperty("modelReasoningEffort");
  });

  it.each([
    { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" },
    { model: "gpt-5.5", reasoningEffort: "high" },
  ])("preserves explicit model/effort settings: %j", (config) => {
    expect(withCodexLocalModelDefaults(config)).toEqual(config);
  });
});
''')
changed.add(path)

# Canonical disabled/invalid settings must win over retained legacy rows even
# during mixed-version rollout. This must not re-enable a disabled feature.
edit('ui/src/lib/organization-intelligence.ts', '''  return (profiles ?? []).some((profile) => {
    if (!profile || profile.status !== "configured") return false;
    return profile.purpose === "default" || profile.purpose === legacyPurpose;
  });''', '''  const canonical = profiles?.find((profile) => profile?.purpose === "default");
  if (canonical) return canonical.status === "configured";
  return (profiles ?? []).some((profile) =>
    profile?.purpose === legacyPurpose && profile?.status === "configured",
  );''')
path = 'ui/src/lib/organization-intelligence.test.ts'
with (root / path).open('a') as handle:
    handle.write('''
describe("canonical organization intelligence precedence", () => {
  it.each(["disabled", "invalid"] as const)("does not revive a %s default through a legacy alias", (status) => {
    const profiles = [
      { purpose: "default", status },
      { purpose: "lightweight", status: "configured" },
      { purpose: "reasoning", status: "configured" },
    ] as const;
    expect(isOrganizationIntelligenceEnabled(profiles, "lightweight")).toBe(false);
    expect(isOrganizationIntelligenceEnabled(profiles, "reasoning")).toBe(false);
  });
});
''')
changed.add(path)

# This test is about referenced timer handles, not a one-millisecond scheduling
# guarantee. Observe timer arming directly instead of polling for exactly 1002
# milliseconds after Date.now() was called elsewhere. Attach rejection handling
# at invocation so a failure cannot become an unhandled promise rejection.
path = 'desktop/src/local-apps-runtime.test.ts'
source = (root / path).read_text()
start_marker = '''  it(
    "keeps watchdog startup and cleanup deadlines referenced while start is pending",'''
end_marker = '''  it.runIf(process.platform !== "win32")(
    "keeps ownership orphaned when a running watchdog exits without acknowledging cleanup",'''
assert source.count(start_marker) == source.count(end_marker) == 1
start = source.index(start_marker)
end = source.index(end_marker, start)
replacement = '''  it(
    "keeps watchdog startup and cleanup deadlines referenced while start is pending",
    { timeout: 15_000 },
    async () => {
      const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
      const helper = watchdogEmitting({ type: "ignored" });
      helper.send = vi.fn((_payload: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
      });
      const spawnWatchdog = vi.fn(() => helper) as unknown as typeof spawn;
      let phase: "startup" | "cleanup" | "done" = "startup";
      let observeStartup!: (timer: NodeJS.Timeout) => void;
      let observeCleanup!: (timer: NodeJS.Timeout) => void;
      const startupArmed = new Promise<NodeJS.Timeout>((resolve) => { observeStartup = resolve; });
      const cleanupArmed = new Promise<NodeJS.Timeout>((resolve) => { observeCleanup = resolve; });
      const scheduleTimeout = globalThis.setTimeout;
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((
        (...args: Parameters<typeof setTimeout>) => {
          const timer = scheduleTimeout(...args);
          const delay = args[1];
          if (phase === "startup" && delay === 1_001) observeStartup(timer);
          // Cleanup computes a remaining duration from a deadline; elapsed time
          // between those calls must not make a valid timer invisible to the test.
          if (phase === "cleanup" && typeof delay === "number" && delay > 0 && delay <= 1_002) {
            observeCleanup(timer);
          }
          return timer;
        }
      ) as typeof setTimeout);
      const manager = new LocalAppRuntimeManager({
        registry,
        platform: "win32",
        spawnWatchdog,
        watchdogStartTimeoutMs: 1_001,
        cleanupTimeoutMs: 1_002,
      });

      try {
        const startOutcome = manager.start(definition.id).then(
          () => null,
          (error: unknown) => error,
        );
        expect((await startupArmed).hasRef()).toBe(true);
        expect(spawnWatchdog).toHaveBeenCalledOnce();

        phase = "cleanup";
        helper.emit("error", new Error("watchdog fixture failed"));
        expect((await cleanupArmed).hasRef()).toBe(true);

        phase = "done";
        helper.emit("message", { type: "stopped" });
        helper.emit("exit", 1, null);
        expect(await startOutcome).toMatchObject({ message: "watchdog fixture failed" });
        await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
          status: "failed",
          pid: null,
          pgid: null,
        });
      } finally {
        phase = "done";
        helper.emit("message", { type: "stopped" });
        helper.emit("exit", 1, null);
        timeoutSpy.mockRestore();
        await manager.shutdown();
      }
    },
  );

'''
(root / path).write_text(source[:start] + replacement + source[end:])
changed.add(path)

# Keep the patch scope explicit and leave every CI gate/baseline untouched.
actual = set(subprocess.check_output(['git', 'diff', '--name-only'], cwd=root, text=True).splitlines())
assert actual == changed, (actual, changed)
assert not any(p.startswith(('.github/', 'scripts/architecture-')) for p in actual)
print('PATCHED_FILES=' + ','.join(sorted(changed)))
