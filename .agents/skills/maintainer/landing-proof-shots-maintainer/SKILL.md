---
name: landing-proof-shots-maintainer
description: |
  Maintain the Rudder landing-shot workflow. Use when the user wants either
  polished app screenshots captured for them or a seeded dev/demo organization
  so they can capture screenshots themselves. Enforces full-page whole-app
  screenshots instead of browser-window or cropped-partial captures.
---

# Landing Proof Shots Maintainer

Use this skill to maintain a reliable, presentation-ready workflow for Rudder
landing-page and demo screenshots.

This skill supports two operating modes and should surface both up front unless
the user already chose one:

1. capture mode: seed the org and take the screenshots for the user
2. seed-only mode: seed the org and hand the environment back so the user can
   take screenshots themselves

Important:

- both modes must use the landing-quality mock dataset maintained by
  `mock-data-maintainer`
- seed-only mode is not a lighter fallback dataset
- do not substitute a small import, a partial org copy, or a simplified sample
  when the user asked for the landing-shot dataset

## Use This Skill For

- landing page screenshot generation
- demo-deck product stills
- seeding a realistic Rudder org for self-serve screenshots
- requests like:
  - "mock some real-looking org data and screenshot it"
  - "give me demo data and I'll screenshot it myself"
  - "don't give me browser screenshots"
  - "each major feature should have a screenshot"
  - "include chat creating an issue"
  - "show issues across multiple projects"

## Do Not Use This Skill For

- ad hoc debugging screenshots where realism does not matter
- generic desktop screenshots outside Rudder
- narrow cropped captures of a single widget when the user asked for a page
- cases where the user only wants a one-off current state and no seeded data

## Core Outcome

Produce one of these clean outcomes:

- a full screenshot set the user can present directly
- a seeded dev/demo org with clear routes so the user can take those shots

The underlying demo data should be the same in both modes and should come from
`mock-data-maintainer`:

- same realistic projects, issues, agents, approvals, chat, costs, and org data
- same screenshot-worthy density and statefulness
- same readiness for major feature surfaces

In both cases the baseline quality bar is:

- no browser chrome
- no desktop wallpaper or OS overlays
- no stale or broken pages
- no obviously fake empty-state data
- full-page whole-app screenshots, not clipped subsections

## Default Placement

Primary outputs usually go under:

- `/tmp/rudder-landing-proof-shots/shots`
- `/tmp/rudder-landing-proof-shots/manifest.json`

## Required First Decision

At the start, choose one mode:

### Mode A: Capture For The User

Use when the user wants a finished screenshot bundle.

Deliver:

- seeded org
- screenshot files
- manifest
- final file list

### Mode B: Seed For User Self-Capture

Use when the user wants you to prepare data but prefers to drive the capture.

Deliver:

- seeded org name and id
- base URL
- the exact routes worth opening
- any credentials or runtime notes required locally

Do not keep capturing after switching into seed-only mode unless the user asks.
Do keep the seeded data at the same quality bar as capture mode.

## Default Workflow

### 1. Define The Surface List

Map the request into a concrete screenshot set.

Common default set:

- dashboard
- chat proposal review
- chat created-issue state
- issue list
- issues across multiple projects
- approval review
- heartbeats
- costs
- org structure

If the user asks for heavier issue coverage, seed more projects and cross-project
issue density before capture.

### 2. Seed An Isolated Demo Org

Prefer the repository's existing mock-data seed/capture script:

```bash
LANDING_SHOTS_SKIP_CAPTURE=1 LANDING_SHOTS_HOLD_OPEN=1 \
node cli/node_modules/tsx/dist/cli.mjs \
.agents/skills/maintainer/mock-data-maintainer/scripts/capture-landing-proof-shots.ts
```

Why:

- it creates an isolated Rudder instance for landing shots
- it seeds realistic projects, agents, issues, approvals, chat, costs, and org data
- it avoids polluting the developer's normal local environment

The legacy `scripts/capture-landing-proof-shots.ts` path is kept as a wrapper
for compatibility, but the dataset and implementation live under
`mock-data-maintainer`.

If the user chose seed-only mode, this same seeded dataset is still the target.
Only the capture responsibility changes.

Record:

- `baseUrl`
- seeded org id and issue prefix
- chat id
- approval id
- output directory

### 3. Verify The Environment Before Capture

Do not touch capture until the instance is confirmed alive.

Check:

```bash
curl http://127.0.0.1:3101/api/health
curl -I http://127.0.0.1:3101/RUD/dashboard
```

Rules:

- if health fails, restore the seeded instance first
- do not keep debugging screenshots against a dead port
- prefer `127.0.0.1` when `localhost` behaves inconsistently in browser tooling

### 4. Capture The Entire App Page

This is the most important constraint.

When capturing screenshots:

- capture the whole Rudder page for that route
- include the full app shell for the state being presented
- avoid cropped component-only images
- avoid locator clips unless the user explicitly asked for a detail shot

What the user should see in the final PNG:

- the complete page surface
- correct layout, hierarchy, and surrounding context
- no browser tabs, URL bar, or other browser chrome

Wrong:

- only the chat panel
- only the issues table
- only a modal body
- a desktop region screenshot of a browser window

Right:

- the entire page route rendered as a clean app screenshot

### 5. Prefer App-Style Capture, Not Browser-Window Photos

Default capture path:

- Playwright
- system Chrome executable when needed
- page-level screenshot flow that preserves the whole app page

Avoid by default:

- manual desktop screen capture
- browser-window photos with URL bar or tabs
- monitor-region crops

### 6. Manufacture Stateful Screens Intentionally

Some screenshots require interaction first.

For chat issue creation:

1. open the seeded chat
2. submit the user request that should create an issue proposal
3. wait for the proposal review block
4. capture the full chat page in proposal state
5. approve it
6. wait for the "Created issue ..." state
7. capture the full chat page again in created-issue state

For issue coverage:

- seed multiple projects when requested
- create enough issues that the page looks like a working org
- make sure the issue list visibly spans multiple projects when that is part of the ask
- capture the full issues page, not just the table region

### 7. Generate A Manifest

After capture, write a manifest so the bundle is inspectable and reusable.

Expected fields:

- generation timestamp
- base URL used
- screenshot filenames
- the mode used: `capture` or `seed-only`
- short notes about the environment or method

### 8. Hand Off Clearly

For capture mode, return:

- the screenshot directory
- the final file list
- the manifest path

For seed-only mode, return:

- org name and id
- base URL
- the routes the user should open
- any caveat that materially affects local capture

Do not hand back a downgraded org here. The user should be able to capture the
same surfaces they would have received in capture mode.

## Judgment Rules

### Must Stay True

- screenshots must be presentation-ready
- data should look like a plausible operating organization
- screenshots must cover the user-requested major product surfaces
- chat and issue screenshots must show meaningful state, not empty shells
- issue-heavy pages should visibly span multiple projects when requested
- full-page whole-app capture beats clipped partial capture by default

### What To Avoid

- continuing after the demo server has died
- using browser chrome screenshots when the user asked for app-style shots
- mistaking browser-launch problems for Rudder page failures
- clipping down to one component when the user asked for a page
- mixing unrelated personal browser state into the demo capture workflow
- treating seed-only mode as permission to use smaller or different data than the
  landing-shot mock org

## Troubleshooting

### Health Checks Fail

- restart the isolated landing-shot seed instance
- do not debug capture before the app is reachable again

### Browser Opens But Shows The Wrong Thing

- do not assume a new browser window was created successfully
- verify the actual page URL and route state before capture
- prefer direct Playwright navigation inside the capture flow

### Capture Looks Like A Browser Screenshot

If the image includes:

- browser tabs
- the URL bar
- browser toolbars
- desktop wallpaper
- window thumbnails
- cropped-only content with missing page context

then the method is wrong for the task.

Switch back to clean whole-page app capture.

### Bundled Playwright Browser Fails To Launch

- use system Chrome with `executablePath`
- keep the same page-level capture flow

## Output Expectations

Successful capture mode should leave:

- a full screenshot set in `/tmp/rudder-landing-proof-shots/shots`
- a `manifest.json`
- app-style PNGs ready for direct use in marketing or product presentation

Successful seed-only mode should leave:

- a live seeded Rudder org
- clear routes for self-serve capture
- enough realistic data that the user does not need more prep work first

## Non-Goals

This skill is not responsible for:

- redesigning the UI before capture
- editing the landing page itself
- writing copy that explains the screenshots

Those can follow after the screenshot or seeding workflow if the user asks.
