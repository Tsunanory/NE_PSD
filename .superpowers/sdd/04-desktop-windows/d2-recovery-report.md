# D2 recovery report

Date: 2026-09-22  
Branch: `build/desktop`

## Checkout

- Starting HEAD: `31149ec84792191ff80b292d15c1848c32340717`
- Starting status: only the three preserved documentation files were modified.
- Final implementation HEAD: `3d2e5771ee94868483c7c8617e457902ccd2c3c9`.

## RED/GREEN

`npm run test:desktop -- tests/desktop/qualification.test.ts tests/desktop/setup-files.test.ts` was intentionally run RED before implementation: both suites failed to import the absent `evidence.js` and `setup-files.js` modules. After implementation the same command passed with 2 files and 4 tests.

## Implementation

Added synthetic inspection/qualification validation, structural selector and variant checks, supported-fit checks, linked-isolation evidence checks, profile digest binding, canonical setup-root and asset inspection utilities, stable asset IDs, output write/rename/remove probing, and portable references. Added a renderer setup wizard with route/fingerprint details, three labelled synthetic previews, exact Russian fit explanations, disabled unsupported modes, keyboard-usable controls, and an honest synthetic/unqualified state. The fake setup service now retains inspection reports and returns profiles only through qualification validation.

## Commands and results

- `npm run test:desktop -- tests/desktop/qualification.test.ts tests/desktop/setup-files.test.ts` — pass, 2 files, 4 tests.
- `npm run test:desktop` — pass, 6 files, 13 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `npm run test:e2e:desktop -- tests/desktop/setup.e2e.test.ts` — blocked; Playwright launched one test but Electron reported `Error: Process failed to launch!`. No GUI evidence was claimed.

## Changed paths

`apps/desktop/`, `tests/desktop/`, `docs/desktop/`, and this report only. Implementation commit: `3d2e5771ee94868483c7c8617e457902ccd2c3c9`. No root manifests, lockfiles, contracts, config, A/B/C paths, or preserved documentation files were changed.

## External gates

Real Photoshop/template qualification, linked-resource isolation against Photoshop, exact model qualification, Windows 11 x64, signing, and live Electron GUI evidence remain blocked. Synthetic behavior does not imply live qualification.

Observer checkpoint recorded in the shared project log.
