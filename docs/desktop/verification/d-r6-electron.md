# D-R6a Electron launch and E2E harness — 2026-09-30

Status: local launch cause identified; four focused fake-mode Electron E2E tests pass.

Environment: macOS 26.6.1 arm64, 33 GiB free at diagnosis, pinned Node 22.23.2/npm 10.9.8, Electron 41.0.0 arm64, Playwright 1.63.0. The installed `Electron.app` executable is present and executable, ad hoc signed, with no quarantine attribute observed (only `com.apple.provenance`). No duplicate Electron installation or version change was made.

The ordinary filesystem sandbox aborts even `Electron --version` with SIGABRT. The macOS incident report places the abort in `_RegisterApplication`/`NSApplication sharedApplication`, before the NE PSD entry executes. The same binary reports `v41.0.0` outside that sandbox. A focused Playwright run outside the sandbox launches the window, so the host and installed binary are usable for local GUI checks; the test command requires that narrow execution permission.

The first launched window displayed an empty renderer because Vite built `/assets/...` URLs for a `file://` page. R1 corrected `apps/desktop/vite.config.ts` with `base: './'` in commit `8b6a87e`; rebuilt HTML now references `./assets/...` and React renders.

The next launched shell showed no `window.desktop`. Captured Chromium stderr: `Unable to load preload script: .../dist/preload/index.js` and `SyntaxError: Cannot use import statement outside a module` from Electron's sandbox bundle. The TypeScript output began with `import './api.js'`. R1 bundled a single CommonJS preload and pointed BrowserWindow to it, retaining context isolation, sandbox and disabled Node integration. The shell bridge test then passed.

The E2E harness now launches the explicit development fake path (`NODE_ENV=development`, `NE_PSD_DEV_FAKE=1`, `NE_PSD_DEV_FILE=1`) through the installed Electron executable, with one worker to respect the single-instance lock. The previous setup/model/job E2E tests selected production while expecting synthetic fake data; that mismatch is removed. Their selectors now use current roles and visible blocked-state text. This is a launch and shell packet; no 10,000-asset GUI endurance or Windows acceptance result is claimed.

Commands/results:

- Pinned Node `npm run build -w @ne-psd/desktop`: passed after relative asset fix.
- In sandbox: `Electron --version` exit 134/SIGABRT; focused Playwright shell: `Process failed to launch!`.
- Outside sandbox: `Electron --version` exit 0 (`v41.0.0`); focused Playwright reached renderer. Before corrections, four tests failed on missing preload bridge and stale selectors.
- After R1's CommonJS preload correction and harness updates, `npm run test:e2e:desktop -- tests/desktop/shell.e2e.test.ts tests/desktop/setup.e2e.test.ts tests/desktop/model-setup.e2e.test.ts tests/desktop/job-progress.e2e.test.ts --reporter=list` passed: 4 tests, 6.5 seconds, one worker. The shell assertion saw the isolated bridge with `startJob` and `subscribeJob`; renderer `process` was unavailable.

GUI 10,000-asset endurance and live job/review interactions remain for R4/App integration. Production services, native Windows runtime, Photoshop/model qualification and signed installer remain separate gates.
