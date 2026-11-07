# Asset authority source stage review

**Verdict: ACCEPT (source stage only).** Reviewed the dirty candidate in `/Users/zeeland/.codex/worktrees/rust-backend-completion-20261016/rudder-oss`, expected fingerprint `172d9ebce67a2dae1cdb8f063eb004ad6648a518689f64ec2cd8929f0396a84e`, based on `e070d9cf37f4ad8a9c779a38ac4033ad3f704a44`. Every file SHA in `source-manifest.json` matches the current candidate. This is an implementation review, not Cargo verification, public acceptance, or merge approval.

## Findings

- **Signed proof fence:** accepted. The Express delta checks `getVerifiedNativeSessionAssertion(req)` at the start of each of the three Asset handlers, before auth/service/storage/read/write/audit work. That value is bound by existing verified middleware state, not a client-provided header. The route test covers POST image, POST logo, GET content, and the HEAD alias, with legacy service/storage spies left untouched. This makes the private Rust hop fail closed against re-entering the legacy handlers. Ingress-off unsigned legacy behavior remains an explicit compatibility limitation.
- **Rust route ownership:** accepted. Public dispatch reserves the intended POST upload/logo and GET/HEAD content endpoints, including existing case-insensitive literal and trailing-slash behavior. The exact ignored `public_assets_persist_sanitize_scope_and_fail_without_node` selector is included in `.github/workflows/rust-d1-real-entry.yml` with `--exact --ignored --nocapture --test-threads=1`; it exercises public TCP ingress, PostgreSQL, storage, and a counting Node upstream.
- **SVG compatibility and safety:** accepted for the stated scope. The Rust parser retains common paths, gradients, filters, fragment URLs and safe style rules; it rejects malformed XML/DTD/entity input, unknown active elements, event attributes, and non-fragment href/URL values. Serving adds SVG CSP and `nosniff`; HTML is forced to attachment/octet-stream. This is a deliberate allowlist, so do not claim byte-for-byte output parity with DOMPurify; the packet’s common-SVG compatibility claim is supported by its fixture vectors.
- **Storage and transaction behavior:** accepted at source level. Authorization and org existence are checked before the put. Insert, activity receipt, and response projection occur in one SQL transaction; errors in that sequence roll back and attempt object cleanup. The prepared public selector includes storage failure, SQL rejection after put with cleanup, missing storage, and no-row assertions. Commit-acknowledgment failure is not independently qualified; do not broaden the report to claim recovery from ambiguous commit outcomes.
- **Concrete metadata correction before candidate freeze:** the packet says three stale `reviewed_node_changes` records “already in main,” but actual `origin/main` is now `452be7085f7f5a2d91207a0d0fb6ef915f503511` and its inventory has an empty `reviewed_node_changes` list. The candidate still carries those three inherited rows. Remove them and add the Asset record below; rebind the candidate packet/manifest to the resulting tree. This does not change the reviewed Asset implementation, but the current inventory statement and candidate contents are not accurate relative to current main.

Suggested `reviewed_node_changes` entry for `server/src/routes/assets.ts`:

```json
{
  "path": "server/src/routes/assets.ts",
  "change_kind": "modified_node_compatibility",
  "node_role": "compatibility_adapter",
  "rust_authority": "native/crates/server-foundation/src/public_ingress/assets.rs; native/crates/d1-persistence/src/assets.rs",
  "scope": "Return 404 before legacy behavior on the three Asset upload/logo/content handlers only when the existing verified Rust private-hop assertion is present.",
  "compatibility_boundary": "Registration/request fence only; Rust owns the reserved methods. Ingress-off legacy behavior remains explicit debt; no fallback for verified Rust requests.",
  "retirement_criterion": "Remove these compatibility handlers with complete Rust default/no-Node cutover.",
  "reviewer": "/root/messenger_merge_review",
  "review_reference": "<this report path and its SHA-256 after saving>",
  "review_status": "reviewed",
  "base_sha256": "330df11904ef6473eaa737fb7c27368626000465480a06f51d5bc1ef63b07050",
  "head_sha256": "a356c945453e8f9892c888be56977ea6352c4a5c6592850bafc7905a3438d786"
}
```

The base hash above is `server/src/routes/assets.ts` on the current fetched `origin/main`; head is the candidate file. Current main has advanced from the packet’s e070 base, so refresh the packet/source-manifest’s base identity when recording the publication candidate.

## Remaining gates

No Cargo compile/clippy/unit run or public PostgreSQL PAV has been completed for this candidate. CI may start after the inventory correction and source freeze; final acceptance still requires the exact-head CI result and the prepared ignored public HTTP/PostgreSQL selector. No merge or release verdict is made here.
