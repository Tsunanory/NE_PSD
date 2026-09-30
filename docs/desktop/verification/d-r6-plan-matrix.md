# D-R6 desktop and Windows plan matrix — 2026-09-30

Authority: `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md`, Tasks 1–5 and its 13-case Windows matrix. Snapshot: `838f3f4` plus concurrent R1/R5 uncommitted integration work. Statuses here describe executed evidence, not checkbox completion. **Fake-tested** means a local deterministic test passed; **partial** means a required path is incomplete or only a helper is tested; **in flight** means another worker is actively implementing it; **external** needs the Windows host, real Photoshop/model/vendor/signing evidence or A/C's qualified service. No Windows case has passed.

## Task checkbox reconciliation

| Plan line | Requirement and current evidence | Status / remaining gate |
|---|---|---|
| T1.1 / 59 | `docs/desktop/architecture.md`, `docs/desktop/dependency-requests.md`, strict desktop TypeScript/Vite and separate main/preload/renderer; `d-r1.md`. | Fake-tested; A owns final root pins/lock and production adapter. |
| T1.2 / 60 | `tests/desktop/fake-services.test.ts`, `fixtures/scenarios.ts`, `main/fake-job-service.ts`; 10,000 fake assets and frozen snapshots in `d-r6-endurance.md`. | Partial: deterministic coverage exists, but the entire listed state/asset-status matrix is not evidenced. |
| T1.3 / 61 | `tests/desktop/ipc.test.ts`, `ipc-handler.test.ts`, `window-policy.test.ts`; 12 focused tests in `d-r1.md`. | Fake-tested for covered trust cases; Windows junction behavior untested. |
| T1.4 / 62 | `main/window.ts`, `ipc.ts`, `ipc-schema.ts`, `paths.ts`, `preload/api.ts`; Electron shell E2E in `d-r6-electron.md`. | Fake-tested on macOS; packaged Windows shell still external. |
| T1.5 / 63 | Injected services, strict IPC, subscriptions, single-instance and safe errors in `main/index.ts`, `ipc.ts`; bounded asynchronous digest-verified image reads in `evidence.ts` and `evidence-access.test.ts` (`838f3f4`). | Partial: production composition A-dependent; shared job/evidence IPC wiring in flight; exact contract provenance passes through schemas, but no live bundle proven. |
| T1.6 / 64 | Focused unit/typecheck/build reports in `d-r1.md`; four macOS Electron E2E tests in `d-r6-electron.md`. | Partial: baseline fake shell is proven; repeat integrated checks after current wiring, then Windows qualification. |
| T2.1 / 76 | `fixtures/template-cases.ts`, setup components and `d-r2-components.md`; synthetic three-image previews. | Partial: fixture graph and visible sentinel/geometry particulars need explicit assertion against the whole listed case set. No real PSD inference. |
| T2.2 / 77 | `qualification.test.ts`, `setup-components.test.tsx`, `setup-files.test.ts`; digest/selector/linked checks in `main/evidence.ts`. | Fake-tested for covered assertions; service-side start admission and live geometry depend on A/B. |
| T2.3 / 78 | `main/setup-files.ts`, `setup-controller.ts`, `paths.ts`; controlled asset/output components and tests. | In flight: R1 native-picker/working-copy/IPC integration. Free-space and writable probe helpers exist; full selected-root flow not yet integration-tested. |
| T2.4 / 79 | `SelectorPicker.tsx`, `FitControls.tsx`, `QualificationView.tsx`; six component tests in `d-r2-components.md`. | Fake-tested components; real B selector/sentinel qualification external. |
| T2.5 / 80 | Three digest-matched previews and explicit confirmation in `QualificationView.tsx`; synthetic gated to explicit fake mode. | In flight: R5 `SetupWizard` wiring and R1 trusted controller. Actual preview byte/digest validation in `setup-controller.ts` remains a local trust-boundary gap; A/C human gate external. |
| T2.6 / 81 | `setup.e2e.test.ts` included in four passed macOS fake Electron E2E tests (`d-r6-electron.md`). | Partial: old E2E covers shell/setup state, not complete keyboard-only qualified flow. Real PSD and Windows rebinding external. |
| T3.1 / 93 | `fixtures/model-cases.ts`, `model-setup.test.tsx`; `d-r3-model.md`. | Fake-tested; synthetic fixture is not a C qualification record. |
| T3.2 / 94 | Exact artifact/capability/review-gate guards in `renderer/setup/model-qualification.ts`; `model-endpoint.test.ts`; 25 focused tests in `d-r3-model.md`. | Fake-tested for selection and loopback policy; scheduled policy remains A's `JobService.validate`. |
| T3.3 / 95 | `main/model-endpoint.ts` bounds fixed loopback GETs, time and bytes; `ModelSetup.tsx` displays staged readiness. | In flight: R1 catalog/recheck IPC and R5 wizard wiring. C-qualified runtime API and exact artifact are external. |
| T3.4 / 96 | Model report and Q4/Q6/Q8 estimates in `ModelSetup.tsx`; tests in `d-r3-model.md`. | Partial: UI can display supplied metrics; actual same-corpus capacity/latency and headroom evidence external. Frozen SetupService response lacks the full trusted C report. |
| T3.5 / 97 | Separate JSON/tools/vision booleans and text-only warning in `ModelSetup.tsx`; `d-r3-model.md`. | Fake-tested display; fresh per-asset runtime review and no-fallback enforcement require A/C. No scheduler is created. |
| T3.6 / 98 | 25 focused tests, typecheck/build in `d-r3-model.md`; model E2E among four launched tests in `d-r6-electron.md`. | Partial: full integrated ready/recheck flow in flight; no real Qwen/Windows qualification. |
| T4.1 / 110 | `fixtures/job-events.ts`, `fake-job-service.ts`, `endurance.test.ts` and `d-r6-endurance.md`. | Partial: 10,000 deterministic fake assets supported; listed recovery/reviewer-offline scripts need A-backed evidence. |
| T4.2 / 111 | `job-store.test.ts`, `job-controls.test.tsx`, `evidence-access.test.ts`; `d-r4-components.md`. | Fake-tested covered event/control paths. Frozen `JobSnapshot` lacks sequence cursor and phase start, limiting exact gap proof and elapsed phase display. |
| T4.3 / 112 | `job-store.ts`, `JobView.tsx`, `AssetList.tsx`, `job-controls.ts`; ≤50 rows and authoritative complete counts. | In flight: R5 App mounting and R1 IPC. No accurate phase elapsed value exists in frozen snapshot. |
| T4.4 / 113 | `ReviewEvidence.tsx`, `main/evidence.ts`, `job-session-controller.ts`, `fake-job-service.ts`, focused tests; verified three images/contact sheet, explicit synthetic flag and committed-record digest. | Partial: R1 IPC and R5 view wiring in flight; A must source trusted manifests/output records and reject stale/conflicting attestations. Development fake uses real fixture bytes, never a committed-output claim. Legacy `evidence-access.ts` opener is weaker and must not be used as committed proof. Blocked/failed detail history and diagnostic export remain incomplete. |
| T4.5 / 114 | `main/shutdown.ts`, `job-session-controller.ts`; tests cover pause/close errors and restart ID hydration. | Partial: close UI wiring in flight. `JobService.snapshot` has no explicit persisted-state attestation, so service persistence/recovery remains an A gate; no OS-interruption test. |
| T4.6 / 115 | Unit 10,000 test in `d-r4-components.md`; fake corpus and GUI harness in `d-r6-endurance.md`. | In flight: R5 GUI endurance must run and record frame p95/RSS/one subscription after App wiring. Unit count does not prove responsiveness. |
| T5.1 / 127 | `packaging/runtime-manifest.*`, `prepare-resources.mjs`, `verify-bundle.mjs`; `d-r5.md`. | Partial: strict validator and offline staging fake-tested; actual manifest intentionally blocked on vendor/native/fit/license evidence. |
| T5.2 / 128 | `packaging.test.ts`, `runtime-resolution.test.ts`, `prerequisites.test.ts`, `main/packaged-runtime.ts`; 24 focused tests in `d-r5b.md`. | Fake-tested rules; installed Windows Unicode path and native execution external. |
| T5.3 / 129 | `packaging/electron-builder.yml`, `windows/installer.nsh`, `windows-installation.md`. | Partial: recipe exists, but no built/installed NSIS artifact or upgrade/uninstall evidence. Settings removal choice must be confirmed on installed build. |
| T5.4 / 130 | `packaging/native-smoke.mjs`, `verify-bundle.mjs`; `d-r5.md`. | Partial: smoke script exists; both Electron and standalone Node Windows ABI operations external. |
| T5.5 / 131 | `main/prerequisites.ts`, `packaged-runtime.ts`, `windows/offline-check.ps1`; `d-r5b.md`. | Partial: probes and fixed spawn tested synthetically. Actual licensed controller/model checks, traffic capture and offline render external; `offline-check.ps1` deliberately blocks without per-job evidence. |
| T5.6 / 132 | macOS unit/typecheck/build snapshots in `d-r5.md`/`d-r5b.md`; `windows/acceptance.ps1`. | External: no Windows host run, bundle, install or native smoke. Current integrated typecheck/build must repeat after R1/R5 wiring. |
| T5.7 / 133 | `windows/path-cases.ps1`, `acceptance.ps1`; release gate documents. | External: no real transferred PSD, live fit qualification, 100 assets or installed-GUI matrix. Filesystem fixtures do not exercise GUI. |
| T5.8 / 134 | `windows/verify-signature.ps1` and signed gate in `release-gates.md`. | External: no certificate, installer/EXE, chain or timestamp evidence. Only an unsigned internal test build can be claimed now. |
| T5.9 / 135 | `handoff.md`, dependency requests and partial verification reports exist. | Partial: update final commit/tests/adapters and unresolved gates after integration; do not mark D or Windows release complete. |

## Real Windows acceptance matrix

| Case | Preparatory evidence | Current result |
|---|---|
| Fresh standard-user installation | NSIS recipe, manifest validator, `acceptance.ps1` | **Blocked external**: no installer or Windows standard-user launch. |
| Offline rendering | Fixed local runtime spawn, `offline-check.ps1` | **Blocked external**: no captured outbound traffic or real committed/reviewed output. |
| Missing model/Photoshop | `prerequisites.ts`, model endpoint guard | **Blocked external**: no real disconnected/reconnected qualified endpoints or GUI recheck. |
| Unicode and spaces | Setup path tests; `path-cases.ps1` fixtures | **Blocked external**: no installed GUI→MCP→Photoshop→output traversal. |
| Long paths | `path-cases.ps1` builds ≥280-unit fixtures | **Blocked external**: no actual participating-layer outcome or preflight limit. |
| Filename collisions | Stable asset IDs and input validation helpers | **Blocked external**: no case-only/reserved-name installed run and output collision audit. |
| Permissions/storage | Output probe and free-space helper | **Blocked external**: no disposable-volume/read-only GUI publication test. |
| Three fits and previews | Fit UI, synthetic previews | **Blocked external**: no live B fit/geometry/sentinel evidence for cover, contain and stretch. |
| Pause/cancel/retry | Job controls, fake tests, new safe-close controller | **Blocked external**: no real Photoshop/review safe-boundary tests. |
| Crash/recovery/review backlog | JobStore reconnect tests and recent-job IDs | **Blocked external**: no A transaction interruption/reconciliation on installed app. |
| 100 real assets | Fake 10,000 corpus and GUI harness | **Blocked external**: no real 300 exports, fresh visual verdicts or measured resource data. |
| Upgrade/uninstall | NSIS recipe | **Blocked external**: no version-to-version persisted-job migration or retention test. |
| Signing | Signature script | **Blocked external**: no installer/EXE chain, publisher or timestamp. |

## Prioritized locally fixable residuals

1. Finish R1/R5 SetupWizard/App/IPC integration, including the new async evidence calls and job-session controller; run focused tests, typecheck, build and four fake Electron E2E tests. Validate preview bytes and digest in main before confirmation.
2. Run R5's actual 10,000-asset Electron GUI harness and record count, bounded rows, one subscription, pause/cancel, frame p95 and RSS. Keep it distinct from real Photoshop throughput.
3. Complete blocked/failed review detail and trusted diagnostic/evidence lookup; remove any path-only committed opener from UI reach. Obtain an A-supplied persisted snapshot cursor/phase time and authoritative manifest/output record source, or leave those claims blocked.
4. Reconcile the pinned packaged runtime manifest and native ABI after A's coordinated lock. Execute Windows/vendor/live qualification gates only when the corresponding inputs exist; record failures as failures, not substitutes.

Focused correction evidence at `838f3f4` plus uncommitted fake fixture packet: `evidence-access.test.ts`, `job-session-controller.test.ts`, `fake-services.test.ts` passed 13 tests; desktop strict typecheck and build passed on pinned Node 22.23.2. This verifies local behavior only. The exact final integration HEAD and broader R6 results belong in the final handoff after R1/R5 settle.
