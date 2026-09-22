# D4 recovery report

Date: 2026-09-22  
Branch: `build/desktop`

## Checkout

- Starting HEAD: `7a5d77ed1494b327ab3c7a430ec2619c481f95d5`
- Starting status: only `AGENTS.md`, `docs/superpowers/launch/04-desktop.txt`, and `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md` were modified.
- Final implementation HEAD: `6c32f4e764cdcc5916dba2187d27075f02968b48`.

## RED/GREEN

`npm run test:desktop -- tests/desktop/job-store.test.ts tests/desktop/job-controls.test.tsx tests/desktop/evidence-access.test.ts` first failed because the store, controls and evidence-access modules did not exist. After implementation, one canonical temporary-path defect was reproduced and fixed; the focused command passed.

## Implementation

Added durable snapshot/event store with stale identity/sequence rejection, gap hydration, reconnect/disposal and retry successor handling; safe control availability/pending messages; manifest-bound evidence reads, committed-output confinement and log redaction; safe pause-and-close; typed retry/visual-review/attestation IPC; three-artifact/contact-sheet review surface; and a 10,000-asset bounded-window endurance test. No staging output is exposed as committed output.

## Commands and results

- Focused D4 suites — pass after correction.
- `npm run test:desktop` — pass, 12 files, 25 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `npm run test:e2e:desktop -- tests/desktop/job-progress.e2e.test.ts` — blocked before Electron launch by host storage: `Error: ENOSPC: no space left on device, mkdir .../test-results`. Non-GUI endurance passed via `tests/desktop/endurance.test.ts`.

## Files and preservation

Changed only D-owned `apps/desktop/`, `tests/desktop/`, `docs/desktop/`, and this report. Implementation commit: `6c32f4e764cdcc5916dba2187d27075f02968b48`. The three pre-existing documentation modifications were preserved and excluded. Root manifests, lockfiles, contracts, config.toml and A/B/C paths were untouched.

## External gates

Real Photoshop recovery, A/C/core visual-review validation, Windows acceptance, signing and live Electron GUI remain blocked. Fake endurance and evidence tests do not imply Photoshop performance or release qualification.

Observer checkpoint recorded in the shared project log.
