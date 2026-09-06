# Public documentation authoring

This guide defines how Rudder's English and Simplified Chinese public
documentation is written. It applies to `docs/`; verify behavior against
implementation and tests.

## Start from the reader's job

Each page should help a reader make one decision or complete one outcome. Use
one continuing case to make the page concrete. Add at most one high-risk edge
case when it changes the decision. Keep normative facts outside examples so a
reader and a retrieval system can distinguish product behavior from a story.

`What`, `Why`, and `How` are questions to answer, never mandatory headings.
Choose headings that describe the reader's actual decision or progress.

### Home

1. Open with a believable situation and the result the reader wants.
2. Define Rudder in direct product language.
3. Explain why the shared work record helps in that situation.
4. Give one first action.

Use a real case only when the content manifest contains complete, permitted
evidence. Otherwise label it as an example.

### Concept

1. Define the concept in the first useful paragraph.
2. Follow one case through the page.
3. Explain when the concept is useful.
4. End with the operating boundary or the next practical guide.

### How-to

1. State the completed state and prerequisites.
2. Walk through steps backed by the same case.
3. Name the success signal and recovery path.

Explain why only at a decision point. Do not interrupt mechanical steps with
general product philosophy.

### Reference

Present definitions, states, constraints, boundaries, and one compact example.
Reference pages are normative and scannable. They should link to a how-to for a
long procedure instead of hiding a tutorial inside a state table.

## Bilingual authoring

English and Chinese pages share a fact brief, contract ownership, stable
anchors, and examples. They are authored independently. Do not translate
sentences line by line or preserve English syntax in Chinese.

Chinese keeps an English label only when a reader must recognize that exact
name in the interface. Use ordinary Chinese for concepts such as 负责人、评审人、
运行记录、运行环境、对话记录、产物、审批、预算 and 活动记录. The terminology
glossary is in `doc/engineering/public-docs/terminology.md`; the machine-readable
UI label exception list is in `doc/engineering/public-docs/ui-label-allowlist.json`.
Format an English UI label in Chinese prose as bold text or inline code so the
automated check can distinguish the exact interface name from ordinary English
or a lowercase status value.

## Issue definition

Use these definitions exactly wherever the public docs define an Issue.

English:

> An issue is a durable task record with an explicit status and lifecycle. Use
> one when work needs a named owner, dependencies, or a review path; comments,
> agent runs, artifacts, and review decisions can stay with the same record.

Chinese:

> Issue（任务单）是带有明确状态和生命周期的任务记录。需要指定负责人、跟踪依赖或安排评审时使用；评论、Agent 运行、产物和评审结论可以留在同一条记录中。

Never describe an Issue with the public phrase `structured task` or `结构化任务`.

## Style and evidence

- Prefer short, concrete sentences and varied paragraph length.
- Remove promotional padding, roadmap promises, and internal implementation
  detail.
- Do not use em dashes or en dashes in newly rewritten public prose.
- Preserve UI names exactly when the reader needs to find them.
- Keep screenshots only when they help the reader recognize a state or action.
- A real case needs the request, surface choice, roles, intervention, artifacts,
  outcome, permission, and traceable evidence recorded in the content manifest.
- Illustrative cases can explain a workflow but cannot prove product behavior.

## Metadata and maintenance

Every canonical bilingual page declares `canonical`, `hreflang_en`, and
`hreflang_zh` frontmatter. The private content map at
`scripts/docs-content-map.yml` owns page identity, pairing, stable anchors,
aliases, examples, and contract ownership.

Run these checks before hand-off:

```sh
pnpm docs:metadata:generate
pnpm docs:integrity
pnpm docs:alignment
pnpm docs:validate
```

`docs:integrity` checks deterministic structure. `docs:alignment` only reports
review reminders; it does not claim semantic agreement between languages or
with the implementation.
