# B02 dependency handoff

## A-owned dependency request

Current package state: `packages/photoshop/package.json` imports `@modelcontextprotocol/sdk` directly from `packages/photoshop/src/mcp-client.ts`, but the package manifest does not declare it. The current workspace resolves it only through the installed/hoisted dependency graph; this is not a valid direct dependency contract.

Requested exact change by A: add direct dependency `@modelcontextprotocol/sdk` at version `1.30.0` to `packages/photoshop/package.json` and update the shared lockfile through the coordinated foundation process. B did not modify manifests or the lockfile.

Reason: the adapter uses the pinned SDK `Client` and `StdioClientTransport` exports directly. A direct declaration prevents install-layout-dependent builds and records the qualification pin.

Consumer impact: Photoshop adapter builds and runtime transport resolution become deterministic for clean workspace installs; root lockfile integrity remains A-owned. No public contracts change.

Migration/build test: after A applies the dependency request, run `PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm ci`, `npm run check`, and `npm run test:photoshop`. The B02 unit suite must remain child-process-free.

B02 inherited blocker: Windows launch-path whitespace rejection remains governed by the existing pinned-launch validation. No correction is claimed here.
## B12 transaction orchestration

Status: implemented-and-fake-tested.

Commit: `be5f0c3` (`fix(photoshop): recover ambiguous operations without replay`).

The backend transaction boundary is `packages/photoshop/src/backend.ts`, exported from the package entry point. It validates the sealed profile and runtime tool binding, holds one installation lock for the complete asset, creates a fresh adapter-owned working session, opens and verifies the graph, deduplicates proven content resources, performs placement/fit/clipping through the session, verifies propagation and source hashes, exports exactly three variants through B11, writes relative evidence, discards owned documents, and returns `RenderEvidence`. Qualification is delegated directly to B10's qualifier with the same adapter lock; B12 does not seal candidates or retry mutations.

Verification before handoff:

- `npm run test:photoshop -- tests/photoshop/backend.test.ts`: 2 passed.
- `npm run test:photoshop`: 133 passed, 1 inherited B04 selector failure (`SELECTOR_DOCUMENT_ROUTE_MISMATCH` expected, `SELECTOR_MISSING` received in `tests/photoshop/selectors.test.ts:89`). B12 does not modify B04.
- `npm run check`: passed for all workspaces.
- `git diff --check`: passed.

Limitations: live Photoshop adapter wiring, Windows qualification, and source/dependency hash implementation remain adapter/integration gates. JPEG rendering requires the qualified session to provide an explicit background policy. No live Photoshop or Windows evidence is claimed.

## B12 correction retry

The B12 correction adds runtime validation for typed `acknowledged` lifecycle proofs, requires unchanged master/dependency proofs and quiescent discard proofs, preserves the recovery barrier for ambiguous mutations, normalizes thrown failures with `code`, `category`, `retryable`, and `evidencePaths`, and makes staging evidence writes canonical/symlink-safe. Recovery evidence is resolved against the adapter's trusted `recoveryRoot`; it never uses `process.cwd()`.

Required fake coverage now includes malformed lifecycle acknowledgements, unsealed profiles, ambiguous mutation preservation without discard, existing trace retention, source/dependency bytes, referenced evidence files, and strict two-asset discard ordering. The inherited B04 selector failure remains unchanged.

## B05 known blocker

## B13 timeout and recovery handoff

Status: implemented-and-fake-tested.

The recovery boundary is `packages/photoshop/src/recovery.ts`. `OperationJournal` appends an issued record before dispatch and a terminal record after acknowledgement, failure, or explicit reconciliation. `runUncertainOperation` dispatches each operation once, applies fixed failure-detection ceilings (metadata reads 15 seconds; open/place/replace 120 seconds; save/export 180 seconds), never aborts the underlying Photoshop call on caller timeout, and converts post-dispatch timeout, cancellation, transport loss, and process loss into non-retryable `ambiguousState` errors. The local MCP barrier rejects further calls until explicit idle/document/hash reconciliation. `SessionLock` retains its OS-visible lock while the barrier is set and exposes retained-owner recovery; successful reconciliation releases it. `PhotoshopBackend.recover` runs inside that retained owner when available.

Verification:

- `PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run test:photoshop -- tests/photoshop/recovery.test.ts`: 13 passed.
- Focused B13 regression set (`recovery`, `mcp-client`, `session-lock`, `backend`): 39 passed.
- `PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm run check`: passed.
- Full `npm run test:photoshop`: 149 passed, 1 inherited B04 selector failure at `tests/photoshop/selectors.test.ts:89` (`SELECTOR_DOCUMENT_ROUTE_MISMATCH` expected, `SELECTOR_MISSING` received). B13 does not modify B04.
- `git diff --check`: passed.

Limitations: live Photoshop acknowledgement, idle/status primitive, process-death reconciliation, and Windows qualification remain untested. Recovery never replays a mutation or re-exports an ambiguous filename; operator reconciliation or a new attempt is required after an unresolved barrier. Source/master/dependency preservation remains enforced by B12's transaction boundary and is not weakened by B13.

## B13 correction retry

The correction adds unresolved-transport tracking through timeout and late-reply settlement, dynamic operation-specific journal binding after lock acquisition, crash-durable hash-chained journal validation, explicit stale-owner adoption, persisted identity/ownership/path/depth checks, and typed timeout-safe recovery. Backend recovery now clears and releases only after safe proof; failed or ambiguous recovery marks and retains the barrier. Unknown journal-terminal write failures fail closed. The observer checkpoint is recorded in `skill-observations/checkpoints.log`.

Correction commit: `a61c0c5` (`fix(photoshop): close B13 recovery race conditions`). Correction verification: focused recovery/session/backend/MCP tests: 46 passed; workspace checks passed. Full Photoshop suite: 156 passed, 1 inherited B04 selector failure at `tests/photoshop/selectors.test.ts:89`; `git diff --check` passed. Live Photoshop, Windows, and process-death qualification remain untested.

B04's same-name/kind sibling ambiguity check compares structural equivalence against `typed[0]`. If the selected duplicate is not the first typed candidate, an identical sibling can be missed. B05 does not change B04 after its retry cap; B14/integration must resolve this under its authorized scope.
