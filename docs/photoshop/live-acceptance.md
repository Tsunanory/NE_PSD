# B15 live Photoshop acceptance

Status on 2026-09-30: **blocked**, with no live Photoshop result. This checkout has no untracked `docs/photoshop/live-machine.json`; that fact does not establish whether Photoshop is installed. The B15 harness has a deterministic composition seam, but a production inspection/proposal/B qualification/A sealing/v2 owned-input render composition has not been connected. Its injected tests prove orchestration behavior only.

## Machine selection

The operator's untracked JSON contains only local machine paths and the selected backend:

```json
{
  "schemaVersion": 1,
  "platform": "darwin",
  "backendId": "alisaitteke",
  "installationPath": "<absolute Photoshop installation directory>",
  "installationExecutable": "<absolute executable inside that directory>",
  "nodeExecutable": "<absolute Node 22.23.2 executable>",
  "serverEntry": "<absolute vendored @alisaitteke/photoshop-mcp/dist/index.js>",
  "sourceRoot": "<approved immutable template root>",
  "sourcePath": "<absolute source PSD inside sourceRoot>",
  "assetRoot": "<approved immutable input root>",
  "assetPath": "<absolute sample image inside assetRoot>",
  "workRoot": "<approved job-owned work root>",
  "evidenceRoot": "<separate approved evidence root>",
  "lockPath": "<installation lock path under workRoot>"
}
```

The parser rejects every unlisted field, including tool bindings, arbitrary steps/arguments, an executor, a tool-schema digest, a claimed capability, and a pre-sealed profile. The probe checks path types, executable bits, every existing symlink component, canonical containment and separation, the vendored entry shape, and the exact Node version before any Photoshop call. It rechecks source and output roots before creating owned files. A missing or invalid configuration returns a named block with zero Photoshop/MCP calls. The local file contains no credentials. An alternate backend requires a separately qualified source/license/schema and disconnected primary; the current probe blocks it.

Run the explicit gate with the pinned Node toolchain:

```text
npm run test:photoshop -- tests/photoshop/live.test.ts
```

## Executable sequence and required evidence

`runLiveQualification` accepts a code-supplied `LiveComposition`, never a JSON-supplied action list. A production composition must connect the B installation lock and real read-only inspection; B's isolated template/dependency preparation and qualification; a validated proposal; A's profile sealing; and the owned-input renderer. With no composition it returns `B15_LIVE_COMPOSITION_UNAVAILABLE` and makes no Photoshop call. An injected test composition returns `protocol-exercised`, never a live qualification claim.

The harness orders read-only inspection, complete linkage and selector proof, job-owned template preparation, proposal, sentinel/geometry qualification, A sealing, and one render transaction for each `cover`, `contain`, `stretch` × JPEG/PNG pair. Every transaction must produce exactly variants 1/2/3 with measured fit/clipping evidence and existing artifacts whose bytes match their digests. It requires positively quiescent cleanup, no remaining owned documents, foreign-document preservation, and unchanged original template, sample image, and discovered linked dependencies. Output bundles remain under the canonical attempt root; summary evidence is written only after all checks pass. The linked closure cannot be reported empty when live inspection found unresolved or linked documents.

Actual live acceptance also requires captured `tools/list` schema digest and version, ID-safe document routes, effective vector bounds, prepared-copy save/reopen, distinctive sentinel baseline and propagation through shared/independent content, variant/ancestor visibility, decodable sRGB/RGB-8 output, dimensions, rendering intent, JPEG background/PNG alpha and quality mapping, source/dependency byte proofs, user-open document inventory, contact sheets, timings, and explicit lock/journal reconciliation. The production composition must supply those observations; fake results or a `protocol-exercised` outcome do not satisfy them. A missing primitive is a named capability blocker. Unknown mutation or export acknowledgement retains B's installation barrier and forbids replay or same-name re-export.

## Alternate decision

Keep `alisaitteke` only after the primary proves all mandatory primitives. If one is unavailable, close and reconcile the primary, then qualify `dcc-mcp/dcc-mcp-photoshop` in a separate isolated session with exact source, license, schema digest and behavior evidence. Never run both controllers together. No Joonas source, generated JSX/UXP, arbitrary script executor or unlicensed automation is used.
