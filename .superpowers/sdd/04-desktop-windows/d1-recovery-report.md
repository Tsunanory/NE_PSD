# D1 recovery report

Date: 2026-09-22
Branch: `build/desktop`

## Checkout

- Starting HEAD: `0fc4a7039ae9ae83a68440001f77f11058e8f5de`
- Starting status: `M AGENTS.md`, `M docs/superpowers/launch/04-desktop.txt`, `M docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md`
- Final implementation HEAD: `da9c5e3097d869575d014f04ac0764e3fbd80011`

## Findings and correction

Focused inspection reproduced two Task 1 boundary defects. Production sender/navigation validation expected the placeholder `file:///app/index.html`, while `BrowserWindow.loadFile` serves the built renderer at the path adjacent to compiled main code (`dist/renderer/index.html`). The IPC request union was channel-agnostic, accepted payloads for the wrong operation, and setup/diagnostic channels were declared but not registered.

The smallest fix derives the packaged renderer URL from the compiled main module, uses channel-specific strict Zod schemas, registers setup handlers with the fake setup service and a deterministic diagnostic response, and adds RED/GREEN coverage. Root confinement remains canonical-realpath based and rejects traversal, symlink escape, stale generation handles, and nonexistent paths. Preload remains fixed and context-isolated.

## Commands and results

- `npm run test:desktop -- tests/desktop/ipc.test.ts tests/desktop/window-policy.test.ts tests/desktop/fake-services.test.ts` — pass after correction, 3 files, 8 tests.
- `npm run test:desktop` — pass, 4 files, 9 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass; Vite renderer and TypeScript build completed.
- `npm run test:e2e:desktop -- tests/desktop/shell.e2e.test.ts` — blocked on this macOS host: Playwright reports `Error: Process failed to launch!`; no Electron window was created. This is not live Electron/Windows qualification.

The focused test was intentionally run RED before editing: the old channel-union accepted `{spec:{}}` for `job.pause`, and the old production sender check rejected the actual packaged renderer URL. It passed GREEN after the correction.

## Changed files

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/ipc-schema.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/window.ts`
- `tests/desktop/ipc.test.ts`
- `tests/desktop/window-policy.test.ts`

Implementation commit: `da9c5e3097d869575d014f04ac0764e3fbd80011` (`fix(desktop): recover packaged IPC boundaries`).

## Preserved and blocked gates

The three pre-existing modified documentation files (`AGENTS.md`, `docs/superpowers/launch/04-desktop.txt`, `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md`) were preserved and excluded from the implementation commit. Windows 11 x64, signed packaging, Photoshop, exact qualified model, and real Electron/Playwright GUI evidence remain external release gates. No fake evidence is presented as live qualification.

Observer checkpoint recorded in the shared project log.
