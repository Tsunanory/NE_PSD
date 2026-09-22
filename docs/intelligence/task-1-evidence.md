# Task 1 evidence

The requested `Qwen3.8-27B` artifact has no authoritative matching release or compatible artifact supplied by the plan. Qualification therefore returns `MODEL_ARTIFACT_UNVERIFIED`; no download or nearby-model substitution was attempted.

Verification run:

```sh
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run verify:model --workspace @ne-psd/intelligence -- --manifest docs/intelligence/qualification/requested-local.json --artifact-only --report docs/intelligence/qualification/artifact-report.json
```

Observed result: structured report `{"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}` and exit code 1. This is the expected blocker. Build, targeted tests (10/10), full intelligence tests (11/11), and intelligence typecheck passed. No live model, Windows, Photoshop, or visual compatibility was claimed.
