# Bilingual first-reader study protocol

This is a research protocol and blank result template. It does not record or
claim study results.

## Participants

Recruit at least ten people who have not used Rudder and have not read its
documentation: at least five primarily reading English and five primarily
reading Simplified Chinese. Record prior experience with agent tools, but do
not teach Rudder terminology before the session.

## Materials and setup

- Use the same staged documentation revision for every participant.
- Start in a clean browser profile on desktop or mobile.
- Give each participant only the documentation home URL in their language.
- Screen-record or take timestamped notes with consent.
- Do not answer product questions until the timed tasks finish.

## Procedure

1. Ask the participant to read the home page. After two minutes, ask: “What is
   Rudder, in your own words?”
2. Ask when they would start work in Chat and when they would create an Issue.
3. Ask them to explain the difference between an Agent, an Agent Run, and the
   runtime that performs the work.
4. Ask where they expect to find the result and where a review decision stays.
5. Return to the home page. Ask them to find the Quick Start or the entry for
   creating the first task. Stop after 60 seconds.
6. Ask what, if anything, was ambiguous. Record the words and route they used,
   without correcting their answer first.

## Scoring

Score each comprehension question as `correct`, `partial`, or `incorrect`
against the definitions in the content manifest and terminology glossary.
`Partial` does not count as passing.

The rollout gate is:

- at least 90% correctly explain within two minutes what Rudder is, the
  Chat/Issue choice, Agent versus Agent Run/runtime, and where result/review
  evidence lives;
- 100% find Quick Start or the first-task entry within 60 seconds.

Do not average English and Chinese into a passing score that hides a locale
failure. Report each locale and the combined sample.

## Blank session record

| Field | Value |
| --- | --- |
| Participant ID | |
| Locale | English / Simplified Chinese |
| Device | |
| Prior agent-tool experience | None / occasional / frequent |
| Consent recorded | Yes / No |
| Rudder explanation, 2 min | Correct / Partial / Incorrect |
| Chat versus Issue | Correct / Partial / Incorrect |
| Agent versus Run/runtime | Correct / Partial / Incorrect |
| Result and review location | Correct / Partial / Incorrect |
| Found first action, 60 sec | Yes / No |
| Route opened | |
| Time to first action | |
| Verbatim ambiguity notes | |
| Observer | |
| Date and revision | |

## Blank aggregate result

| Measure | English n/5+ | Chinese n/5+ | Combined | Threshold | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Explains Rudder | | | | 90% | Not evaluated |
| Chooses Chat or Issue | | | | 90% | Not evaluated |
| Distinguishes Agent, Run, runtime | | | | 90% | Not evaluated |
| Finds result and review record | | | | 90% | Not evaluated |
| Finds first action within 60 sec | | | | 100% | Not evaluated |

Keep the final conclusion as `Not evaluated` until eligible observations have
been completed and attached or linked with consent-safe evidence.
