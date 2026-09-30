# D-R2 desktop setup and job handoff

The native setup controller now owns source selection, streamed hashes, template inspection, editable proposals, job-owned working copies, three decoded preview images, operator confirmation, candidate/profile persistence, model qualification, and job submission. The renderer uses the typed preload bridge. The main process persists recent job IDs, reloads snapshots, verifies review-image bytes against the current request and manifest, opens only a committed output whose record and digest verify, and pauses active jobs before application exit. Explicit development fake mode supplies labeled synthetic review fixtures. Production adapters are injected; missing adapters fail closed.

Model qualification is bound to the exact catalog profile digest. A fresh service result is merged into main-owned catalog capacity/provenance evidence; failed or stale qualification blocks job start. A qualified text-only planner may pair with an independently qualified vision reviewer. Three preview IDs, profile digest, content digests, actual JPEG/PNG decoding, production output dimensions, and the synthetic/production boundary are checked before operator confirmation.

Local verification with pinned Node 22.23.2: desktop Vitest 19 files, 104 tests passed; desktop typecheck and build passed. Focused setup/model tests passed after the final preview-dimension regression. GUI endurance result is recorded separately by R5. These are fake-backed and macOS build checks, not live Windows, Photoshop, exact Qwen artifact/runtime, or signing qualification.

A integration dependencies:

- Supply production `DesktopServices` with real `JobService`, `SetupService`, exact model catalog evidence and qualification, three trustworthy preview bytes/digests, review manifest adapter, and committed-output record adapter. Preview SHA-256 and image decoding verify bytes supplied by the adapter; live Photoshop provenance still requires the production adapter and Windows gate.
- Supply durable records to the D-owned optional `JobDetailAdapter` for per-variant reviewer verdicts, prior attempts, and diagnostic evidence IDs. Its IPC projection validates `ReviewDecision` and manifest bindings, redacts diagnostic paths, and returns unavailable when the adapter is absent. Frozen `JobService` exposes only snapshot status/attempt count/error and current `VisualReviewRequest`.
- Integrate direct desktop `esbuild` and `sharp` edges into A-owned root lockfile as specified in [dependency-requests.md](../dependency-requests.md). Then verify a clean install and Windows package. Current installed-tree checks do not prove either.

No original PSD or input asset was modified. No scheduler was added. Production model and Photoshop qualification remain open live gates.
