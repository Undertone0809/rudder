# Deep Research Skill for Claude Code

Enterprise-grade research engine for Claude Code. Produces citation-backed reports with source credibility scoring, multi-provider search, automated validation, and concrete cases/examples that make abstract findings easier to grasp.

## Installation

```bash
# Clone into Claude Code skills directory
git clone https://github.com/199-biotechnologies/claude-deep-research-skill.git ~/.claude/skills/deep-research
```

No additional dependencies required for basic usage.

### Optional: search-cli (multi-provider search)

For aggregated search across Brave, Serper, Exa, Jina, and Firecrawl:

```bash
brew tap 199-biotechnologies/tap && brew install search-cli
search config set keys.brave YOUR_KEY  # configure at least one provider
```

## Usage

```
deep research on the current state of quantum computing
```

```
deep research in ultradeep mode: compare PostgreSQL vs Supabase for our stack
```

## Research Modes

| Mode | Phases | Duration | Best For |
|------|--------|----------|----------|
| Quick | 3 | 2-5 min | Initial exploration |
| Standard | 6 | 5-10 min | Most research questions |
| Deep | 8 | 10-20 min | Complex topics, critical decisions |
| UltraDeep | 8+ | 20-45 min | Comprehensive reports, maximum rigor |

## Pipeline

Scope &rarr; Plan &rarr; **Retrieve** (parallel search + agents) &rarr; Triangulate &rarr; Outline Refinement &rarr; Synthesize &rarr; Critique (with loop-back) &rarr; Refine &rarr; Package

Key features:
- **Step 0**: Retrieves current date before searches (prevents stale training-data year assumptions)
- **Parallel retrieval**: 5-10 concurrent searches + 2-3 focused sub-agents returning structured evidence objects
- **First Finish Search**: Adaptive quality thresholds by mode
- **Critique loop-back**: Phase 6 can return to Phase 3 with delta-queries if critical gaps found
- **Multi-persona red teaming**: Skeptical Practitioner, Adversarial Reviewer, Implementation Engineer (Deep/UltraDeep)
- **Disk-persisted citations**: `sources.json` survives context compaction and continuation agents
- **Case-grounded synthesis**: Encourages source-grounded examples, mini-cases, counterexamples, and labeled hypotheticals for technical or abstract findings

## Output

Reports saved to `~/Documents/[Topic]_Research_[Date]/`:
- Markdown (primary source of truth)
- HTML (McKinsey-style, auto-opened in browser)
- PDF (professional print via WeasyPrint)

Major findings should be grounded in concrete examples or mini-cases when that improves readability. Prefer real sourced cases; if only a hypothetical illustration is possible, label it explicitly.

Reports >18K words auto-continue via recursive agent spawning with context preservation.

## Quality Standards

- 10+ sources, 3+ per major claim
- Executive summary 200-400 words
- Findings 600-2,000 words each, prose-first (>=80%)
- Major findings grounded in concrete examples, cases, counterexamples, or applied scenarios when helpful
- Full bibliography with URLs, no placeholders
- Automated validation: `validate_report.py` (10 checks) + `verify_citations.py` (DOI/URL/hallucination detection)
- Validation loop: validate &rarr; fix &rarr; retry (max 3 cycles)

## Search Tools

| Tool | When | Setup |
|------|------|-------|
| WebSearch | Default, always available | None |
| Exa MCP | Semantic/neural search | MCP config |
| search-cli | Multi-provider aggregation | `brew install search-cli` + API keys |

## Architecture

```
deep-research/
├── SKILL.md                          # Skill entry point (lean, ~100 lines)
├── reference/
│   ├── methodology.md                # 8-phase pipeline details
│   ├── report-assembly.md            # Progressive generation strategy
│   ├── quality-gates.md              # Validation standards
│   ├── html-generation.md            # McKinsey HTML conversion
│   ├── continuation.md               # Auto-continuation protocol
│   └── weasyprint_guidelines.md      # PDF generation
├── templates/
│   ├── report_template.md            # Report structure template
│   └── mckinsey_report_template.html # HTML report template
├── scripts/
│   ├── validate_report.py            # 10-check structure validator
│   ├── verify_citations.py           # DOI/URL/hallucination checker
│   ├── source_evaluator.py           # Source credibility scoring
│   ├── citation_manager.py           # Citation tracking
│   ├── md_to_html.py                 # Markdown to HTML converter
│   ├── verify_html.py                # HTML verification
│   └── research_engine.py            # Core orchestration engine
└── tests/
    └── fixtures/                     # Test report fixtures
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.3.2 | 2026-04-05 | Case-grounded readability improvements across skill instructions, templates, and validation heuristics |
| 2.3.1 | 2026-03-19 | Template/validator harmonization, structured evidence, critique loop-back, multi-persona red teaming |
| 2.3 | 2026-03-19 | Contract harmonization, search-cli integration, dynamic year detection, disk-persisted citations, validation loops |
| 2.2 | 2025-11-05 | Auto-continuation system for unlimited length |
| 2.1 | 2025-11-05 | Progressive file assembly |
| 1.0 | 2025-11-04 | Initial release |

## License

MIT - modify as needed for your workflow.
