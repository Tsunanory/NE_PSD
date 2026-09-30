# D-R1 desktop service and IPC boundary — 2026-09-30

Status: implemented and fake-tested on macOS. Production service composition remains blocked until A supplies the frozen `JobService` and `SetupService`; no fake is selected in production. This is not Windows, Photoshop, Qwen, signing or release qualification.

## Delivered boundary

- `startDesktop` accepts injected frozen services. With none, production fails closed. Development fakes require both `NODE_ENV=development` and `NE_PSD_DEV_FAKE=1`; `NE_PSD_DEV_FILE=1` uses the built renderer in the shell test. These flags cannot select fakes in production.
- Each fixed IPC channel has strict request and response schemas from `@ne-psd/contracts`. Void service methods use `null` on the Electron wire and `Promise<void>` in the renderer. Job events are validated before forwarding; preload validates them again. The bridge exposes typed operations and subscription disposal.
- Main checks the sender window, main frame and expected URL. Main-owned UUID root handles bind setup files and JobSpec file references. Resolution checks current canonical containment, rejects absolute/traversal/stale handles and symlink escape before service invocation. D-R2 must register handles through native pickers and create job-owned working copies; this packet deliberately does not accept renderer paths as authority.
- Service errors cross IPC as stable safe codes without backend messages or paths. Fake snapshots use the frozen snapshot shape; sequence numbers remain in `JobEvent`.

## Verification

Toolchain: `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin` (`node v22.23.2`, `npm 10.9.8`), recorded by A in `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/core/docs/qualification/toolchain-2026-09-30.md`. Earlier Node 25 results were diagnostic only.

| Command in `.worktrees/desktop` | Exit | Result |
|---|---:|---|
| `npm run test:desktop -- tests/desktop/ipc.test.ts` (RED, Node 25 diagnostic) | 1 | 5 expected failures before implementation |
| `npm run test:desktop -- tests/desktop/ipc.test.ts tests/desktop/ipc-handler.test.ts tests/desktop/fake-services.test.ts tests/desktop/window-policy.test.ts` (pinned Node 22) | 0 | 12 tests passed after implementation |
| `npm run typecheck -w @ne-psd/desktop` (pinned Node 22) | 0 | strict TypeScript check passed |
| `npm run build -w @ne-psd/desktop` (pinned Node 22) | 0 | Vite renderer and TypeScript build passed |
| `npm run test:e2e:desktop -- tests/desktop/shell.e2e.test.ts` (pinned Node 22) | 1 | Electron `Process failed to launch!`; host GUI gate unresolved |
| `npm run test:desktop` (pinned Node 22, while R3 model files were being edited) | 1 | 14 files/60 tests passed; concurrent model test failures and loopback `listen EPERM` in sandbox. Repeat after R3 commit. |
| `npm run test:desktop` (pinned Node 22, after R3 stabilized, while R5b was implementing runtime files) | 1 | 14/16 files and 66/70 tests passed; four concurrent RED failures in R5b-owned `prerequisites.test.ts` and `runtime-resolution.test.ts`. No R1 boundary test failed. Stable integrated rerun belongs to final R6. |

## Dependencies and next packet

- A: provide a production composition entry that injects the frozen `JobService` and `SetupService` into `startDesktop('production', services)`; preserve exact method signatures. No shared schema change requested.
- D-R2: register template/assets/output/working handles only after native selection and verification; qualify through a job-owned working template. Do not expose `RootRegistry.register` through renderer IPC.
- Dev tooling: a `dev:fake` script can set `NODE_ENV=development NE_PSD_DEV_FAKE=1`; built-renderer smoke also sets `NE_PSD_DEV_FILE=1`. R5b owns `apps/desktop/package.json` during this continuation.
- Electron GUI, Photoshop, model and Windows live gates are unresolved. Fake tests do not satisfy them.

Commit: see lane handoff; path-limited R1 commit recorded after verification.
