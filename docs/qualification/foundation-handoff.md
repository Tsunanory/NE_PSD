# Foundation Task 3 handoff

Status: `implemented-and-fake-tested`.

This task adds independent, deterministic test adapters under the stable `@ne-psd/contracts/testing` export. They are test-only and cannot be used as Photoshop, Windows, local-model or visual-qualification evidence. Fake artifact and evidence references are visibly rooted at `testOnly/`; the fake bundle marks binary artifacts `testOnly: true`.

## Commits and verification

- Task 1 baseline: `12acf2afee26af5d83fc832b091679a3014b90de`.
- Task 2 implementation: `d2ce2e53b5c1fa3394c734b7e503d599371c802c`.
- Task 3 implementation: `3f052457c7502c4716e0e14c1c1ca9960b17364f`.
- Task 3 runtime-proof correction: `61b142812cb3e1d192b94fe3ddd5cf6a0354f3bc`.
- Task 3 was developed and tested against predecessor `d2ce2e53b5c1fa3394c734b7e503d599371c802c`; Task 4 must use the finalized metadata commit as the new foundation baseline.

Task 3 focused test:

```text
npm run test:contracts -- --run tests/contracts/fakes.test.ts
Test Files 1 passed (1)
Tests 20 passed (20)
```

The required full commands were run after implementation under Node `v22.23.2`/npm `10.9.8`:

```text
npm run build       PASS
npm run check       PASS
npm run test:contracts  PASS
```

The full contract result was `Test Files 5 passed (5)` and `Tests 33 passed (33)`. The focused fake suite passed `Test Files 1 passed (1)` and `Tests 20 passed (20)`.

The proof used `/private/tmp/node-v22.23.2-darwin-arm64/bin`; no runtime mismatch remains for this handoff.

## Dependency and export boundary

Sharp remains exactly pinned at `0.35.4` and is now declared directly by `@ne-psd/contracts` because its public testing fake generates real image bytes. It was already present in the root lockfile and dependency evidence; no new version was introduced. `canonicalize@2.1.0` and `zod@4.6.5` remain unchanged. Import fakes through `@ne-psd/contracts/testing`; production code imports only the `.` export.

## Covered behavior

`FakePhotoshop` records deterministic operations, supports injected clocks and failure schedules, generates three Sharp-decodable JPEG/PNG artifacts at the requested dimensions, and records matching render evidence. `FakeIntelligence` returns pass/revise/blocked decisions with exactly three variant review IDs or rejects invalid JSON. `FakeJobService` implements every frozen `JobService` method and emits strictly increasing event sequence numbers. `FakeSetupService` distinguishes static and live inspection fixtures. Storage schedules and named scenarios are extensible through constructor configuration rather than cross-track edits.

The registry in `requirements-v1.json` contains the exact 15 mandatory IDs. Every entry names an implementation path, automated test, and live qualification evidence owner. `policy.v1.json` carries the same IDs/evaluators. `VISUAL.QUALIFIED` remains model/human-gated; the remaining 14 checks are deterministic and cannot be promoted by a model.

## Known external gates

Photoshop installation/controller qualification, Windows 11 x64 packaging and live execution, exact local Qwen3.8-27B artifact/runtime/vision qualification, critical npm audit remediation/security acceptance, and qualified human/vision review remain open. Fake tests prove adapter behavior only and do not qualify any of these gates. No scheduler or scheduled job was created.

Final correction packet 2026-09-22: schema generation is deterministic and checked in with Draft 2020-12 metadata and explicit runtime-only cross-field invariants. Contract fixtures use deterministic Sharp-decodable PNG/JPEG assets; manifest closure is filesystem-verified. Fake Photoshop reports measured checks only; Fake Intelligence rejects manifest, digest, artifact, policy, and attempt mismatches. Contract suite: 5 files, 40 tests passed under Node v22.23.2/npm 10.9.8. `.npmrc` legacy-peer-deps rationale is recorded in dependency evidence. External Photoshop, Windows, Qwen, and security gates remain open.

## Integration

Build the contracts package before consumers. Use `import { FakePhotoshop, FakeIntelligence, FakeJobService, FakeSetupService } from '@ne-psd/contracts/testing'` in fake-backed tests only. Keep fake paths out of live qualification records; live validators must receive real evidence paths and real source/backend/model digests. Task 4 should record the final Task 3 commit SHA, verify a clean tree, then create its four worktrees from that SHA.

The contract qualification validators reject `testOnly/...` evidence in live qualification requests and results.
