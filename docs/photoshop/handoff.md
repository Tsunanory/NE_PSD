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

B04's same-name/kind sibling ambiguity check compares structural equivalence against `typed[0]`. If the selected duplicate is not the first typed candidate, an identical sibling can be missed. B05 does not change B04 after its retry cap; B14/integration must resolve this under its authorized scope.
