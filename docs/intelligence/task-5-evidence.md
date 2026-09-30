# Task 5 harness/resource packet evidence — 2026-09-30

Scope: fixed corpus runner, resource sampler/gates, and foreground CLI in assigned C5 files. Node 22.23.2, npm 10.9.8. The actual model artifact, live transport capability, Windows host, and Photoshop workload are not present in this packet.

Fresh local checks after changes:

```text
npm run build --workspace @ne-psd/intelligence                   PASS
npm run test:intelligence -- tests/intelligence/evaluation-harness.test.ts tests/intelligence/resource-sampler.test.ts
                                                               PASS: 2 files, 8 tests
node packages/intelligence/dist/cli/qualify-model.js --profile docs/intelligence/qualification/requested-local.json --expected-platform win32 --corpus tests/intelligence/fixtures/acceptance-corpus.json --repetitions 3 --with-photoshop --report /private/tmp/ne-psd-c5-windows-blocked.json
                                                               BLOCKED: PLATFORM_MISMATCH:win32:darwin
node packages/intelligence/dist/cli/qualify-model.js --profile docs/intelligence/qualification/requested-local.json --expected-platform darwin --corpus tests/intelligence/fixtures/acceptance-corpus.json --repetitions 3 --with-photoshop --runtime-adapter qualified-runtime-bridge --report /private/tmp/ne-psd-c5-darwin-blocked.json
                                                               BLOCKED: PLANNER.ARTIFACT_UNVERIFIED, REVIEWER.ARTIFACT_UNVERIFIED, REVIEWER.VISION_UNQUALIFIED
```

Synthetic harness tests run 64 generated case rows three times, route reviewer separately, record 177 model calls and 15 preflight rejections, and reject false accept/block, missed seeded defect, zero/two calls, and profile substitution. A synthetic artifactVerified candidate with `runtimeQualified:false` passes through the qualification-only corpus path but remains blocked and `productionSelectable:false`; no live model invocation is claimed. Resource tests verify RAM/VRAM reserves, Windows pressure and workload requirements, unified-memory handling, and synthetic/partial evidence blocking.

The parallel corpus packet supplied the fixed 64 descriptors and 27 visual bundles. `validateCorpus` accepted all 64 rows and group counts. The packaged bridge is present but requires an operator-installed live runtime module; package script forwarding belongs to integration. No current report establishes local model, Windows, Photoshop, or full release qualification. Pending gates: run the fixed corpus against the exact selected artifact and reviewer, measure the real Windows co-resident workload, verify visual defect detection, admit the resulting qualification record, and run the track-wide checks after integration.

Final C5 verification (Node 22.23.2): intelligence build exit 0; full intelligence suite 24 files/227 tests exit 0; root `npm run check` exit 0; `git diff --check` exit 0. The public qualification adapter regression reached a fake hanging transport, then caller cancellation aborted its request and prevented resource measurement or report persistence. The locked corpus and tamper checks passed in the full suite. These are synthetic implementation checks, not live visual or release qualification.

The package-local `npm run qualify:model --workspace @ne-psd/intelligence --` command ran twice with paths relative to the intelligence package. The win32-on-Mac run exited 1 with `PLATFORM_MISMATCH:win32:darwin`. The darwin run exited 1 with `PLANNER.ARTIFACT_UNVERIFIED`, `REVIEWER.ARTIFACT_UNVERIFIED`, and `REVIEWER.VISION_UNQUALIFIED`. Both persisted reports have `status:blocked`, `productionSelectable:false`, and `corpus:null`. Reports: `/private/tmp/ne-psd-c5-npm-win32-final.json` and `/private/tmp/ne-psd-c5-npm-darwin-final.json`.
