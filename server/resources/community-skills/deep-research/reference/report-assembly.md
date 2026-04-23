# Report Assembly: Progressive File Generation

## Length Requirements by Mode

| Mode | Target Words | Description |
|------|--------------|-------------|
| Quick | 2,000-4,000 | Baseline quality threshold |
| Standard | 4,000-8,000 | Comprehensive analysis |
| Deep | 8,000-15,000 | Thorough investigation |
| UltraDeep | 15,000-20,000+ | Maximum rigor (at output limit) |

---

## Output Token Safeguard

**Claude Code default limit:** 32,000 output tokens (~24,000 words total per execution)

**Practical limits:**
- Target <=20,000 words total output
- Leave safety margin for tool call overhead
- Reports >20,000 words require auto-continuation (see continuation.md)

---

## Progressive Section Generation

**Core Strategy:** Generate and write each section individually using Write/Edit tools. This allows unlimited report length while keeping each generation manageable.

### Phase 8.1: Setup

```bash
# Create folder: ~/Documents/[TopicName]_Research_[YYYYMMDD]/
mkdir -p ~/Documents/[folder_name]

# Initialize markdown file with frontmatter
# Path: [folder]/research_report_[YYYYMMDD]_[slug].md
```

### Phase 8.2: Section Generation Loop

**Pattern:** Generate section -> Write/Edit to file -> Move to next section
Each Write/Edit call contains ONE section (<=2,000 words per call)

**Initialize citation tracking (persist to disk):**
```bash
# Create sources.json in the report folder for durable provenance
# Each entry: {"num": N, "title": "...", "url": "...", "claim": "...", "evidence_quote": "..."}
echo '[]' > [folder]/sources.json
```
Update sources.json after each section. This survives context compaction and enables continuation agents to pick up citation state.

**Section sequence:**

1. **Executive Summary** (200-400 words)
   - Tool: Write(file, frontmatter + Executive Summary)
   - Track citations
   - Progress: "Executive Summary complete"

2. **Introduction** (400-800 words)
   - Tool: Edit(file, append Introduction)
   - Track citations
   - Progress: "Introduction complete"

3. **Finding 1-N** (600-2,000 words each)
   - Tool: Edit(file, append Finding N)
   - Track citations
   - Include at least one concrete example, mini-case, counterexample, or applied scenario when it improves comprehension
   - If the example is hypothetical, label it clearly rather than citing it as sourced fact
   - Progress: "Finding N complete"

4. **Synthesis & Insights**
   - Novel insights beyond source statements
   - Add a concrete scenario or mini-case if synthesis is otherwise too abstract
   - Tool: Edit(append)

5. **Limitations & Caveats**
   - Counterevidence, gaps, uncertainties
   - Tool: Edit(append)

6. **Recommendations**
   - Immediate actions, next steps, research needs
   - Where useful, show how one recommendation would play out in a concrete applied case
   - Tool: Edit(append)

7. **Bibliography** (CRITICAL)
   - EVERY citation from citations_used list
   - NO ranges, NO placeholders, NO truncation
   - Tool: Edit(append)

8. **Methodology Appendix**
   - Research process, verification approach
   - Tool: Edit(append)

---

## File Organization

**1. Create dedicated folder:**
- Location: `~/Documents/[TopicName]_Research_[YYYYMMDD]/`
- Clean topic name (remove special chars, use underscores)

**2. File naming convention:**
All files use same base name:
- `research_report_20251104_topic_slug.md`
- `research_report_20251104_topic_slug.html`
- `research_report_20251104_topic_slug.pdf`

**3. Also save copy to:** `~/.claude/research_output/` (internal tracking)

---

## Word Count Per Section

**CRITICAL:** No single Edit call should exceed 2,000 words.

Example: 10 findings x 1,500 words = 15,000 words total
- Each Edit call: 1,500 words (under limit)
- File grows to 15,000 words
- No single tool call exceeds limits
