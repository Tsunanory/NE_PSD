# Task 2 core evidence — A-T2a, 2026-09-30

Branch `build/core`; implementation commit `3743cb29e269022db379dc47c38352745989b2f2`. This closes the local mutation-admission and ambiguity-lifecycle packet only. Task 2 as a whole remains open.

Runtime: exact Node `22.23.2`, npm `10.9.8`, macOS arm64, native SQLite ABI `127`; qualified path and checks are in `docs/qualification/toolchain-2026-09-30.md`. Each npm command below used `PATH=/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin:$PATH` from the core worktree.

## RED → GREEN

- RED before implementation: `npm run test:core -- tests/core/runner.test.ts --reporter=dot` exited 1, **9 failed / 3 passed**. The blocked/busy cases found workspaces created before admission; pending recovery and release-wait cases allowed the second runner to enter; release-proof cases failed to retain ambiguity; acquire failure left an abort listener. Exact output: `/private/tmp/ne-psd-a-t2a-red.log` (ephemeral local log).
- Additional RED: `npm run test:core -- tests/core/recovery.test.ts` rejected a truthy malformed recovery claim, then a missing evidence-path list; `npm run test:core -- tests/core/runner.test.ts -t 'release proof truthy' --reporter=dot` rejected truthy non-boolean release proof.
- GREEN: `npm run build --workspace=@ne-psd/core` passed. `npm run test:core -- tests/core/runner.test.ts tests/core/backend-serialization.test.ts tests/core/recovery.test.ts tests/core/cancellation.test.ts` passed **4 files / 23 tests**. `npm run test:core` passed **10 files / 60 tests**. `npm run check --workspace=@ne-psd/core` and `git diff --check` passed.

## Result and boundary

The shared serializer now admits the entire render attempt before workspace creation, lease access, database transition, or backend call. Two runners using the same lease reject blocked or busy admission without creating a new attempt or marking the queued asset failed. Ambiguity is latched before awaiting read-only recovery and stays latched through release proof and release completion. Missing, false, malformed, or throwing proof and failed release keep the asset blocked and the lease retained. Only literal `safe: true` recovery with a valid evidence-path list, literal `true` release proof, and completed release clear the latch. A late render response cannot clear it. Acquire failure installs no cancellation timer or parent abort listener. Only a transport failure with proven release receives one automatic retry; ambiguous and unproven failures do not.

This uses the existing B-owned lease interface and creates no second OS lock. It does not establish B production wiring or the per-asset owned-source contract. `RenderRunnerOptions.source` remains optional and runner-wide; `RenderRequest.asset.source` still identifies the original FileRef, not the copied working source. A-T2b must reconcile B's `SessionLock` ownership and an explicit owned-source/dependency handoff. A-T2c still owns disk preflight, linked-dependency/scratch isolation, broader crash/cancel/pause matrix, and durable integration. The local fake tests do not prove Photoshop, Windows, or model compatibility.
