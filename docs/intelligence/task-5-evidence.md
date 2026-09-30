# Task 5 qualification evidence — 2026-09-30

The C5 implementation covers the locked corpus driver, candidate trial path, resource gates, public qualification adapter, and package-local `qualify:model` command. Checks used Node 22.23.2 and npm 10.9.8. No real model artifact, Windows host, or Photoshop workload was available.

The initial harness packet passed 8 focused tests in 2 files. It exercised 64 synthetic cases three times, including reviewer routing, model-call counts, preflight rejection, seeded visual defects, and profile substitution. This was an intermediate check; final verification followed after integration.

Final local verification:

```text
npm run build --workspace @ne-psd/intelligence                 PASS, exit 0
npm run test:intelligence                                       PASS, 24 files / 227 tests, exit 0
npm run check                                                   PASS, exit 0
git diff --check                                               PASS, exit 0
```

The public adapter regression reached a fake hanging transport, then caller cancellation aborted its request without resource measurement or report persistence. Corpus lock and tamper checks passed in the full suite. These synthetic checks establish implementation behavior, not live visual or release qualification.

The package-local command `npm run qualify:model --workspace @ne-psd/intelligence --` ran with paths relative to `packages/intelligence`. The win32-on-Mac run exited 1 with `PLATFORM_MISMATCH:win32:darwin`. The darwin run exited 1 with `PLANNER.ARTIFACT_UNVERIFIED`, `REVIEWER.ARTIFACT_UNVERIFIED`, and `REVIEWER.VISION_UNQUALIFIED`. Both reports have `status:blocked`, `productionSelectable:false`, and `corpus:null`. Their paths are `/private/tmp/ne-psd-c5-npm-win32-final.json` and `/private/tmp/ne-psd-c5-npm-darwin-final.json`. Root command forwarding remains an A-owned request; the package-local script is present.

Remaining gates are exact-artifact Qwen runtime qualification, real Windows co-resident resource measurement and Photoshop workload, visual defect review, and the approved V2 evidence and release boundary. No current report qualifies production selection or publication.
