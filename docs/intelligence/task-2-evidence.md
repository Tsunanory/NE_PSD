# Task 2 evidence

## C2 implementation (2026-09-22)

Initial checkout: branch `build/intelligence`, HEAD `629511d254da99a4e86a841c325705355923cde6`. Existing C1 and outside-ownership edits were preserved.

Focused Task 2 command:

```text
npm run test:intelligence -- tests/intelligence/fresh-context.test.ts tests/intelligence/strict-json.test.ts tests/intelligence/context-budget.test.ts tests/intelligence/transport-errors.test.ts tests/intelligence/prompt-integrity.test.ts
  PASS: 5 files, 26 tests
```

Prompt source block hashes (exact UTF-8 fenced literal block, LF):

```text
planner: 7526e222bc7df7ec0211f72f678e1f5dcaecf8344b68f88eeb565dc449726b63
runtime-reviewer: 5964f89bb5bfb776523ce0c012cd1063508b92b38ebbbf6cc677c7ded7bb132d
diagnostic: 32fbacdb9c912137751b4c0c202a851fb24c4fa60e1dfb211d35bdaddb952285
```

The prompt registry reads only the three fixed approved source paths, extracts the literal `text` block, verifies the pinned digest, and rejects placeholders. The generated `.txt` package assets contain the same exact bytes and carry the same hashes. It does not accept model- or inspection-selected paths.

Design rulings: no documented Codex bridge is available, so the adapter returns a precise blocked capability error and does not invent an endpoint. Local runtime is loopback-only and requires an exact identity/JSON-schema handshake. Strict JSON is full-value bounded parsing with duplicate-key detection and no repair. Context accounting includes system, user, schema, wrappers, images, reserved output and safety margin, using the smaller verified context. No automatic retry, replay or fallback is implemented.

Remaining live gates: exact local Qwen artifact/runtime qualification, provider handshake, tokenizer/chat-template qualification, actual vision runtime, documented Codex bridge if selected, Windows/Photoshop qualification, and live inference. No network or model load occurred.

Verification:

```text
npm run test:intelligence
  PASS: 9 files, 57 tests
npm run typecheck --workspace=@ne-psd/intelligence
  PASS
npm run build --workspace=@ne-psd/intelligence
  PASS
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run verify:model --workspace @ne-psd/intelligence -- --manifest docs/intelligence/qualification/requested-local.json --artifact-only --report docs/intelligence/qualification/artifact-report.json
  EXPECTED BLOCK: exit 1; {"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}
git diff --check
  PASS
```

## C2 correction packet (2026-09-22)

Prompt assets are copied with a package-local Node 22 script (`scripts/copy-prompts.mjs`), and runtime reads them via `fileURLToPath`, avoiding Unix path assumptions. Exported prompt specifications are deeply immutable. Adapter requests are validated before local/Codex capability errors; local handshakes bind model, revision/runtime identity, limits, schema and image capabilities. Profile-pinned remote revisions cannot be omitted, and requested output tokens cannot exceed the qualified profile. A linked abort controller cancels the single underlying call on parent abort or timeout. Strict schema validation and budget-integrated preflight were added.

Correction verification:

```text
npm run test:intelligence -- tests/intelligence/fresh-context.test.ts tests/intelligence/strict-json.test.ts tests/intelligence/context-budget.test.ts tests/intelligence/transport-errors.test.ts tests/intelligence/prompt-integrity.test.ts
  PASS: 5 files, 26 tests
npm run test:intelligence
  PASS: 9 files, 57 tests
npm run typecheck --workspace=@ne-psd/intelligence
  PASS
npm run build --workspace=@ne-psd/intelligence
  PASS (Node asset-copy script; cross-platform mechanism)
verify:model --artifact-only
  EXPECTED BLOCK: exit 1; {"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}
git diff --check
  PASS
```
