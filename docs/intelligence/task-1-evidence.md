# Task 1 evidence

## C1 recovery verification (2026-09-22)

Worktree status at start: `## build/intelligence` with pre-existing modifications in `AGENTS.md`, `docs/superpowers/launch/03-intelligence.txt`, and `docs/superpowers/plans/2026-09-21-ne-psd/03-intelligence-review.md` (left untouched). HEAD: `629511d254da99a4e86a841c325705355923cde6`.

The focused regressions reproduced the trust-boundary gaps before correction: invocation accepted caller-supplied `profileQualified`, qualification compared only model ID/provenance kind and accepted unbound evidence paths, mandatory requirements were mutable, and `verify:model` accepted a final-file symlink and did not verify runtime evidence files. Corrections now require a validated, profile-bound qualification record, reject unsafe/mismatched evidence, freeze the mandatory registry, reject final artifact symlinks, and require present regular runtime evidence outside artifact-only mode.

Commands and outcomes:

```text
npm run build --workspace=@ne-psd/contracts                         PASS
npm run build --workspace=@ne-psd/intelligence                       PASS
npm run test:intelligence -- tests/intelligence/profiles.test.ts tests/intelligence/requirements.test.ts tests/intelligence/verify-model.test.ts
  PASS: 3 files, 14 tests
npm run test:intelligence
  PASS: 4 files, 15 tests
npm run typecheck --workspace=@ne-psd/intelligence
  PASS
npm run build --workspace=@ne-psd/intelligence
  PASS
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run verify:model --workspace @ne-psd/intelligence -- --manifest docs/intelligence/qualification/requested-local.json --artifact-only --report docs/intelligence/qualification/artifact-report.json
  EXPECTED BLOCK: exit 1; structured result {"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}
```

Files changed in C ownership: `packages/intelligence/src/cli/verify-model.ts`, `packages/intelligence/src/profiles/invocation-policy.ts`, `packages/intelligence/src/profiles/profile-registry.ts`, `packages/intelligence/src/profiles/qualification-schema.ts`, `packages/intelligence/src/review/requirements.ts`, `tests/intelligence/profiles.test.ts`, `tests/intelligence/requirements.test.ts`, `tests/intelligence/verify-model.test.ts`, and this evidence file.

Remaining external gates: exact Qwen3.8-27B artifact/provenance, compatible runtime and fixed corpus, qualified reviewer vision runtime, Windows 11 x64, Photoshop/template qualification, and real per-asset visual review. Fixture tests do not establish any live qualification.

## C1 correction retry (2026-09-22)

A forged schema-valid qualification supplied directly to invocation was rejected without a registry admission. Registry registration now admits only qualification records issued by the validated qualification path and rejects unsafe evidence paths. Portable path validation rejects POSIX, drive, UNC, dot, empty, `..` and backslash traversal for artifacts and evidence; containment uses `relative()`/absolute checks rather than separator-specific prefixes. No Windows platform was simulated.

```text
npm run test:intelligence -- tests/intelligence/profiles.test.ts tests/intelligence/requirements.test.ts tests/intelligence/verify-model.test.ts
  PASS: 3 files, 28 tests
npm run test:intelligence
  PASS: 4 files, 29 tests
npm run typecheck --workspace=@ne-psd/intelligence
  PASS
npm run build --workspace=@ne-psd/intelligence
  PASS
```

The requested `Qwen3.8-27B` artifact has no authoritative matching release or compatible artifact supplied by the plan. Qualification therefore returns `MODEL_ARTIFACT_UNVERIFIED`; no download or nearby-model substitution was attempted.

Verification run:

```sh
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run verify:model --workspace @ne-psd/intelligence -- --manifest docs/intelligence/qualification/requested-local.json --artifact-only --report docs/intelligence/qualification/artifact-report.json
```

Observed result: structured report `{"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}` and exit code 1. This is the expected blocker. Build, targeted tests (10/10), full intelligence tests (11/11), and intelligence typecheck passed. No live model, Windows, Photoshop, or visual compatibility was claimed.

## C1 owner-authorized closure (2026-09-22)

The final separator-specific artifact guard was removed in favor of portable relative containment. Registry admission records are now deep-cloned and deeply frozen; mutation attempts cannot alter invocation admission. Fixture and untrusted records remain non-selectable.

```text
npm run test:intelligence -- tests/intelligence/profiles.test.ts tests/intelligence/requirements.test.ts tests/intelligence/verify-model.test.ts
  PASS: 3 files, 30 tests
npm run test:intelligence
  PASS: 4 files, 31 tests
npm run typecheck --workspace=@ne-psd/intelligence
  PASS
npm run build --workspace=@ne-psd/intelligence
  PASS
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run verify:model --workspace @ne-psd/intelligence -- --manifest docs/intelligence/qualification/requested-local.json --artifact-only --report docs/intelligence/qualification/artifact-report.json
  EXPECTED BLOCK: exit 1; structured result {"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}
git diff --check
  PASS
```
