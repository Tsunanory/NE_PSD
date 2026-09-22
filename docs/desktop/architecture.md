# Desktop architecture

The main process owns services, path resolution and IPC validation. The preload exposes fixed operations through context isolation; the renderer receives no Node, shell, filesystem or MCP API. The shell uses independent contract-backed fakes and does not select them from environment variables or query strings.

Baseline and contracts: foundation `7a641915104eabb643e3f261674f38bd6b69217d`; imports `@ne-psd/contracts` and `@ne-psd/core`; fixtures under `tests/fixtures/contracts/`; Node 22.23.2/npm 10.9.8; Electron 41.0.0.

Fixture manifest: `capabilities.fake.json`, `capabilities.json`, `chat-template.json`, `document-trace.json`, `evidence.pass.json`, `geometry.json`, `inspection.{json,live.json,static.json}`, `job-event.{blocked.json,running.json}`, `job.interactive.json`, `manifest.pass.json`, `model.{bin,local.json,remote.json}`, `policy.v1.json`, `profile.qualified.json`, `proposal.valid.json`, `qualification-{request,result}.json`, `render-request.valid.json`, `review.{blocked,pass}.json`, `source.png`, `template.psd`, `tool-trace.json`, `variant-{1,2,3}.jpg`, and `visual-review-request.json`.
