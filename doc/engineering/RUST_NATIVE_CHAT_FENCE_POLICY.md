# Reviewed legacy Native Chat fence records

This policy adds a narrow, typed record for temporary Node compatibility fences around Native Chat. It does not relax the existing Node-authority ratchet or create review records for a live change. A reviewer must inspect the exact base and candidate sources and record those hashes before a real candidate can pass.

## Supported records

- Fixed Native Chat queue-fence helper records authorize only the exact helper body whose SHA-256 is embedded in the inventory checker, its fixed existing module, and its exact structural DB-surface set. The checker does not accept a record-supplied digest as authority.
- Guard-callsite records bind one existing writer in one mapped transaction to a direct, awaited call of one approved helper, with the required fail-closed result branches before that writer.
- Target-lock records permit only the exact target-key binding and transaction-scoped advisory-lock SQL shape checked by the parser.
- Existing-operation mappings document relocation of an existing transaction or retirement of an old transaction surface. Pure removal needs no mapping.

The policy does not waive arbitrary SELECTs: only a query inside one fixed, statically pinned helper can be admitted. A new writer, route, worker, source file, or unrecognized helper remains a ratchet failure. Record metadata is descriptive; it does not establish that a human review occurred. The delivery packet must separately name the exact source hash and reviewer evidence. The structural checks constrain the narrow patterns above; they are not a TypeScript control-flow proof.

## What the checker proves

It checks exact hashes, candidate inventory surfaces, narrow syntactic shapes, tokenized direct guard branches, and references between records. It rejects comment-only branch checks and checks outside the same lexical block as the target call and writer. This remains a narrow structural check, not a static call-graph or general TypeScript control-flow proof. It does not establish runtime import resolution or transaction isolation. Those semantics require a separate human review against the exact source hashes plus concurrency tests. Line numbers and source offsets are not treated as proof of runtime execution order. The record narrows the exact reviewed change but does not replace Rust authority or a Rust-owned enforcement boundary.

## Validation

Run the pure inventory unit suite:

```sh
node --test scripts/rust-backend-authority-inventory.test.mjs
```

The tests include pure transaction retirement, fixed helper/caller records, callback mapping, exact helper-body hashes and callsites, query/body mutations, mutable or shadowed target keys, extra SQL and wrong-owner rejection, late or unawaited guard calls, generic SELECT rejection, new writers/workers/files, and existing transaction mappings.

Pinned helper names may appear only as exact imports/declarations or direct awaited calls. Other identifier uses, including parameters, destructuring, catch bindings and aliases, are rejected conservatively in callers and in every fixed helper dependency. This restriction does not grant authority to change the trusted digest table; policy changes still need independent source review.

Guard-to-writer target identity is bound by an additional static table of exact reviewed caller-file SHA-256 values. Changing an organization argument, conversation argument, writer target, alias setup, or surrounding control flow invalidates that contract even if an inventory record is rehashed. The CLI never takes caller pins from inventory records. Each table entry must match separate source-review evidence; changing the table is itself a reviewed policy change. Lexical checks remain additional constraints, rather than a substitute for the exact caller-source contract.
