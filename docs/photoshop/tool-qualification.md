# Photoshop MCP tool qualification

Status: `implemented-and-fake-tested`; live Photoshop qualification is blocked because no Photoshop installation is available on this host.

The B02 unit fixture at `tests/photoshop/fixtures/tool-schema.synthetic.json` is explicitly synthetic. It is not upstream evidence and does not claim that `fixture_scale` exists in Photoshop MCP. The adapter computes a canonical SHA-256 digest for every `tools/list` response and rejects a changed pinned digest before any call.

The semantic map is allowlisted. Candidate names from the plan remain capability gaps until a pinned source, exact input/output schemas, units, active-document behavior, mutation flag, and live timeout proof are recorded. Independent-axis scale is rejected; arbitrary script execution is not allowlisted. Structured MCP errors, malformed responses, and schema mismatches fail closed. Traces redact all argument values.

Pinned runtime evidence: `docs/qualification/runtime-lock.json` records `@modelcontextprotocol/sdk` 1.30.0 and `@alisaitteke/photoshop-mcp` 1.7.19. A live launch must use the locked Node 22.23.2 executable and an argument array; unit tests never launch Photoshop or fetch/install packages.
