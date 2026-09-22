# Task 1 report: strict desktop shell, IPC and independent fakes

## Implementation summary

Added a strict Electron desktop boundary with fixed preload operations, main-side request validation, sender/origin and navigation policy, canonical root-handle checks, secure BrowserWindow preferences, renderer shell, and contract-backed independent fake services. Production fake selection is not derived from environment variables or query strings.

## Files changed

`apps/desktop/`: main IPC/window/path/runtime/service modules, preload bridge, renderer shell, Vite entry/config, CSP HTML, styles and messages.

`tests/desktop/`: IPC, window-policy and fake-service tests, Playwright config/e2e smoke, fake re-exports and scenarios.

`docs/desktop/`: architecture, dependency requests and review evidence documents.

## RED

Command:

```text
/private/tmp/node-v22.23.2-darwin-arm64/bin/npm run test:desktop -- tests/desktop/ipc.test.ts tests/desktop/window-policy.test.ts tests/desktop/fake-services.test.ts
```

Result: 3 suites failed before running because `apps/desktop/src/main/services.js`, `ipc-schema.js` and `window.js` did not exist. This was the expected missing-behavior failure.

## GREEN and final verification

- `npm run typecheck -w @ne-psd/desktop`: pass.
- `npm run build -w @ne-psd/desktop`: pass.
- `npm run test:desktop`: 4 files, 7 tests passed.
- Focused IPC/window/fake command: 3 files, 6 tests passed.
- `npm run test:e2e:desktop -- tests/desktop/shell.e2e.test.ts`: blocked by missing Playwright Chromium executable; no browser binary is installed on this host.

## Self-review

Renderer receives only fixed bridge functions. Main validation rejects unknown channels, malformed strict JobSpec payloads, absolute/platform paths, and untrusted sender origins. BrowserWindow settings enable context isolation and sandbox and disable Node integration. Navigation and popups are denied outside the packaged origin. Root-handle resolution rejects traversal and symlink escape when paths exist.

## Deviations and concerns

The e2e shell gate is not live-verified because the required browser binary is absent. Electron/Windows/Photoshop/model live qualification remains external. The root lockfile was not changed; no dependency request beyond documenting frozen versions was needed.

## Observer checkpoint

Completed. No reusable skill observation was found; checkpoint recorded in the shared project observation log.

## Commit

`39d5e778043619a0d801587211bf83720022685f` (amend updates this report with the final commit identity).
