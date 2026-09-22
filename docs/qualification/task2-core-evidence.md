# Task 2 core evidence

2026-09-22, branch `build/core`, commit pending.

The injected Task 2 boundary uses the B-owned Photoshop lease interface; core creates no installation lock. Lease diagnostics require host, PID, process start and job identity. A process-local mutation serializer rejects overlapping backend mutations. Timeout or ambiguous mutation retains the lease and invokes read-only recovery; unsafe recovery blocks the asset. A safe recovery is the only path that releases the lease after ambiguity.

Attempt staging is created below the bound output root at `.ne-psd-staging/<jobId>/<assetId>/<attempt>`. Source handoff uses `readValidatedSource`; copied bytes are rehashed and size-checked. Cleanup only removes recorded paths under the workspace root.

Focused fake verification:

- `npm run test:core -- tests/core/runner.test.ts tests/core/backend-serialization.test.ts tests/core/recovery.test.ts tests/core/cancellation.test.ts`: 4 files, 4 tests passed.
- Full A-owned core suite including Task 2 files: 9 files, 40 tests passed.
- Core build, typecheck and `git diff --check`: passed.

External gates remain open: live Photoshop, Windows reparse-point behavior, real PSD backend, model qualification and visual review. No mock result is a live qualification claim.
