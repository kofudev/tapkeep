# Tapkeep

## Problem

After a code change, developers manually repeat the same few browser paths. A successful build does not establish that a form still submits, navigation reaches the right page, or the browser runs without errors. Beginners often have no end-to-end tests to answer those questions.

## Solution

Record one working path in a real browser. Preserve its actions and simple page expectations. Replay it from a local Studio, on source changes, or in CI. Stop at the first changed action or expectation and show evidence.

## Difference

The recorder includes settled URL/title/headings checkpoints. The user can add outcome text checks while recording. The product stays centered on the record/replay loop, with readable JSON and no model calls. Existing tools offer more comprehensive testing or automation; Tapkeep trades breadth for a smaller starting step.

## V1

- Clicks, text fields, single selects, Enter submissions
- URL/title/headings checkpoints and explicit text checks
- Browser and same-origin network errors
- Failure screenshot, with recorded secret fields masked
- Local Studio, CLI, watch mode and CI exit codes
- Environment references for sensitive fields

## Identity

Name: **Tapkeep**. Tagline: **Keep working paths working.**

GitHub description: **Record a working path through your web app. Know the first step that breaks.**

The logo draws a returning path with a coral endpoint. Studio uses warm paper (`#f5f3ed`), ink (`#1d2b31`), sage (`#bfd8ce`) and coral (`#fc684e`). System sans typography keeps installation independent of external font services; Cascadia Code / SFMono / Consolas marks technical details. The interface uses a flow rail and a numbered step ledger.

## Next

Editable checkpoints, viewport profiles, reusable setup paths and export to ordinary Playwright tests. Prioritize real recording/replay defects over adding unrelated dashboards.
Kofu
KOFUDEV
