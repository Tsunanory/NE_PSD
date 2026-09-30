# Task 3 — C3 closure evidence (2026-09-30)

Scope: planner, diagnostic adapter, token preflight, fixtures and injection boundary in `@ne-psd/intelligence`. This is implementation and synthetic test evidence, not local Qwen or Windows/Photoshop qualification. Worktree `build/intelligence`; A dependency commit `65cd97f` adopted from `a4c998c` without disturbing prior lane edits. The owner's original PSD/assets were not touched.

## Changes

- Planner and diagnostic preflight use the exact `TransportRequest` passed to bounded invocation. A qualified adapter reports system, user, generated schema, real message/wrapper and image token components. The host reserves output and safety tokens, checks both selected-model and admitted-runtime context, and rejects overflow before any transport call. The adapter identity must match the registry-admitted profile, artifact provenance, qualification evidence path, tokenizer, chat template, runtime build and recorded `runtimeSettings.contextTokens`. Missing or mismatched evidence fails closed. Synthetic test counters exercise the arithmetic; they do not prove a real tokenizer or runtime integration.
- Planner validation covers every selected target/reference/input tuple, observed document keys/lineage, roles and selector kinds, and requires all three variants to connect to every selected target. It retains the user's explicit fit mode. Blocked results preserve known target/variant selections and admit indexed missing fields. The eight fixtures now assert accepted fields or specific rejection codes: graph success, explicit IDs under duplicate names, disconnected dimensions, stale IDs, duplicate mapping, missing dimensions, linked isolation and fit capability.
- Generated JSON Schemas expose nested required fields, enums, cardinality and closed objects; host parsing still enforces cross-field and binding rules. Zod `4.6.5` is now directly pinned through A's coordinated root lock/manifest commit.
- Diagnostic retry admission requires attempt 1, safe cleanup, known cause, allowlisted cause `CONFIGURATION_DRIFT`, coordinator-owned correction `REAPPLY_APPROVED_CONFIGURATION`, and visual attestation. The response remains advisory. Independent tests exercise timeout, unsupported operation, attempt 2, missing attestation, all echoed bindings, nested references and malformed output.
- Planner and diagnostic injection tests place hostile text in filenames, layer names, metadata, tool output and errors; include JSON fragments, fake roles, fences, Unicode lookalikes and base64. They assert stable system prompt/profile/endpoint, two messages, no tools/history, and host rejection of fabricated IDs or actions.

## Fresh pinned verification

Runtime: Node `22.23.2`, npm `10.9.8` from the shared verified toolchain at `.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin` (A's `docs/qualification/toolchain-2026-09-30.md`). All commands ran in the intelligence worktree with that path prepended. The initial Node 25 diagnostic baseline is excluded from acceptance.

```text
npm run build --workspace @ne-psd/contracts                 PASS
npm run build --workspace @ne-psd/intelligence              PASS
npm run test:intelligence -- planner diagnostic injection  PASS, 3 files / 70 tests
npm run test:intelligence                                   PASS, 12 files / 127 tests
npm run typecheck --workspace @ne-psd/intelligence          PASS
git diff --check                                            PASS
npm run verify:model --workspace @ne-psd/intelligence -- --manifest docs/intelligence/qualification/requested-local.json --artifact-only --report docs/intelligence/qualification/artifact-report.json
  EXPECTED BLOCK, exit 1: {"ok":false,"artifactVerified":false,"runtimeQualified":false,"profile":"requested-local"}
```

## Remaining integration and live gates

A's shared `ConfigurationProposalSchema` still rejects complete non-null `OutputSpec` on blocked proposals; the required minimal shared fix is recorded in `task-3-dependency-request.md`. Null output remains correct for unresolved width/height. No private schema cast or C-owned contract fork was used. No real tokenizer adapter, selected Qwen artifact, Windows runtime, Photoshop evidence or live inference was available; synthetic counters and fake model responses cannot establish those gates. The Sharp decoder and persisted attempt/attestation contracts in the request document are for C4 and do not block lane-local C3 tests.
