# Lane C Task 1 report

## RED

Command:

```sh
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run test:intelligence -- tests/intelligence/profiles.test.ts
```

Expected failure observed: 5 tests failed because `inspectModelProfile` was not exported and profile/policy modules were absent.

## GREEN

Implemented profile qualification records, registry selection rules, invocation policy, mandatory fifteen-requirement review policy with canonical digest, local manifest verification, fixtures, and documentation. Qualification preserves `MODEL_ARTIFACT_UNVERIFIED` for the unverified exact `Qwen3.8-27B` request and does not download or substitute artifacts.

Commands:

```sh
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run build --workspace @ne-psd/intelligence
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run test:intelligence -- tests/intelligence/profiles.test.ts tests/intelligence/requirements.test.ts
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run test:intelligence
```

Results: build passed; targeted suite passed, 2 files / 7 tests; full intelligence suite passed, 3 files / 8 tests.

## Files changed

`packages/intelligence/src/profiles/profile-registry.ts`, `qualification-schema.ts`, `invocation-policy.ts`, `review/requirements.ts`, `cli/verify-model.ts`, `node-shims.d.ts`, `src/index.ts`; intelligence tests and fixture; `docs/intelligence/model-qualification.md`, `review-policy.md`, `task-1-evidence.md`.

## Self-review and concerns

- No manifests, lockfiles, contracts, scheduler settings, or installed skills changed.
- Fixture profiles are visibly marked and rejected for production selection.
- `verifyModel` checks local files and platform only; it does not load models or claim runtime qualification from artifact-only mode.
- Live artifact, runtime, Windows, Photoshop, and vision gates remain unverified because the plan supplies no authoritative matching Qwen release. This is an intentional blocker, not a substitution.
- No package dependency was required; the local Node type shim is limited to the CLI's existing Node built-ins.
- Correction retry: invocation now fails closed without `profileQualified: true`, rejects text-only automated review, and maps `humanPerAsset` to the human evaluator. Qualification checks cancellation after adapter completion and validates bound evidence. The package-local `verify:model` runner performs containment and symlink checks and returns a structured blocker for the unverified requested manifest.
- Correction verification: build passed; targeted suite passed 2 files / 10 tests; full intelligence suite passed 3 files / 11 tests; typecheck passed; exact documented `verify:model` invocation returned `ok:false`, `artifactVerified:false`, `runtimeQualified:false`, exit 1.
