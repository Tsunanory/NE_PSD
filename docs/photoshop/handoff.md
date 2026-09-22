# B02 dependency handoff

## A-owned dependency request

Current package state: `packages/photoshop/package.json` imports `@modelcontextprotocol/sdk` directly from `packages/photoshop/src/mcp-client.ts`, but the package manifest does not declare it. The current workspace resolves it only through the installed/hoisted dependency graph; this is not a valid direct dependency contract.

Requested exact change by A: add direct dependency `@modelcontextprotocol/sdk` at version `1.30.0` to `packages/photoshop/package.json` and update the shared lockfile through the coordinated foundation process. B did not modify manifests or the lockfile.

Reason: the adapter uses the pinned SDK `Client` and `StdioClientTransport` exports directly. A direct declaration prevents install-layout-dependent builds and records the qualification pin.

Consumer impact: Photoshop adapter builds and runtime transport resolution become deterministic for clean workspace installs; root lockfile integrity remains A-owned. No public contracts change.

Migration/build test: after A applies the dependency request, run `PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH npm ci`, `npm run check`, and `npm run test:photoshop`. The B02 unit suite must remain child-process-free.
