# Rudder Account Desktop Gate Design QA

- Source visual truth: `/var/folders/5l/j5_nt6_x45bbmygxn444r24r0000gn/T/codex-clipboard-9232fc6c-d00f-42c5-9900-2445d526097d.png`
- Implementation screenshot: `/tmp/rudder-packaged-gate-final-82885003f.png`
- Side-by-side evidence: `/tmp/rudder-login-ui-final-comparison.png`
- Exact implementation source: `82885003f5f2b57bf5d582633cf1741bdf21c003`
- State: packaged macOS Desktop, signed out, default email-code path, password panel collapsed
- Source pixels: `3158 × 2260`
- Implementation pixels: `3158 × 2034`
- Normalization: each full screenshot was fit into a `1579 × 1130` comparison cell without cropping; the implementation capture corresponds to a `1579 × 1017` CSS viewport at device scale factor 2.

## Findings

No actionable P0, P1, or P2 visual differences remain.

- Typography follows the reference hierarchy: heavy display heading, compact provider labels, readable muted supporting copy, and a smaller uppercase divider.
- Spacing and layout retain the centered single-card composition, generous surrounding default background, consistent field/button rhythm, rounded corners, and restrained shadow.
- Colors use Rudder's default warm neutral shell, near-white card, dark primary action, muted secondary text, and accessible control borders.
- The official Rudder raster logo is used. Google and GitHub marks remain sharp and provider-specific.
- Copy preserves the requested Google, GitHub, email-code primary path, password disclosure, and Local Workspace privacy promise.

## Focused Region Evidence

The complete card is readable at the normalized scale, so a separate crop was unnecessary. The final packaged capture confirms the logo, both provider controls, divider, email field, primary email-code action, password disclosure, and privacy copy in one view.

## Interaction And Runtime Evidence

- Initial password panel: hidden; toggle text `Use password instead`; `aria-expanded=false`.
- Expanded password panel: visible; toggle text `Use email code instead`; `aria-expanded=true`.
- Google login completed against production Rudder Account.
- The exact packaged app reopened directly into Rudder using encrypted persisted credentials.
- Packaged smoke completed without a surfaced browser-console failure.

## Comparison History

1. Earlier packaged evidence showed the password actions expanded while the toggle still said `Use password instead`.
2. The toggle state machine was corrected and the initial panel is now explicitly collapsed.
3. The exact final package was rebuilt and recaptured. The post-fix screenshot shows the compact email-first composition from the reference, and black-box interaction confirms the expanded state is coherent.

## Follow-up Polish

- P3: The web reference includes Privacy and Terms links. The Desktop gate keeps the privacy promise but does not repeat those links; adding them later would improve parity but does not alter the requested login composition or block use.

final result: passed

---

# Windows Transparent Desktop Shell Design QA

- Source visual truth: `C:\Users\zeela\.codex\attachments\bd916bf6-a361-44d5-869d-ec7665534a81\image-1.png`
- Implementation screenshot: `C:\Users\zeela\AppData\Local\Temp\rudder-windows-glass-final.png`
- Candidate fingerprint: `86e0e4ed18d1361eb30e08c71bc52b50bc5fbd362a8a6634163f20ffeba402d0`
- State: Windows Desktop, restored application window, light theme, Dashboard loaded
- Source pixels: `2028 × 1497`
- Implementation pixels: `1620 × 1020`

## Findings

No actionable P0, P1, or P2 visual differences remain for the requested shell behavior.

- The Windows window now exposes transparent pixels at its rounded outer corners instead of an opaque rectangular background.
- The application backdrop, navigation rail, workspace shell, and work cards retain the same layered translucent hierarchy used by the macOS glass shell.
- Custom Minimize, Maximize/Restore, and Close controls preserve Windows window actions after removing the native frame.
- Caption controls render in a body-level portal above full-screen onboarding and modal portals.
- Maximized windows remove rounded clipping; boot and recovery windows keep a native frame for safety.

## Evidence Notes

- Electron smoke captured a top-left application pixel with alpha `0` and observed the Windows platform class plus all three caption controls.
- The implementation screenshot shows the rounded transparent perimeter and the underlying desktop/application content through the shell gutters.
- A Windows Security Center prompt from the unrelated WorkBuddy application appeared during the screenshot and dimmed the Rudder content. It was not interacted with and is not part of the implementation.
- Focused unit and CSS regression tests cover platform defaults, transparent BrowserWindow options, rounded shape calculation, caption actions, body-level portaling, and maximized clipping.

final result: passed
