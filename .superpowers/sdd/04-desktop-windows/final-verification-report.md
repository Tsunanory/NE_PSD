# Lane D final verification and compliance matrix

Date: 2026-09-22  
Audited range: `0fc4a7039ae9ae83a68440001f77f11058e8f5de..631c73afff6c53b0cc0748bb8cfde676c1fedbf8`  
Correction commit: `c56d1063e7a624ebd09e403459d0a83a5e9b203a` (`fix(desktop): finalize lane verification and shell wiring`).

## Matrix

| Task | Checkbox | Result and evidence |
|---|---|---|
| T1 | baseline/imports/build outputs/fake selection | Implemented: `apps/desktop/tsconfig.json`, Vite, package docs, frozen contract imports; typecheck/build pass. Exact foundation/runtime records remain in `docs/qualification/runtime-lock.json`. |
| T1 | deterministic fake states and controls | Partial: contract fake provides states and D tests cover snapshots/setup states; exhaustive event-driver matrix is not in D. |
| T1 | IPC/window/root security tests | Implemented: `tests/desktop/ipc.test.ts`, `window-policy.test.ts`, `fake-services.test.ts`; full suite pass. |
| T1 | secure BrowserWindow, strict bridge, sender/origin policy | Implemented for tested shell; response validation is serializability validation rather than per-operation response schemas (implementation gap). |
| T1 | injected composition/subscriptions/diagnostics | Partial: startup and fake composition exist; renderer event subscription/job service composition is not fully wired (implementation gap). |
| T1 | required unit/build/e2e gates | Unit/type/build pass; Electron e2e blocked by process launch failure and low host storage. |
| T2 | synthetic graph, nested/linked/ambiguous cases and labelled evidence images | Partial: committed JSON contract fixtures and synthetic labelled previews exist; dedicated nested-PSB/linked-image fixture corpus is incomplete (implementation gap). |
| T2 | qualification invalidation and exact selector/variant checks | Implemented in `apps/desktop/src/main/evidence.ts` with focused tests; live B/A qualification is blocked externally. |
| T2 | native PSD/input/output selection and probes | Partial: canonical asset inspection and output probe exist; native Electron dialog IPC and cancellation state are not wired (implementation gap). |
| T2 | selector UI, fit explanations, three previews, portable references | Implemented as synthetic/unqualified shell; live profile save/rebind and human review integration are blocked. |
| T2 | setup unit/type/e2e gates | Unit/type/build pass; Electron e2e blocked by process launch failure/host capacity. |
| T3 | offline/wrong artifact/runtime/chat template/capability/capacity fixtures | Partial: synthetic evidence model-state covers identity, capabilities, capacity and scheduling; named fixture corpus for every failure case is incomplete (implementation gap). |
| T3 | endpoint trust and no fallback | Main loopback validator, redirect/timeout/size checks and tests implemented; no renderer model IPC wiring to exercise a live endpoint (implementation gap). |
| T3 | exact evidence and Q4/Q6/Q8 bounds | Implemented display/state checks; all live evidence blocked. |
| T3 | independent capabilities/text-only/scheduler policy | Implemented and tested; scheduled Luna remains deferred. |
| T3 | model unit/type/e2e gates | Unit/type/build pass; Electron e2e blocked. |
| T4 | deterministic event scripts and 10,000-asset endurance | Partial: sequence/gap/retry and 10,000 bounded-window logic tested; full pause/review/crash/restart scripted event corpus is incomplete (implementation gap). |
| T4 | stale events, controls, retry successor, evidence boundary | Implemented in `job-store.ts`, `job-controls.ts`, `evidence-access.ts`; focused/full tests pass. |
| T4 | snapshot-driven UI, visual review and safe close | Components and typed IPC are now rendered in synthetic shell; live service binding, elapsed-phase rendering, manifest hash validation and close event integration are incomplete (implementation gap). |
| T4 | unit/type/e2e/endurance gates | 29 unit tests/type/build pass; non-GUI endurance passes; Electron e2e blocked by process launch failure and ENOSPC history. |
| T5 | exact runtime manifest/vendor preparation | Fail-closed manifest uses only recorded values; Windows vendor/MCP/native/license inputs absent, correctly blocked. |
| T5 | packaging tests/runtime resolution/forbidden commands | Implemented focused tests and resources-path resolver; JSON schema is documentation-only and no full hash/architecture validator exists (implementation gap). |
| T5 | NSIS per-user install/retention | Builder recipe and installer comments exist; Windows installer/upgrade/uninstall not executed (external gate). |
| T5 | native smoke/offline/prerequisites | Fail-closed scripts and prerequisite messages exist; Windows native smoke/offline proof unavailable (external gate). |
| T5 | Windows acceptance/signature/evidence/handoff | Scripts/docs/handoff exist and explicitly record `BLOCKED — Windows host unavailable`; no release qualification claimed. |

## Fresh verification

- `npm run test:desktop` — PASS, 15 files, 29 tests.
- `npm run typecheck -w @ne-psd/desktop` — PASS.
- `npm run build -w @ne-psd/desktop` — PASS.
- `npm run check -w @ne-psd/contracts` — PASS.
- Focused packaging/runtime/prerequisite suites — PASS, 3 files, 4 tests.
- `node packaging/prepare-resources.mjs` — BLOCKED, exact missing vendor/MCP/native/qualification evidence listed by manifest.
- `npm run test:e2e:desktop -- tests/desktop/job-progress.e2e.test.ts` — FAIL/BLOCKED: Playwright `Error: Process failed to launch!`; host reported 397 MiB available and 100% capacity after the attempt. No GUI evidence claimed.
- `git diff --check` — PASS before report edits.

## Preserved state and gates

The pre-existing modified files `AGENTS.md`, `docs/superpowers/launch/04-desktop.txt`, and `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md` remain uncommitted and excluded. Windows 11 x64, Photoshop, exact Qwen, vendor runtime, signing, real visual review and live Electron remain blocked. No scheduler was created.

Observer handoff/checkpoint recorded in the shared project log.
