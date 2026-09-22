# Task 2 evidence

Development evidence only. Synthetic fixtures cover strict selector binding, duplicate/ambiguous candidates, changed source digest, unsupported fit modes, stable asset IDs, output/input overlap, symlink rejection and disposable output write/rename/remove probes. Synthetic previews are explicitly labelled and do not establish Photoshop or model qualification.

Commands:

- `npm run test:desktop -- tests/desktop/qualification.test.ts tests/desktop/setup-files.test.ts` — pass, 2 files, 4 tests.
- `npm run test:desktop` — pass, 6 files, 13 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `npm run test:e2e:desktop -- tests/desktop/setup.e2e.test.ts` — blocked: Electron process failed to launch on this host.
