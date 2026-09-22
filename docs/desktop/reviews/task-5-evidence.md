# Task 5 evidence

Exact available runtime values were taken from `docs/qualification/runtime-lock.json`: Node 22.23.2 with the recorded Windows x64 checksum, Electron 41.0.0 with its recorded integrity, and no invented vendor resources. The manifest is intentionally `blocked`.

Commands:

- `npm run test:desktop -- tests/desktop/packaging.test.ts tests/desktop/runtime-resolution.test.ts tests/desktop/prerequisites.test.ts` — pass, 3 files, 4 tests.
- `npm run test:desktop` — pass, 15 files, 29 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `node packaging/prepare-resources.mjs` — blocked exactly: runtime manifest not ready; missing Windows vendor/MCP/native/qualification evidence.
- `node packaging/verify-bundle.mjs` — blocked exactly: runtime manifest status blocked.
- `node packaging/native-smoke.mjs` — blocked exactly: native smoke requires Windows 11 x64.
