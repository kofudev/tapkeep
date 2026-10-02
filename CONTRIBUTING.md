# Contributing

Tapkeep keeps one loop small: record a working path, replay it after changes, inspect a failure.

```sh
npm ci
npx playwright install chromium
npm test
```

Use `npm run dev -- studio <app-url>` for local development. Backend changes compile with `npm run build`. The Studio uses plain JavaScript and CSS in `public/`.

Tests include real browser recording and replay. For a bug, include a minimal page or fixture and expected versus actual behavior. Do not include credentials or private application data.

Keep pull requests focused. Update the README when supported actions or CLI behavior changes. Run `npm test` and `npm pack --dry-run` before opening a PR.

Project layout:

- `src/recorder.ts`: browser events and checkpoint capture
- `src/runner.ts`: isolated replay and failure evidence
- `src/flow.ts`: validation and flow persistence
- `src/studio.ts`: authenticated loopback server
- `public/`: Studio interface
- `tests/`: behavior and browser integration checks

For security issues, contact the maintainer privately through their GitHub profile rather than posting secrets in an issue.
