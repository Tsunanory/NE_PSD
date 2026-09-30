# Photoshop MCP tool qualification

Status: `implemented-and-fake-tested`; B15 live qualification remains blocked. The local machine configuration and production composition are absent; this alone does not prove Photoshop is absent from the host.

## Pinned primary package evidence

The selected primary is `@alisaitteke/photoshop-mcp` 1.7.19. Historical foundation runtime-lock evidence records source commit `143b69dba18dc5992c56a5d489b6efbfed173e1a`, package integrity `sha512-UEsZLBCuSh0TqVpKul6n2BVu3DW/G1gJ6oD8LwLAzBL7eaLTwtay3oSPDf/YHCL8ypvzXQlJEzwsaveCzEzXuA==`, and license `MIT`. The previously inspected installed package's `LICENSE` was MIT with copyright `2026 Ali Sait Teke`; it grants use, modification and distribution subject to retaining the notice and provides no warranty. This is historical package/license evidence, not a fresh 2026-09-30 source inspection or live Photoshop proof.

The locked launch contract is an absolute Node 22.23.2 executable followed by an argument array whose first element is the absolute vendored `node_modules/@alisaitteke/photoshop-mcp/dist/index.js` entry. No shell, `npx`, network fetch, arbitrary script executor or generated JSX/UXP is allowed. A live `tools/list` response must be captured, canonicalized and hashed before any semantic call. Exact input/output schemas, units, active-document behavior, mutation flags, timeout observations and source locations remain unqualified until that capture is made.

The B02 unit fixture at `tests/photoshop/fixtures/tool-schema.synthetic.json` is explicitly synthetic. It is not upstream evidence and does not claim that `fixture_scale` exists in Photoshop MCP. The adapter computes a canonical SHA-256 digest for every `tools/list` response and rejects a changed pinned digest before any call.

The semantic map is allowlisted. Candidate names from the plan remain capability gaps until a pinned source, exact input/output schemas, units, active-document behavior, mutation flag, and live timeout proof are recorded. Independent-axis scale is rejected; arbitrary script execution is not allowlisted. Structured MCP errors, malformed responses, and schema mismatches fail closed. Traces redact all argument values.

Pinned runtime evidence: `docs/qualification/runtime-lock.json` records `@modelcontextprotocol/sdk` 1.30.0 and `@alisaitteke/photoshop-mcp` 1.7.19. A live launch must use the locked Node 22.23.2 executable and an argument array; unit tests never launch Photoshop or fetch/install packages.

The 2026-09-30 B15 harness permits only machine paths/backend selection in its local JSON. Tool bindings and schemas must come from a code-supplied, qualified production composition and captured `tools/list`, not operator-entered JSON. Its current injected six-case test is protocol evidence only. No live schema digest, Photoshop version or supported primitive has been newly observed.

## B11 export and visibility semantics

The export binding is valid only when pinned `tools/list` schemas and live evidence prove actual pixel conversion to embedded sRGB, a declared rendering intent, RGB/8 output, dimensions, format, and alpha behavior. An sRGB label on unchanged pixels is not conversion evidence. Visibility bindings must acknowledge every hide/show mutation and reread effective ancestor visibility for exactly the case-sensitive IDs `1`, `2`, and `3`.

JPEG quality is a shared-contract integer in `1..100`; the exporter forwards it only when the live schema proves that exact unit range. A backend schema advertising `0..12` is a capability mismatch, not a value to infer or rescale. PNG never receives a quality argument. Export state that can mutate a document is prepared on a disposable job-owned duplicate and cleanup is acknowledged before the result is accepted.

Each export is written to a collision-free path inside the attempt bundle. The returned file path must match the requested path exactly, survive traversal and symlink checks, decode with Sharp at the exact dimensions and format, contain readable pixels and an embedded verified sRGB profile, and satisfy the format-specific alpha/background policy. Artifact paths are relative to the bundle and carry a SHA-256 digest. These development tests use synthetic Sharp files only; no live Photoshop or Windows qualification is claimed here.
