# Task 4 evidence

Focused tests cover stale/gap event handling, reconnect hydration, one-subscription retry successor flow, idempotent control availability, manifest-bound evidence, path/token redaction and exact 10,000-asset bounded-window endurance.

Commands:

- `npm run test:desktop -- tests/desktop/job-store.test.ts tests/desktop/job-controls.test.tsx tests/desktop/evidence-access.test.ts` — pass after RED/GREEN correction.
- `npm run test:desktop` — pass, 12 files, 25 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `npm run test:e2e:desktop -- tests/desktop/job-progress.e2e.test.ts` — blocked before Electron launch by host storage: `Error: ENOSPC: no space left on device, mkdir .../test-results`. No GUI evidence was claimed. Endurance logic passed in `tests/desktop/endurance.test.ts`.
