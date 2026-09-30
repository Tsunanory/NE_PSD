# D-R4 job and review components — 2026-09-30

Status: implemented and fake-tested as isolated components. App/IPC integration and live Windows job review are separate gates.

## Delivered behavior

`JobStore` subscribes once per active job, validates job IDs and monotonic event sequences, rejects stale events, refreshes after a gap, and ignores late asynchronous results from an earlier connection. Retry accepts the service's successor job ID and retains the prior snapshot for evidence access. `AssetList` caps rendered rows at 50 even for 10,000 assets. `JobView` renders only authoritative snapshot counts and asset statuses; `readyToCommit` is never shown as published. Buttons invoke supplied service handlers, lock while pending, and leave state unchanged until new service data arrives. A committed-output button appears only for a selected `complete` asset and must use main's validated output resolver.

`readReviewImages` in main parses the frozen request/manifest, checks matching job/asset/attempt, requires exactly the three manifest and vision-output bindings plus contact sheet, confines paths, rejects symlinks, verifies byte counts and SHA-256, and emits only PNG/JPEG data URLs. `ReviewEvidence` requires the matching one-shot request and verified image set, shows all three images and contact sheet, and submits only an explicit operator choice. Submission does not imply a visual pass; core must reject stale/conflicting attestations and publish only after its own rehash and policy gates. `JobEventForwarder` owns one service subscription. Safe close requests pause and closes only after a persisted paused/completed/cancelled state.

## Executed checks

All commands used the shared pinned Node 22.23.2/npm 10.9.8 from `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin`, with cwd `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/desktop`.

- RED: focused store/control tests exited 1 on missing controller, stale async connection and missing old-job evidence. Review tests exited 1 on missing manifest-bound image loader. Forwarder/safe-close tests exited 1 before implementation.
- GREEN: `npm run test:desktop -- tests/desktop/job-store.test.ts tests/desktop/job-controls.test.tsx tests/desktop/evidence-access.test.ts tests/desktop/endurance.test.ts` exited 0: 4 files, 15 tests.
- `npm run typecheck -w @ne-psd/desktop` exited 0.
- `npm run build -w @ne-psd/desktop` exited 0.

The 10,000-asset unit test proves count and bounded slice behavior, not measured Electron renderer responsiveness or memory. No Photoshop or visual model was run.

## Shared wiring and external dependencies

R1/R2 integration must connect `JobStore` to typed `BridgeApi.snapshotJob`, `subscribeJob` and `retryFailed`; bind `JobView` handlers to pause/resume/cancel/retry; preserve selected asset by ID; invoke `JobService.visualReview`; load `VerifiedReviewImages` only through main's trusted manifest-bound reader; and connect `ReviewEvidence.onSubmit` to `submitVisualAttestation`. Opening outputs must obtain a trusted committed record from A, pass it to `resolveCommittedOutput`, and call the platform opener only for that returned path. The existing `SetupWizard` still renders synthetic placeholders and does not satisfy these hooks.

Frozen `JobSnapshot` lacks a sequence cursor and persisted phase-start timestamp. `JobStore` can check event sequences and refetch after gaps, but an unsequenced snapshot cannot prove exactly which event it includes. Exact gap recovery and elapsed phase time require A to expose a trusted cursor/time source or coordinate a contract update. A must supply persisted job/evidence manifests, stale/conflicting attestation enforcement, safe-close persistence, retry successor semantics and real review decisions. GUI endurance and installed Windows gates remain unexecuted.
