# Desktop architecture

The main process owns services, path resolution and IPC validation. The preload exposes fixed operations through context isolation; the renderer receives no Node, shell, filesystem or MCP API. The shell uses independent contract-backed fakes and does not select them from environment variables or query strings.

Baseline and contracts: foundation `7a641915104eabb643e3f261674f38bd6b69217d`; imports `@ne-psd/contracts` and `@ne-psd/core`; fixtures under `tests/fixtures/contracts/`; Node 22.23.2/npm 10.9.8; Electron 41.0.0.
