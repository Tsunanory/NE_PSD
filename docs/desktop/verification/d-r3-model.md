# D-R3 exact model setup — 2026-09-30

Status: implemented and fake-tested. Live model and Windows gates remain blocked pending actual qualified artifact/runtime/vision/capacity evidence.

## Scope and behavior

The renderer now compares the selected frozen `ModelProfile` with observed artifact SHA-256, runtime and chat-template hashes, exact model ID, quantization, context, output limit, and each capability. Qualification is admitted only with a positive `SetupService.qualifyModelProfile` result carrying evidence paths, a passed representative capacity benchmark, endpoint availability, and a review gate. Synthetic display state cannot become ready. Planner and reviewer are separate; automatic visual review needs an independently qualified vision reviewer. Q4/Q6/Q8 share the same checks. Text-only evidence is labelled non-visual.

The setup view accepts typed `inspectModelProfile` and `qualifyModelProfile` handlers plus a refresh callback. It offers explicit recheck per selected role. The main helper permits only literal loopback HTTP origins and fixed `/health` or `/v1/models` GET requests. `localhost` is resolved and all returned addresses must be loopback; the request then uses a numeric address. Redirects are rejected. Timeout, streamed byte limit and strict object JSON are enforced.

## Evidence

All commands ran from `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/desktop` with the shared pinned Node 22.23.2/npm 10.9.8 bin directory first on PATH.

- RED: focused model tests exited 1: eight state assertions failed before implementation. Expanded endpoint tests also failed before helper correction. Initial endpoint socket fixtures could not bind in this sandbox (`listen EPERM`); tests now inject a fetch transport while exercising the request policy and stream limits.
- GREEN: `npm run test:desktop -- tests/desktop/model-setup.test.tsx tests/desktop/model-endpoint.test.ts` exited 0: 2 files, 25 tests.
- `npm run typecheck -w @ne-psd/desktop` exited 0.
- `npm run build -w @ne-psd/desktop` exited 0 after implementation.
- `npm run test:e2e:desktop -- tests/desktop/model-setup.e2e.test.ts` exited 1: Electron `Process failed to launch!` in this macOS environment. This is not model behavior evidence.

No actual `Qwen3.8-27B` artifact, runtime, chat template, vision corpus, capacity run, or Windows host was qualified in this packet. The fixture records under `tests/desktop/fixtures/` are synthetic and are not qualification records.

## Integration required

The shared `SetupWizard` still renders its legacy synthetic model state. D-R1/D-R2 integration must pass separately selected planner/reviewer profiles and authoritative evidence to `ModelSetup`; wire its typed handlers through main IPC to `SetupService.inspectModelProfile` and `qualifyModelProfile`; refresh status after both success and failure. Main must validate the selected profile and local endpoint before service calls. Job admission remains A's authoritative `JobService.validate`, including scheduled-job policy and evidence freshness. The frozen `SetupService` return shape does not contain the full capacity/corpus report; A/C must provide a trusted separate evidence source or an explicit coordinated contract change before real readiness can be displayed.
