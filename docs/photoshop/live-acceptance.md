# B15 live Photoshop acceptance

Status: `blocked-external` on the current development host. The repository has no `docs/photoshop/live-machine.json`, the runtime lock records no available Photoshop installation, and no Windows 11 x64 host is available. Fake tests are not live qualification.

## Machine configuration

The operator creates the untracked file `docs/photoshop/live-machine.json` on the qualified machine. It contains only:

```json
{
  "schemaVersion": 1,
  "installationPath": "<absolute Photoshop installation>",
  "nodeExecutable": "<absolute Node 22.23.2 executable>",
  "serverEntry": "<absolute vendored @alisaitteke/photoshop-mcp/dist/index.js>",
  "sourcePath": "<absolute source PSD>",
  "workRoot": "<approved job-owned work root>",
  "evidenceRoot": "<approved evidence root>",
  "backendId": "alisaitteke",
  "platform": "darwin"
}
```

The live test validates absolute paths, selected backend, platform and the existence/executability of the installation, pinned Node, vendored MCP entry, source and approved roots. It performs no Photoshop or MCP call while the configuration is absent or any probe is blocked. It never reads or mutates user-open documents. Passwords and credentials are not accepted.

Run the gate explicitly:

```text
npm run test:photoshop -- tests/photoshop/live.test.ts
```

The current result is named `B15_LIVE_BLOCKED`; the test output is not a live pass.

## Required isolated live sequence

On a qualified machine, use a fresh job-owned copy and a fresh evidence directory. Keep the source PSD and all discovered linked dependencies immutable. Before any mutation, record source/dependency hashes and the pre-existing Photoshop document IDs. Run, in order:

1. Read-only inspection and `tools/list` schema digest capture.
2. Source kind, dependency closure and user-document preservation checks.
3. Effective vector bounds, document route and ID-safe selector proof.
4. Prepared-copy save/reopen only when required; never prepare the supplied master.
5. Sentinel baseline capture bound to each target ID and region.
6. Sentinel propagation through shared and independent content identities, with acknowledged save/reopen and post-reopen correspondence.
7. One asset each in `cover`, `contain` and `stretch`, using measured post-place bounds and the exact reference region.
8. Variant visibility and ancestor visibility for IDs `1`, `2`, `3`.
9. JPEG and PNG output probes: dimensions, RGB/8, embedded sRGB conversion, rendering intent, alpha/background policy, decodability and byte hashes.
10. Reverse-depth cleanup, idle/reconciliation proof, source/dependency hash checks and evidence-path containment.

The mandatory gate passes only when every step is evidenced. A missing primitive is a blocked capability, not a skipped requirement. Unknown mutation or export acknowledgement retains the installation barrier and forbids replay or same-name re-export.

## Alternate decision

Keep `alisaitteke` only when live evidence proves ID-safe selection, child lifecycle, all three fit modes, clipping, propagation and export. If a mandatory primary primitive is unavailable, close and reconcile the primary session, release its safe lock, and qualify `dcc-mcp/dcc-mcp-photoshop` in a separate isolated session. Record its exact source, license, schemas, digest and capability failures. Never run both controllers against Photoshop. If neither route satisfies a mandatory requirement, release remains blocked.

No Joonas source, generated JSX/UXP, arbitrary script executor or unlicensed automation is used in this baseline.
