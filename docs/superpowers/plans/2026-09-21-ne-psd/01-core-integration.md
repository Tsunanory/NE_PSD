# NE_PSD Core and Integration Implementation Plan

> Routing: [model-routing.md](../../model-routing.md). Ponytail full applies to coding, design and code review.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Use task-observer; implement the runtime image reviewer, not a development-review layer. Steps use checkbox syntax.

**Goal:** Run recoverable, evidence-checked image batches and integrate all four independently built tracks into a Windows-qualified application.

**Architecture:** An injected PhotoshopBackend and IntelligenceService drive a durable SQLite state machine. Each asset has its own staging directory and review; the application publishes an entire verified directory atomically. The coordinator owns the job queue and all retry decisions; the B adapter owns the sole Photoshop installation lease.

**Tech Stack:** TypeScript, Node, SQLite, Sharp, Vitest, typed contracts, Electron composition facade. Exact dependency versions come from the foundation lockfile.

Read the shared design, foundation handoff, `parallel-build.md`, requirement registry. Own `packages/core/`, `tests/core/`, `tests/integration/`, `docs/qualification/`, root manifests/config/lock and CI. Other workers own their paths. Use injected fakes until their reviewed commits are integrated. Estimated active engineering effort 3–6 days, with 1–3 additional days for Windows/live qualification depending on hardware and template issues. Never label external gates complete using mocks.

## Task 1: Build preflight, naming, state and durable storage

**Create:** `packages/core/src/{index,preflight,paths,asset-id,job-repository,state-machine,events,configuration}.ts`, `packages/core/src/migrations/001-initial.sql`, `tests/core/{preflight,paths,repository,state-machine}.test.ts`.

- [ ] Add regression tests before implementation: same basename in two directories; `A.png` versus `a.png`; Unicode normalization differences; `CON`, `NUL`, trailing dot/space; symlink/reparse-point escape; source changed after selection; zero-byte/corrupt image; output inside input directory; a read-only output folder; invalid/missing template qualification; policy/backend digest drift; scheduled Qwen. Inputs are explicitly enumerated recursively by user choice, sorted reproducibly, and snapshotted by content digest; never accidentally ingest this job's outputs.
- [ ] Implement asset identity from canonical relative-path bytes plus content SHA-256. Use a sanitized readable stem followed by a collision-resistant ID prefix; on prefix collision deterministically lengthen it. Preserve original path separately in manifest. Check Windows names and length before Photoshop is invoked, even during Mac development. Source root is never writable by the renderer. Supported raster/PSD inputs follow the backend's qualified decoder matrix; unsupported files get explicit per-file validation errors.
- [ ] Create SQLite tables `jobs`, `assets`, `attempts`, `events`, `reviews`, `publications`, `qualifications` with schema migrations, foreign keys and unique transaction keys. Use WAL and explicit transactions; record schema/contract versions. Event IDs increase per job and snapshots derive from DB state, not an optimistic frontend counter. Validate counters against asset rows.
- [ ] Implement allowed transitions from the design. Separate user pause from blocked/review-wait/error; `pause` requests a safe boundary, `cancel` preserves completed outputs and durable failure/evidence records. `retryFailed` cannot bypass a review or create unbounded attempts: two automatic attempts per transaction; a deliberate user retry creates a new JobSpec with a new jobId containing only selected failed assets, linked to the previous job in SQLite metadata. Return its new jobId from retryFailed so UI can subscribe and display the successor.
- [ ] Run `npm run test:core -- tests/core/preflight.test.ts tests/core/paths.test.ts tests/core/repository.test.ts tests/core/state-machine.test.ts`. Expected: every unsafe case rejected before backend calls; migrations and reopening preserve state. Fix failures, rerun checks, and commit.

State invariant example:

```typescript
it('cannot publish an unreviewed asset', async () => {
  const job = await fixtureJob({ status: 'rendering', attempts: 1 });
  await expect(repository.transition(job.assetId, 'complete'))
    .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  expect(await publishedDirectories(job.jobId)).toEqual([]);
});
```

Implement `fixtureJob` and `publishedDirectories` in `tests/core/helpers.ts` with temporary SQLite and filesystem roots; no access to the owner's real asset folder.

## Task 2: Coordinate Photoshop safely and isolate every attempt

**Create:** `packages/core/src/{job-service,runner,attempt-workspace,cancellation,recovery,retry-policy}.ts`, `tests/core/{runner,backend-serialization,recovery,cancellation}.test.ts`.

- [ ] Test two simultaneous jobs/workers, stale lock file with live Photoshop operation, dead MCP child but outstanding Photoshop mutation, timeout immediately after child save, job pause during export, cancellation between variants, job process crash. Tests use an injected backend that can complete late after its caller times out.
- [ ] Consume the B-owned OS-visible lease per Photoshop installation; do not create a second lock in core. Require backend diagnostics to expose host/PID/process-start and job identity; do not infer safety from a stale timestamp. A second process may read status but cannot mutate Photoshop. The app uses an existing-instance handshake to focus the active UI. Lock release follows positively established safe backend state, not merely `finally` after timeout.
- [ ] Create same-volume output staging under `<outputRoot>/.ne-psd-staging/<jobId>/<assetId>/<attempt>/`; use a separate local scratch directory for copied PSD/dependencies if required. Preflight available disk for originals, working copies and three decoded/exported images; use measured qualification multipliers, not a universal hardcoded PSD multiplier. Copy linked dependencies and verify source digests through the B adapter before mutation. Never recursively delete an arbitrary model-supplied path; cleanup only created-and-recorded workspace paths.
- [ ] Implement one render call per asset attempt with one AbortSignal, operation deadline and persistent intent records. Distinguish safe retryable transport/read failures from `ambiguousState`. On uncertainty stop mutations, retain the lease, invoke read-only recovery and block if safety is not proven. Start a fresh copy for the sole automatic retry. A review correction may change only an explicit validated corrective action; it cannot expand tool access or replace the selected model.
- [ ] Run `npm run test:core -- tests/core/runner.test.ts tests/core/backend-serialization.test.ts tests/core/recovery.test.ts tests/core/cancellation.test.ts`. Verify no second Photoshop mutation runs concurrently or after unresolved timeout. Verify checks and commit.

Normative runner control flow:

```text
validate digests/policy -> queue one backend call -> allocate fresh attempt
-> persist rendering -> backend.render -> prove document cleanup
-> deterministic QA -> persist reviewing -> fresh reviewer
-> verify evidence unchanged + mandatory checks + review pass
-> persist readyToCommit -> publish bundle directory -> persist complete
```

B releases its Photoshop lease after backend cleanup is proven, allowing review to run without holding Photoshop unnecessarily. Do not overlap two renders; production reviewer invocations remain serial by default to fit one loaded Qwen. Pausing during review preserves staging; resuming retries review with a new session ID over unchanged verified evidence.

## Task 3: Verify artifacts, bind reviews and publish crash-safely

**Create:** `packages/core/src/{artifact-qa,evidence-bundle,review-gate,publication,reconciliation,visual-attestation}.ts`, `tests/core/{artifact-qa,review-gate,publication,reconciliation}.test.ts`.

- [ ] Decode every export with Sharp; verify format, dimensions, color profile/normalization, positive bytes, pixel availability and recorded digest. Reject missing/duplicate variants and unexpected group visibility. Compare geometry evidence to fit semantics and clipping/adjacency tests from B. Blank-image and duplicate-export heuristics are diagnostic flags, not universal failure rules: a legitimate white design or similar variants requires calibrated profile-specific thresholds and visual evidence.
- [ ] Create the immutable evidence packet and manifest including exports, trace/check files, profile/source digests and digested VisionInput entries for source, qualified template reference, three full outputs and meaningful detail crops. Pass actual image inputs to the configured reviewerModelProfileId; persist the independently selected planner profile too. Validate both profiles/provenance against the transaction key. Fully automated release requires qualified vision. Manual mode may instead include required visual attestation but is not equivalent release evidence. Expose visualReview(jobId,assetId) and submitVisualAttestation(requestId,decision,notes). Persist one-shot host request IDs, derive actor identity through trusted main composition, rehash before accepting, make repeat identical submissions idempotent and reject stale/conflicting submissions. Contact sheets display full images plus reference/crop details without covering pixels with overlays. Human-per-asset mode requires affirmative per-asset attestation bound to actual three image hashes, contact-sheet digest and the pre-attestation content digest (not the final evidence digest, which would create a cycle); qualifying one template is not approval of every future asset. The normal automated path uses a qualified vision reviewer after the evaluation corpus passes. If the selected brain Qwen lacks vision, an explicitly configured reviewer supplies it; do not silently switch providers. Text Qwen may audit structural evidence but cannot supply visual acceptance.
- [ ] Reject reviewer outputs with wrong schema, requirement IDs, job/asset/attempt, input digest, policy digest, model provenance, prompt hash or missing mandatory coverage. `pass` plus unknown/fail mandatory checks is invalid. Require exactly one variantChecks item for IDs 1,2,3 and reject set-level pass when any individual finished image failed or is unknown. On reviewer outage persist `blocked` or pending-review work; never mark complete or rerender intact assets just because inference was unavailable. Rehash packet after response to prevent stale approval.
- [ ] Persist a publication intent, fsync files and manifest using supported platform semantics, then rename a whole unique asset directory within the same filesystem. Refuse to overwrite a pre-existing committed directory with a different transaction key. A valid identical publication can be reconciled idempotently. Complete SQLite only after publication. On restart, check both DB intent and committed manifest; quarantine corrupt/incomplete directories and keep their evidence.
- [ ] Inject crashes before/after every persisted phase and filesystem publication boundary. Run `npm run test:core -- tests/core/artifact-qa.test.ts tests/core/review-gate.test.ts tests/core/publication.test.ts tests/core/reconciliation.test.ts`. Expected: restart yields zero or one valid three-file publication per transaction, never a partially accepted set. Verify checks and commit.

Example assertion:

```typescript
it('reconciles a rename that succeeded before SQLite completion', async () => {
  const run = await crashFixture('after-directory-rename-before-db');
  await run.restartAndReconcile();
  expect(await run.publishedAssetCount()).toBe(1);
  expect(await run.backend.renderCount()).toBe(1);
  expect(await run.snapshot()).toMatchObject({ complete: 1 });
});
```

## Task 4: Integrate setup, packages and observability

**Create:** `packages/core/src/{composition,setup-service,qualification-store,diagnostics,support-bundle}.ts`, `tests/integration/{composition,batch,setup,observer-policy}.test.ts`, `tests/integration/vitest.config.ts`, `docs/qualification/{integration-log,dependency-requests}.md`, `.github/workflows/ci.yml`.

- [ ] Implement `createJobService` and `createSetupService` factories with explicit adapter dependencies. The setup facade loads inspection/proposal records, calls PhotoshopBackend.qualify on a candidate (never a fake qualified profile), drives a job-owned working-template qualification and stores profiles/model results with hashes. proposeConfiguration delegates to IntelligenceService.propose against the saved inspection; inspectModelProfile/qualifyModelProfile delegate to the same-named C methods. Validate B qualification result and all required evidence before sealing profileSha256 and qualificationId. Never mark qualification merely because a model suggested settings. Pass only validated JobService and SetupService methods to the D bridge.
- [ ] Integrate B/C/D reviewed commits sequentially from the recorded foundation base. Inspect ownership and merge conflicts. Contracts change only with a written versioned change request, regenerated fixtures and migration/consumer updates; announce the new baseline before affected workers continue. Update root dependency manifest and lock once per reviewed request. Do not merge unrelated skill changes or user modifications.
- [ ] Add structured logs with job/asset/attempt/op/review-session IDs and timings; avoid source image bytes, credentials, private path lists and model chain-of-thought in support bundles. Include concise errors and evidence pointers. Developer diagnostic prompt may suggest a diagnosis but cannot execute scripts, commands or repairs. Support export is local until the owner explicitly chooses a destination.
- [ ] Configure Mac and Windows unit/contract/integration CI with fixed dependencies and no model calls. Live Photoshop tests run on a dedicated Windows interactive host with Photoshop installed, not a hosted headless fake. No scheduled CI model calls or digest jobs. If any future scheduler invokes a model, require explicit Luna-only configuration at both levels and defer on failure.
- [ ] Run all contract/package suites once, then integration scenarios: 10 valid assets → 30 committed exports, 10 distinct runtime review sessions and 30 individual visual verdicts; one invalid asset → explicit failure without corrupting others; review unavailable → preserved pending evidence; interrupted job → resume exactly once; path/profile/policy changes → new transaction. Verify integration checks and commit.

## Task 5: Qualify the actual Windows release and hand off

**Create:** `docs/qualification/{windows-release,model-benchmark,template-qualification,acceptance-matrix,release-manifest}.md`, `tests/integration/endurance.test.ts`, `docs/qualification/handoff.md`.

- [ ] On Mac, validate source PSD hash, read-only inspection, qualified working-copy workflow if Photoshop is available, all fake tests and Qwen endpoint if available. Mark unavailable hardware/model gates blocked explicitly. Never relabel the static PSD parse as a live Photoshop test.
- [ ] On Windows 11 x64, install the actual artifact from D into a clean user account. Verify bundled runtime, no internet requirement after model/Photoshop setup, local endpoint and model provenance, same template/asset corpus, Cyrillic/space/long-path handling, app update/uninstall behavior and source preservation. Verify tool behavior against the actual Photoshop version; macOS AppleScript success does not prove Windows bridge support. Record package, OS, Photoshop, inference runtime, quantization and driver versions.
- [ ] Run a vision-review corpus with deliberately wrong source image, swapped/duplicate variant, incorrect crop/scale, missed clipping, blank/partial export, lost effects and subtle edge artifacts. Qualify false-pass/false-fail rates against human-labelled expected results and block release if mandatory defects are passed. Then run a golden rendering corpus with landscape/portrait/square, tiny/huge, transparent, ICC-tagged, duplicate-name and malformed inputs; all three fit modes and both export formats; nested/shared/linked Smart Object fixtures; template edited after qualification; nonzero canvas offsets/vector reference; cancel/restart at each boundary. Attach expected reference images and human/qualified-vision decisions, not just success exit codes.
- [ ] Run 100 real assets in a user-initiated session and 10,000 fake assets with injected failures. Measure render/review p50/p95, peak app+Photoshop+inference RAM/VRAM, disk amplification, leak trend, shutdown/restart recovery and model schema/decision accuracy. Release requires all mandatory checks; if Q4/Q6 fails the same evaluation used for Q8, upgrade hardware/quantization, preserve the specification and rerun. Record empirical numbers; do not promise a throughput SLA before measurement.
- [ ] Complete the final release acceptance matrix against final commit/artifact hashes and real Windows evidence. Resolve release-blocking defects; rerun changed checks; sign only if the owner has configured a valid signing identity. Handoff includes installer path/hash, install/start steps, qualified model/profile, limitations, recovery instructions, task-observer checkpoint. No release claim if Windows/live/model gates remain blocked.

**A complete only if:** integrated fake tests pass and all available evidence is reported accurately. **Product complete only if:** the separate real Windows + PSD + model + per-iteration review gates above also pass. A branch can finish its independent implementation while those release gates remain visibly blocked; do not collapse those statuses.
