# D-R6b fake GUI endurance — 2026-09-30

Status: deterministic fake corpus implemented and locally tested; actual 10,000-asset GUI E2E awaits R1's development-only bridge and App JobStore wiring.

`FakeJobService` wraps the contract fake. `createFakeCorpusSpec(count)` accepts only 1–10,000 safe integer assets, creates a real schema-valid `JobSpec` with distinct stable asset IDs, and freezes the result. The service freezes snapshots, emits deterministic sequence-numbered events, exposes idempotently tracked subscription counts, and completes only through explicit `completeFakeJob` while running. There is no timer, random success, real Photoshop work or visual verdict. `metrics(jobId)` returns active subscription count, event count and last sequence without exporting image data.

RED: the focused fake-service test failed on the absent new helper. GREEN on pinned Node 22.23.2/npm 10.9.8: `npm run test:desktop -- tests/desktop/fake-services.test.ts` passed 4 tests, including start/pause/resume/final snapshot/event for exactly 10,000 assets, and `npm run typecheck -w @ne-psd/desktop` passed at that snapshot. Commit: `1120610`.

The `endurance.e2e.test.ts` harness uses the real installed Electron, context-isolated preload and development fake bridge. It requests 10,000 assets, checks DOM count ≤50, one active subscription, pause/resume, final 10,000/10,000 snapshot and monotonic sequence, renderer frame p95 and main-process RSS. A second 10,000-asset run tests GUI cancel. Its metrics are attached as JSON to the Playwright result. No GUI result is claimed until this file runs after R1 wires `startFakeCorpus`, `completeFakeJob`, `fakeJobMetrics` and mounts `JobStore` in App. The channels must be registered only with explicit fake development and an unpackaged app; production must have no handlers.

Remaining local acceptance: pinned Node build; run the new E2E through the same narrowly approved out-of-sandbox Electron route as D-R6a; record exact count, bounded rows, subscription count, no lost final state, pause/cancel and measured latency/RSS. Other release gates remain Windows, real Photoshop/model and signing evidence.
