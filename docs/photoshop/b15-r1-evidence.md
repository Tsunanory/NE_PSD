# B15-R1 trace contract evidence — 2026-09-30

Status: implemented and tested with fakes. No Photoshop or Windows run occurred.

Baseline: `54ef4207577099621548eeed11d02aa0707a64a2` on `build/photoshop`. Existing B15-C1 dirty files were retained. This packet changes only the trace contract, its producers, backend validation, and focused tests. The unrelated B15-C1 `McpClient` transport `close` hunk remains uncommitted.

The shared JSONL record carries sequence, operation identity, request identity, phase and outcome. `DocumentStack` records the full lifecycle observation as an event and captures the actual working file bytes before opening and after owned cleanup. `McpClient` captures the dispatched request and acknowledged response bytes. Snapshots are written under the attempt bundle before their digest records. The backend requires ordered pairs for the current `jobId:assetId:attempt`, checks regular confined files, byte lengths and SHA-256, and rejects incomplete or failed traces. The trace is evidence of these captured bytes and lifecycle observations; it does not itself establish live Photoshop correctness.

Pinned runtime: `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin`, Node `v22.23.2`, npm `10.9.8`. Commands in the Photoshop worktree:

- `npm run test:photoshop -- tests/photoshop/documents.test.ts tests/photoshop/mcp-client.test.ts tests/photoshop/backend.test.ts`: 3 files, 40 tests passed.
- `npm run check`: passed for all workspaces.
- `git diff --check`: passed.

The tests exercise both real producers through the backend validator, plus missing trace, wrong operation identity, reversed order, changed digest, changed snapshot bytes and symlink escape. The transaction test still verifies three staged artifacts and owned cleanup using fake adapters.

Live Photoshop and packaged Windows gates remain unverified. R2–R9 remain separate packets.
