# Template inspection and qualification boundary

Inspection is read-only evidence. It snapshots the selected template before opening or traversing any child document, records pre-existing document IDs, and closes only documents opened by the inspection without saving. A user-open document is never closed.

The report distinguishes raw raster bounds from effective live bounds. Shape/vector layers may have zero or absent raster bounds while Photoshop reports a non-empty effective rectangle. The supplied child canvas is expected to be `3190 × 1418`; the reference shape's effective bounds are `{left:100,top:200,right:900,bottom:600}`. Unknown or missing linkage is retained as `sourceKind: "unknown"`, recorded in `unresolvedLinks`, and blocks qualification. No parent-child edge is invented from matching names or dimensions.

`staticCandidate` reports have `capabilities: null` and are never qualification results. `liveObserved` reports require a validated capability report, but live evidence still remains a candidate until geometry, sentinel, linkage isolation, and the other qualification checks pass. Inspection reports do not contain `qualificationId`, `profileSha256`, or a `TemplateProfile`.

The qualification flow is `InspectionReport → ConfigurationProposal → QualificationRequest → QualificationResult`. A request can be formed without a `TemplateProfile`; static-only and unresolved-link requests must be blocked before rendering.
