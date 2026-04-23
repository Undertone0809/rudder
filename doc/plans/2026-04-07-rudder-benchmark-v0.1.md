# Rudder Benchmark v0.1: Agent Execution Evaluation System

**Status:** DRAFT  
**Date:** 2026-04-07  
**Author:** Rudder Team  
**Branch:** main  

## 1. Problem Statement

Rudder is an agent orchestration and control platform that currently lacks a systematic way to evaluate the real effectiveness of agent task execution. We need a benchmark system to:

1. **Capability Verification**: Can the agent correctly complete the software development task given by the user?
2. **Regression Tracking**: Do code changes lead to a decrease in agent execution capabilities?
3. **Baseline Comparison**: Compare capabilities between different agent configurations/versions.
4. **Data Accumulation**: Build a real-world case library for later optimization and training.

## 2. Goals

### v0.1 Goals (to deliver in 2 weeks)
- [ ] Complete the first end-to-end evaluation loop.
- [ ] Support 15–20 real code task cases.
- [ ] Enable evaluation of Rudder agent's task completion.
- [ ] Output readable evaluation reports.

### Medium & Long-term Goals
- [ ] Support multi-dimensional evaluation (efficiency, memory, knowhow, etc.)
- [ ] Evaluate any agent (Claude Code, Codex, Devin, etc.)
- [ ] Automate regression testing
- [ ] Visualize capability boundaries

## 3. Design Principles

1. **Progressive Extension**: v0.1 is minimal, but data formats are compatible with the full v1.0 architecture.
2. **Case-as-Code**: Test cases are managed through the filesystem for easy versioning.
3. **Agent Agnostic**: Not bound to Rudder internals, accessible through standard interfaces.
4. **Observability**: Each run saves a complete trace for retrospective analysis.

## 4. Architecture

### 4.1 Directory Structure

```
benchmark/                          # benchmark directory at project root
├── README.md                       # usage instructions
├── package.json                    # standalone package, depends on shared rudder types
├── tsconfig.json
├── src/
│   ├── index.ts                    # CLI entry
│   ├── commands/
│   │   ├── run.ts                  # run single case
│   │   ├── batch.ts                # batch execution (v0.2)
│   │   └── report.ts               # generate reports
│   ├── core/
│   │   ├── case-loader.ts          # load/validate case
│   │   ├── runner.ts               # execution engine
│   │   └── evaluator.ts            # evaluation logic
│   ├── adapters/
│   │   ├── base.ts                 # agent adapter interface
│   │   └── rudder.ts               # Rudder agent adaptation
│   └── types/
│       └── case.ts                 # case type definitions
├── cases/                          # test case repository
│   ├── _template/                  # template for new cases
│   │   ├── case.yaml               # case metadata (core file)
│   │   ├── codebase/               # initial code (git bundle or dir)
│   │   │   └── README.md
│   │   └── expected/               # expected result (optional)
│   │       └── test.ts
│   ├── js-fix-bug-001/             # concrete case
│   ├── python-swe-flask-1234/      # case imported from SWE-bench
│   └── ...
├── runs/                           # execution result storage (gitignore)
│   └── 2026-04-07-143022/
│       ├── run.json                # run metadata
│       └── js-fix-bug-001/
│           ├── result.json         # evaluation result
│           ├── stdout.log          # agent output
│           └── final-state/        # final code state
└── scripts/
    └── import-swe-bench.ts         # script to import SWE-bench cases
```

### 4.2 Case Data Format (v0.1 Core Design)

**Note: This format is a subset of the full v1.0 architecture and allows lossless migration**

```yaml
# cases/{case-id}/case.yaml
# Required fields for v0.1

id: js-fix-bug-001                   # globally unique id
version: "1.0.0"                     # case format version
created_at: "2026-04-07"             # creation date
author: "rudder-team"                # creator

# tags for filtering/reporting
tags:
  - javascript
  - react
  - bugfix
  - memory-leak

difficulty: easy                     # easy | medium | hard

# user-facing task description
prompt: |
  Fix the memory leak in the following React component:
  The event listener added in useEffect is not cleaned up when the component unmounts.
  File: src/components/UserList.tsx

# initial state setup
setup:
  type: git_bundle                   # git_bundle | git_repo | directory
  source: ./codebase.bundle          # path relative to case dir
  # v0.2 extension: support git_repo + commit
  # git_repo: https://github.com/... 
  # commit: abc123

# evaluation config (v0.1 supports test_pass)
evaluation:
  type: test_pass
  command: "npm test -- src/components/__tests__/UserList.test.tsx"
  timeout: 60                        # seconds
  # v0.2 extension: support multi-stage evaluation
  # stages:
  #   - type: test_pass
  #   - type: diff_check

# v0.1 ignores the following (reserved for v1.0)
# metrics: { efficiency: {...}, memory: {...} }
# environment: { docker: {...} }
# evaluation_alternatives: [...]
```

### 4.3 TypeScript Type Definitions

```typescript
// src/types/case.ts

// Required for v0.1
export interface Case {
  id: string;
  version: string;
  created_at: string;
  author: string;
  tags: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: string;
  setup: CaseSetup;
  evaluation: EvaluationConfig;
  // Future extensions (optional in v0.1)
  metrics?: MetricsConfig;
  environment?: EnvironmentConfig;
}

export interface CaseSetup {
  type: 'git_bundle' | 'git_repo' | 'directory';
  source: string;
  // for git_repo (v0.2)
  git_repo?: string;
  commit?: string;
  branch?: string;
}

// v0.1 only supports test_pass
export interface EvaluationConfig {
  type: 'test_pass';
  command: string;
  timeout: number;
  // v0.2 extension
  cwd?: string;
  env?: Record<string, string>;
}

// Execution result
export interface RunResult {
  case_id: string;
  run_id: string;
  timestamp: string;
  agent: AgentConfig;
  status: 'pending' | 'running' | 'completed' | 'failed';
  
  // Evaluation result
  evaluation: {
    type: 'test_pass';
    passed: boolean;
    duration_ms: number;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
  };
  
  // Resource usage (base in v0.1)
  resources: {
    duration_ms: number;
    // v0.2 extension
    // tokens_input?: number;
    // tokens_output?: number;
  };
  
  // Full trace
  trace: {
    working_dir: string;
    final_state_path?: string;
    logs_path: string;
  };
}
```

## 5. Implementation Plan

### Phase 1: Infrastructure (Day 1–3)

#### 5.1.1 Project Initialization
```bash
mkdir -p benchmark
pnpm init
# Dependencies: yaml, execa, zod (validation), commander (CLI)
```

#### 5.1.2 Core Modules
- `case-loader.ts`: load case.yaml, validate format, load codebase
- `runner.ts`: prepare environment → invoke agent → collect results
- `evaluator.ts`: run evaluation command, determine pass/fail

#### 5.1.3 Rudder Agent Adapter
```typescript
// src/adapters/rudder.ts
interface AgentAdapter {
  // Execute a single case
  execute(
    caseDir: string,
    prompt: string,
    timeout: number
  ): Promise<AgentResult>;
}
```

Rudder adapter invokes agent as follows:
1. Use local Rudder CLI or API
2. Create temporary workspace, load codebase
3. Submit task/issue to agent
4. Wait for completion, collect results and logs

### Phase 2: Case Creation (Day 3–5)

#### 5.2.1 Write Cases by Hand (10 cases)
Cover these types:
| Case ID            | Type         | Tech Stack    | Difficulty | Evaluation   |
|--------------------|--------------|--------------|------------|--------------|
| js-fix-bug-001     | Bugfix       | React/JS     | easy       | Test pass    |
| js-feature-001     | Feature      | Node.js      | easy       | Test pass    |
| ts-refactor-001    | Refactor     | TypeScript   | medium     | Test pass    |
| py-fix-bug-001     | Bugfix       | Python       | easy       | Test pass    |
| py-swe-flask-1234  | SWE-bench    | Flask        | medium     | Test pass    |
| ...                | ...          | ...          | ...        | ...          |

#### 5.2.2 SWE-bench Import Script
```bash
# Import specific case from SWE-bench
pnpm benchmark import-swe-bench \
  --instance-id flask-1234 \
  --output cases/python-swe-flask-1234
```

### Phase 3: CLI and Reporting (Day 5–7)

#### 5.3.1 CLI Commands
```bash
# Run single case
pnpm benchmark run <case-id> [options]
  --agent rudder              # agent type (default: rudder)
  --adapter rudder-local      # select adapter
  --output ./runs/xxx         # output dir

# View result
pnpm benchmark show <run-id>

# Generate simple report
pnpm benchmark report --run <run-id>
```

#### 5.3.2 Report Format
```markdown
# Benchmark Run Report

**Run ID:** 2026-04-07-143022  
**Agent:** rudder@1.0.0  
**Date:** 2026-04-07

## Summary

| Metric      | Value    |
|-------------|----------|
| Total Cases | 15       |
| Passed      | 12 (80%) |
| Failed      | 2 (13%)  |
| Timeout     | 1 (7%)   |

## By Category

| Tag        | Total | Passed | Rate  |
|------------|-------|--------|-------|
| javascript | 5     | 4      | 80%   |
| python     | 5     | 4      | 80%   |
| bugfix     | 8     | 7      | 87%   |

## Failed Cases

| Case            | Error                         | Duration |
|-----------------|------------------------------|----------|
| ts-refactor-001 | Test failed: expected 3, got 2 | 45s     |

## Details

[Detailed results for each case...]
```

### Phase 4: Verification & Iteration (Day 7–10)

1. Run all cases and verify evaluation accuracy.
2. Fix edge cases (timeouts, cleanup, etc.)
3. Documentation: README, CONTRIBUTING (how to add new cases)

## 6. Migration to v1.0 (Approach B)

### 6.1 Format Compatibility Guarantee

v0.1's case.yaml is a strict subset of v1.0 and can migrate as:

```yaml
# v0.1 case.yaml
id: xxx
setup:
  type: git_bundle
  source: ./codebase.bundle
evaluation:
  type: test_pass
  command: "npm test"

# v1.0 automatically extended as
id: xxx
setup:
  type: git_bundle
  source: ./codebase.bundle
  # new: auto-inferred
  environment:
    type: host  # v0.1 has no isolation, equivalent to host
evaluation:
  type: test_pass
  command: "npm test"
  # new: default strategy
  strategy: any_pass  # v0.1 single evaluation == any_pass
```

### 6.2 Code Migration Path

| v0.1 Module        | v1.0 Module          | Migration Approach               |
|--------------------|---------------------|----------------------------------|
| `case-loader.ts`   | `CaseRegistry`      | Extend: add caching/versioning   |
| `runner.ts`        | `ExecutionEngine`   | Extend: add Docker isolation     |
| `evaluator.ts`     | `EvaluationEngine`  | Extend: add plugin system        |
| `rudder.ts` adapter| `AgentAdapter`      | Keep as-is, matches interface    |
| `runs/` file store | `ResultStore`       | Migrate into SQLite              |

## 7. Success Criteria

### v0.1 Done When
- [x] `pnpm benchmark run js-fix-bug-001` completes and outputs correct results
- [x] 15 cases runnable, evaluation accuracy >90%
- [x] Report clearly shows pass rate and failure causes
- [x] Workflow for adding new case documented (<10 min to create new case)

### Regression Test Ready When
- [x] CI integration: `pnpm benchmark batch` as PR check
- [x] Historical comparison: can compare results between runs

## 8. Open Questions

1. **Agent invocation**: Use Rudder CLI or call direct API?
2. **Environment Isolation**: Is Docker needed for v0.1? Or trust local environment?
3. **Case Storage**: Should the cases be managed in a separate git repo? (to avoid repo bloat)

## 9. Next Steps

1. Confirm this plan and answer open questions.
2. Create `benchmark/` directory and initialize project.
3. Implement `case-loader.ts` and first case.
4. Run the first end-to-end test.

---

## Appendix A: Case Creation Template

```bash
# Create a new case
pnpm benchmark new-case --id js-fix-bug-002 --type bugfix

# Generated directory structure
cases/js-fix-bug-002/
├── case.yaml          # edit this file
├── codebase/          # put initial code here
│   └── ...
└── expected/          # (optional) expected result
    └── ...
```

## Appendix B: SWE-bench Import Example

```typescript
// scripts/import-swe-bench.ts
// Import a case from the SWE-bench dataset
// Convert its format to rudder benchmark case format
```

## Appendix C: Relation to Existing Testing Frameworks

- **Unit/Integration Tests**: Validate code correctness, run by developers.
- **Benchmark**: Evaluate agent capabilities, run by researchers/users.
- **E2E Tests**: Validate product flows, run by CI.

The three are complementary and not replacements for each other.
