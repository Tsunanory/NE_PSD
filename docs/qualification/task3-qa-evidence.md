# Task 3a — deterministic export QA (2026-09-30)

Scope: standalone `packages/core/src/artifact-qa.ts` over one trusted `RenderRequest`, one `RenderEvidence` v1 object, three actual export files, and expected persisted bindings. This packet does not perform visual review, publication, Photoshop mutation, or release qualification.

## Behavior and trust boundary

- Parses request/evidence schemas; compares job, asset, attempt, profile, source and tool digests. The caller supplies the expected review-policy digest, source path, and exact digests for source/trace/check files from trusted persisted state. RenderEvidence v1 does **not** contain a policy digest or trace-file digests, so a producer-only V1 object cannot prove those bindings. The returned `BINDING.CURRENT_ATTEMPT` and `EVIDENCE.TRACE_COMPLETE` requirement results remain `unknown` until the caller and V2 proof path are integrated.
- Canonicalizes the staging root, refuses symlinks or special files in referenced paths, confines all reads to it, and compares the export directory against exactly three distinct declared paths/IDs. Rehashes and byte-counts all three exports plus every supplied source/evidence input. Missing, extra, partial, malformed, or changed files fail closed.
- Fully decodes every export with Sharp. Checks measured format, dimensions, sRGB working space, JPEG alpha absence, and nonempty decoded pixels against the requested output. Records SHA-256 of encoded bytes and fully decoded pixel bytes. `passed: true` from the producer never substitutes for these measurements; a producer `passed: false` rejects the packet.
- Compares producer geometry records to the requested cover/contain/stretch fit using decoded source dimensions, centered reference bounds, clipping/adjacency flags, target selectors, and a profile/qualification-bound tolerance capped at four pixels. Checks each variant's structural visibility record has only its own ID. These are consistency checks on producer trace fields, **not independent proof** that Photoshop actually placed layers or hid other groups. `GEOMETRY.REQUESTED_FIT`, `CLIPPING.ALPHA_ADJACENCY`, and `VARIANTS.VISIBILITY` therefore remain `unknown` as mandatory requirement results pending B V2/real Photoshop proof.
- Uniform pixels and duplicate exports are diagnostics by default. `IMAGE.QUALITY` is `unknown` without a trusted calibration record. With a profile/qualification-bound calibration, the module measures each image's first-pixel match fraction and opaque-pixel fraction and the three-image identical-pixel pair count. All limits must be finite and bounded; a failed calibrated limit rejects. Legitimate white or identical variants can be permitted by their calibrated limits. The integration layer must validate the calibration's persisted qualification provenance before passing it here.

The API returns `artifactChecksPassed: true` only for the measured artifact checks. It also returns per-requirement `pass`/`unknown` results so a review gate cannot treat unknown quality or producer-only geometry as complete mandatory coverage. The whole result is not a publication decision. Files must be sealed and rehashed again at the later publication boundary if concurrent mutation is possible.

## Verification

The focused test was run before implementation and failed, then run against the initial stub and failed on the missing behavior. Under the shared Node `v22.23.2`/npm `10.9.8` toolchain:

```sh
npm run test:core -- tests/core/artifact-qa.test.ts
# 1 file, 17 tests passed
npm run check --workspace=@ne-psd/core
# typecheck passed
git diff --check
# passed
```

Real temporary PNG/JPEG fixture files cover byte tampering, complete decode failure, wrong format/dimensions/CMYK, missing/extra/duplicate paths, traversal/symlink, source/trace digest changes, binding drift, cover/contain/stretch geometry, visibility, and bounded quality/alpha thresholds. Test images are job-owned temporary files; originals in the repository are untouched. Full core suites were not run while separate T2/V2 workers were editing shared state.

Core now declares direct `sharp: 0.35.4` so clean installs have the dependency this module imports. The A-owned manifest/lock correction is commit `4d58ebf`; offline lock-only resolution preserved the already locked package and integrity value. A future integration packet must connect V2 proof validation, sealed calibration provenance, the review gate, and publication. No live Photoshop, Windows, Electron native ABI, or model review was exercised here.
