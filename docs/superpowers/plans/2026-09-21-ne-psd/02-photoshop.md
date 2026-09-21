# NE_PSD Photoshop Backend Implementation Plan

> Routing: [model-routing.md](../../model-routing.md). Ponytail full applies to coding, design and code review.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and qualify a deterministic Photoshop adapter that places each asset against the actual reference layer, updates every required mockup instance, and produces exactly three correct staged exports without changing originals.

**Architecture:** Implement `PhotoshopBackend` from `@ne-psd/contracts` using the official MCP SDK and a pinned alisaitteke server. Compose existing tools in application code; preserve geometry/clipping in a prepared PSD where this reduces runtime work. One installation lock and one in-flight Photoshop call cover inspection, rendering and recovery; DCC is an explicitly selected, separately qualified alternative when a required primitive is missing.

**Tech Stack:** TypeScript strict, Node 22 LTS patch pinned by A, npm workspaces, official TypeScript MCP SDK, Zod contracts, Vitest, Sharp for export verification; existing Photoshop and qualified existing MCP tools/Actions. macOS development and Windows 11 x64 final qualification are separate gates.

---

## Scope, evidence and prerequisites

Authoritative specification: `docs/superpowers/specs/2026-09-21-ne-psd-design.md`. Run repository-relative commands from `/Users/tsunanory/Desktop/Engines/NE_PSD` or the corresponding implementation worktree. This document is a plan; its future commands and test expectations are not claims that application tests have run.

Worker B owns `packages/photoshop/`, `tests/photoshop/`, and `docs/photoshop/`. A owns contracts, dependency decisions, root scripts and the lockfile. Start from A's frozen foundation commit. Do not add a second lock implementation in core, edit another worker's files, or resolve shared-contract uncertainty with local casts. Record dependency/contract requests in `docs/photoshop/handoff.md`; A integrates them sequentially. B can complete fake-based work while A, C and D run their own fakes; real Photoshop calls remain serial.

Foundation must provide `@ne-psd/contracts`, matching Zod schemas, the `@ne-psd/photoshop` workspace manifest, `npm run test:photoshop -- <filter>`, `npm run check`, `tests/fixtures/contracts/inspection.live.json`, `tests/fixtures/contracts/inspection.static.json`, `tests/fixtures/contracts/profile.qualified.json`, `tests/fixtures/contracts/evidence.pass.json`, `tests/fixtures/contracts/render-request.valid.json`, `tests/fixtures/contracts/capabilities.fake.json`, and `docs/qualification/runtime-lock.json`. Read exact installed SDK exports from the pinned dependency; do not invent a library import path or use a floating server version.

Actual static evidence is saved in `docs/photoshop/2026-09-21-static-psd-inspection.md`, including the exact read-only command. Source `/Users/tsunanory/Downloads/мокап_готово.psd`: 414738410 bytes; SHA-256 `1d14b685b6b9068f55e582c400b29429793f4c6eed8f761447163bbe5dd3bfcd`; 1500 × 2000 RGB/8; 73 outer layer records. The candidate target `МЕНЯТЬ ЗДЕСЬ!` and groups `1 картинка`, `2 картинка`, `3 картинка` exist. A 3190 × 1418 embedded PSB candidate contains `Прямоугольник 3` and clipped `Слой 4`. The former has vector metadata and **zero raw pixel bounds**; the latter appears to be a pixel layer, not a proven replaceable Smart Object.

That PSB's association with the outer target, shared-instance propagation, effective vector bounds and complete external linkage remain unproven. The five embedded candidates do not prove absence of linked assets. Static metadata is candidate evidence only and cannot produce an accepted `TemplateProfile`. Raw file IDs never become durable selectors. Supplied report claims about GitHub, licenses, tool names and APIs are **report-only** until Tasks B02/B15 record pinned source and live observations. The report's built-in one-output batch recipe is not the required three-output transaction.

The baseline writes no new JSX or UXP script, does not call an arbitrary script executor, and does not load Joonas source. Reuse existing tools, prepared template relationships, existing qualified Actions and SDKs first. App-side sequencing/math is expected new application code. Full release requires `cover`, `contain`, **and** `stretch`; failure to qualify one is a release blocker. No cover-for-stretch substitution and no silent backend switching.

Qualification has its own frozen boundary before a `TemplateProfile` exists. Import these definitions and their schemas from `@ne-psd/contracts`; this is a contract excerpt, not a second local type definition:

```typescript
type TemplateCandidate = Omit<TemplateProfile, 'profileSha256' | 'qualificationId'>;
type QualificationRequest = {
  schemaVersion:1;
  inspection:InspectionReport;
  proposal:ConfigurationProposal;
  workingTemplatePath:string;
  evidenceDirectory:string;
};
type QualificationResult = {
  status:'qualified'|'blocked';
  candidate:TemplateCandidate|null;
  checks:Array<{ id:string; passed:boolean; evidencePath:string }>;
  evidencePaths:string[];
  errors:DomainError[];
};
// Additional method on the shared PhotoshopBackend interface:
qualify(request:QualificationRequest, signal:AbortSignal):Promise<QualificationResult>;
```

The flow is `InspectionReport → ConfigurationProposal → qualify → QualificationResult → A validates evidence and seals TemplateProfile`. B owns isolated-copy, linkage, sentinel, geometry and prepared-template qualification under its existing installation lock. A alone assigns `qualificationId` and `profileSha256` after validating a successful result and its evidence. Never forge these fields or call `render` with an unqualified profile to bootstrap qualification. When preparation changes the template, the candidate returns the new prepared file's `FileRef`, SHA-256 and selectors; the supplied master remains unchanged. A blocked result has `candidate:null` and concrete checks/errors. Qualification evidence paths are relative to the trusted `evidenceDirectory`; that directory and `workingTemplatePath` are canonical absolute host paths confined to approved roots.

## Session and verification rule

Invoke task-observer and run its session-start protocol using the stable NE_PSD observation anchor. Run each task's named tests and record actual results. Flush observations or a no-observation checkpoint after each three tasks and at handoff. The requested reviewer layer checks actual output images in Windows at runtime; do not add a mandatory new reviewer session after each development task.

## File map

| Path | Responsibility |
|---|---|
| `packages/photoshop/src/index.ts` | Public backend factory and typed exports only |
| `packages/photoshop/src/types.ts` | Adapter-internal normalized document, layer, operation and journal types |
| `packages/photoshop/src/mcp-client.ts` | SDK transport, pinned launch, request/response tracing, schema checks |
| `packages/photoshop/src/tool-map.ts` | Qualified semantic operation → existing tool/Action mapping |
| `packages/photoshop/src/session-lock.ts` | Cross-process installation lock and conservative recovery barrier |
| `packages/photoshop/src/selectors.ts` | Structural fingerprints and strict current-ID resolution |
| `packages/photoshop/src/inspection.ts` | Read-only qualification graph and candidate inspection |
| `packages/photoshop/src/working-copy.ts` | Isolated attempt files and linked dependency closure |
| `packages/photoshop/src/documents.ts` | Job-owned document stack, child save and inner-to-outer cleanup |
| `packages/photoshop/src/geometry.ts` | Pure fit calculations and numerical postconditions |
| `packages/photoshop/src/placement.ts` | Measured transforms and verified adjacency/clipping |
| `packages/photoshop/src/qualification.ts` | `qualify` request/result flow, prepared-copy checks, geometry and sentinel propagation |
| `packages/photoshop/src/export.ts` | Variant state, color/format/quality export and decode checks |
| `packages/photoshop/src/backend.ts` | `PhotoshopBackend` orchestration and public-boundary validation |
| `packages/photoshop/src/recovery.ts` | Ambiguous-state reconciliation without mutation replay |
| `tests/photoshop/fake-session.ts` | Stateful semantic Photoshop fake with deterministic fault injection |
| `tests/photoshop/fixture.ts` | Valid shared-fixture loaders and B-specific fake scene builders |
| `tests/photoshop/fixtures/` | Small synthetic scene, schema and transcript fixtures; no owner PSD committed |
| `docs/photoshop/tool-qualification.md` | Pinned upstream evidence and normalized operation semantics |
| `docs/photoshop/template-qualification.md` | Real document routes, dependencies, shape geometry and sentinel evidence |
| `docs/photoshop/live-acceptance.md` | macOS/Windows qualification protocol and actual results |
| `docs/photoshop/handoff.md` | Integration contracts, known blockers, selected backend, evidence locations |

All files in this table are created by their introducing task. No third-party Photoshop automation framework is reimplemented. Integration consumes only the public `PhotoshopBackend` interface.

## Internal operation contract

Define these B-internal shapes in B01 before any dependent task. They normalize observed tool responses, not Photoshop's entire object model:

```typescript
type DocumentId = string;
type LayerId = string;
type DocumentState = {
  id: DocumentId; path: string | null; parentId: DocumentId | null;
  width: number; height: number; dirty: boolean;
  sourceKind: 'root' | 'embedded' | 'linked' | 'unknown';
};
type LayerState = {
  id: LayerId; parentId: LayerId | null; name: string;
  kind: 'group' | 'smartObject' | 'pixel' | 'shape';
  bounds: Rect | null; visible: boolean; clipped: boolean;
  contentKey: string | null; children: LayerState[];
};
type ScalePlan = { percentX: number; percentY: number };
type Translation = { dx: number; dy: number };
type OperationKind =
  | 'listDocuments' | 'readDocument' | 'readLayers' | 'readLinkage'
  | 'openDocument' | 'activateDocument' | 'selectLayer' | 'openContents'
  | 'place' | 'replaceContents' | 'scale' | 'translate' | 'moveAbove'
  | 'setClipping' | 'setVisibility' | 'saveChild' | 'closeDiscard'
  | 'export' | 'convertProfile' | 'embedLink' | 'relink';
type CallRecord = {
  sequence: number; operation: OperationKind; requestId: string;
  documentId: string | null; layerId: string | null;
  state: 'issued' | 'acknowledged' | 'failedSafe' | 'unknown';
  startedAt: string; finishedAt: string | null; evidencePath: string;
};
```

Import `Rect`, `FitMode`, `LayerSelector` and public shapes from contracts; do not redeclare them. `OperationKind` is an allowlist. Each operation gets a strict discriminated request/result schema in `types.ts`, with only the fields its algorithm requires. `export`, `place` and file-mutating operations accept trusted resolved paths, never text extracted from an LLM response. `scale` explicitly distinguishes uniform from independently scaled axes; `translate` is normalized to delta pixels even if the upstream tool uses an absolute target.

The test fake exposes `calls`, `documents`, `mutations`, `seed(scene)`, `delay(operation, milliseconds)`, `failBefore(operation, error)`, `applyThenLoseReply(operation)`, `completePending()`, and `readScene()`. IDs are regenerated when opening a fresh copy. It models active-document changes, linked external-file writes, shared versus independent content, clipping adjacency, color profile and Photoshop place auto-scaling. An operation response must describe actual resulting state; the fake cannot just echo requested state.

## Batch 1 — contracts, primary tool reuse, locking and selectors

### Task B01: Build the fake-backed adapter boundary

**Files:** Create `packages/photoshop/src/types.ts`, `packages/photoshop/src/index.ts`, `tests/photoshop/fake-session.ts`, `tests/photoshop/fixture.ts`, `tests/photoshop/boundary.test.ts`, `tests/photoshop/fixtures/scenes.ts`.

- [ ] Write failing boundary cases using shared contract fixtures parsed by their Zod schemas. `requestFixture()` returns a structured clone of the valid render request; `sceneFixture()` returns the B synthetic scene with root canvas 1500 × 2000, a child canvas 3190 × 1418, reference bounds `{left:100,top:200,right:900,bottom:600}`, placed bounds `{left:20,top:30,right:220,bottom:430}`, exactly three sibling variant groups, and an unrelated user-owned document. The test bodies include:

```typescript
expect(() => parseRequest({ ...requestFixture(), stagingDirectory: '../escape' })).toThrow();
expect(sceneFixture().reference.bounds).toEqual({ left:100, top:200, right:900, bottom:600 });
const session = new FakeSession(sceneFixture());
const first = await session.openFreshCopy('attempt-1');
const second = await session.openFreshCopy('attempt-2');
expect(first.rootId).not.toBe(second.rootId);
expect(session.maximumInFlight).toBe(1);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/boundary.test.ts`. Expected first result: failure because B adapter/fake exports are absent, not because shared fixtures cannot parse. If the shared fixture fails, send the exact contract discrepancy to A before creating divergent fixture types.
- [ ] Implement the internal shapes above and the stateful fake. `parseRequest` uses the shared `RenderRequestSchema`, then trusted root/path confinement. Define `FakeSession.openFreshCopy(attemptId)` as a test-only clone operation returning `{rootId}`; assign monotonic session-local IDs and preserve independent/shared content identity separately. `maximumInFlight` measures overlapping calls, not array length. Every fault injection records whether it occurred before or after mutation. Keep these test methods out of the public backend interface.
- [ ] Rerun the B01 command and `npm run check`. Expected PASS; no Photoshop process or MCP child launched. Add a fake self-test proving `applyThenLoseReply('place')` changes layer state exactly once while returning no acknowledgement; later timeout tests depend on that realism.
- [ ] Commit only B paths with `git add packages/photoshop/src tests/photoshop` and `git commit -m "test(photoshop): define adapter boundary and stateful fake"`. Record the B01 test results and observer checkpoint.

### Task B02: Qualify and wrap existing MCP operations

**Files:** Create `packages/photoshop/src/mcp-client.ts`, `packages/photoshop/src/tool-map.ts`, `tests/photoshop/mcp-client.test.ts`, `tests/photoshop/fixtures/tool-schema.synthetic.json`, `docs/photoshop/tool-qualification.md`.

- [ ] Write failing transport tests for a synthetic `tools/list` response and a schema digest change. Use a fake SDK transport, not Photoshop. The fixture uses a test-only name `fixture_scale` and explicit arguments `{percent:number}`; it is visibly not a claimed upstream API. Assertions:

```typescript
expect(await client.listSchemaDigest()).toMatch(/^[0-9a-f]{64}$/);
await expect(client.callMapped('scale', { percentX:200, percentY:100 }))
  .rejects.toMatchObject({ code:'FIT_MODE_UNSUPPORTED' });
await expect(client.callRaw('photoshop_execute_script', { script:'alert(1)' }))
  .rejects.toMatchObject({ code:'TOOL_NOT_ALLOWLISTED' });
expect(transport.sentMutations).toHaveLength(0);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/mcp-client.test.ts`. Expected FAIL on absent mapping/validation behavior.
- [ ] Implement the SDK wrapper using the pinned Node executable and vendored server entry point in A's runtime lock; launch by executable plus argument array, without shell or runtime `npx`. Capture `tools/list`, canonicalize through contracts and bind its digest. For each normalized operation record: exact tool name, exact input/output schemas, source commit/file/line, unit conventions, active-document behavior, mutating flag, timeout and live proof. Report candidate names include `photoshop_edit_smart_object_contents`, `photoshop_place_image`, `photoshop_scale_layer`, `photoshop_move_layer`, `photoshop_move_layer_to_position`, `photoshop_create_clipping_mask`, `photoshop_set_layer_visibility`, `photoshop_save_document`, `photoshop_close_document`, `photoshop_export_as`, `photoshop_replace_smart_object_contents`, `photoshop_play_action`; **these are search leads, not verified mappings**. Do not mark capability supported from its name alone. Reject unknown schemas and error-shaped responses even when transport status is success.
- [ ] Rerun the B02 command. Expected PASS for synthetic schema pinning, unsupported independent-axis scale, arbitrary-script rejection, structured tool errors, invalid responses and trace redaction. A missing real operation is recorded as `capability`, with no generated script fallback. No upstream fetch/install occurs through this unit test.
- [ ] Commit B02 paths with `git add packages/photoshop/src/mcp-client.ts packages/photoshop/src/tool-map.ts tests/photoshop/mcp-client.test.ts tests/photoshop/fixtures/tool-schema.synthetic.json docs/photoshop/tool-qualification.md` and `git commit -m "feat(photoshop): wrap pinned MCP primitives with schema checks"`. Record the task verification results.

### Task B03: Serialize the whole Photoshop installation

**Files:** Create `packages/photoshop/src/session-lock.ts`, `tests/photoshop/session-lock.test.ts`; modify `packages/photoshop/src/mcp-client.ts`, `packages/photoshop/src/types.ts`.

- [ ] Write failing tests using temporary directories and two child Node processes. Installation identity is the canonical Photoshop executable path plus host identity, not job ID. Both processes target the same lock and only one acquires it. Add a dead-owner fixture whose previous operation is `unknown`; elapsed time must not release it. Add PID-reuse with mismatching process-start identity.

```typescript
expect(await contender.tryAcquire()).toEqual({ acquired:false, reason:'PHOTOSHOP_BUSY' });
expect(await staleUnknown.tryAcquire()).toEqual({ acquired:false, reason:'RECOVERY_REQUIRED' });
expect(fakeSession.maximumInFlight).toBe(1);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/session-lock.test.ts`. Expected FAIL before lock implementation. Use fake process identity probes in unit tests; real Windows/macOS process identity qualification belongs to B16.
- [ ] Implement atomic lock-directory acquisition in the application data directory selected by D. Persist host, installation digest, PID, process start identity, operation ownership ID, random ownership token and journal path before any Photoshop call. Render ownership uses its job ID; qualification allocates a qualification operation ID without inventing a render job. Heartbeat age alone is never permission to steal. Only matching ownership token can release; release requires no in-flight call, no unknown mutation and reconciled job-owned documents. MCP response timeout leaves the installation barrier held. All public backend methods acquire the same lock; there is one FIFO call queue inside it. Acquire at inspect/qualify/render transaction scope, not one lock per tool. Reject external controller coexistence during qualification; never attach two MCP backends to one session.
- [ ] Run the B03 command again. Expected PASS including concurrent contender, PID reuse, foreign host, malformed lock, cancellation while queued, and lock retention after process loss. Verify a ready operation does not overlap a late still-running mutation from a timed-out caller.
- [ ] Commit with `git add packages/photoshop/src/session-lock.ts packages/photoshop/src/mcp-client.ts packages/photoshop/src/types.ts tests/photoshop/session-lock.test.ts` and `git commit -m "feat(photoshop): enforce single installation session ownership"`. Record the task verification results.

### Task B04: Resolve qualified selectors into current document/layer IDs

**Files:** Create `packages/photoshop/src/selectors.ts`, `tests/photoshop/selectors.test.ts`; modify `tests/photoshop/fixtures/scenes.ts`.

- [ ] Write cases for duplicate sibling names, duplicate names under different groups, missing segments, changed layer kinds, changed document routes and reopened IDs. Use a canonical structural fingerprint of stable name/kind/tree-path/sibling structure and mask/type metadata captured at qualification; exclude current IDs, visibility, selected state and mutable input pixel data. Assert:

```typescript
expect(resolveLayer(sceneFixture().root, qualifiedVariantSelector()).name).toBe('1 картинка');
expect(() => resolveLayer(duplicateSiblingScene(), ambiguousSelector()))
  .toThrow('SELECTOR_AMBIGUOUS');
expect(resolveLayer(reopenedScene(), qualifiedVariantSelector()).id)
  .not.toBe(resolveLayer(sceneFixture().root, qualifiedVariantSelector()).id);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/selectors.test.ts`. Expected FAIL on missing strict resolver.
- [ ] Implement `resolveLayer(document, selector)` as document-route resolution followed by one sibling set at a time: select candidates matching name and kind; compare the qualified fingerprint; require exactly one; resolve its children for the next segment. The root target's full route resolves before opening any child. Opening a child verifies the actual parent/child relationship. Never use global first-name match or saved PSD record IDs. If upstream only selects by name, prove that the prepared template uses globally unique technical names in that active document; otherwise return `TARGET_SELECTION_UNSUPPORTED` and qualify an ID-safe existing operation/backend. Identical duplicates require preparation/requalification, not ordinal guessing.
- [ ] Rerun B04 and B01 tests. Expected PASS; replacing input content or changing variant visibility does not invalidate structural selectors, while layer moves/kind changes do. Normalize Unicode only for transport/path comparison rules established by contracts; preserve exact Photoshop layer names for lookup.
- [ ] Commit with `git add packages/photoshop/src/selectors.ts tests/photoshop/selectors.test.ts tests/photoshop/fixtures/scenes.ts` and `git commit -m "feat(photoshop): resolve structural selectors per working instance"`. Record the task verification results.

## Batch 2 — inspection, isolation, document lifecycle and fit mathematics

### Task B05: Build live inspection with honest bounds and linkage evidence

**Files:** Create `packages/photoshop/src/inspection.ts`, `tests/photoshop/inspection.test.ts`, `docs/photoshop/template-qualification.md`; modify `packages/photoshop/src/types.ts`, `tests/photoshop/fixtures/scenes.ts`.

- [ ] Write a scene where the root raw target bounds differ from its child canvas, the reference shape's raw raster bounds are zero, and live effective bounds are `{left:100,top:200,right:900,bottom:600}`. A second scene has unknown linkage. Assert that the first report contains live effective bounds with evidence, and the second cannot become a qualified profile. Verify unknown bounds are `null`, never `{0,0,3190,1418}`.
- [ ] Run `npm run test:photoshop -- tests/photoshop/inspection.test.ts`. Expected FAIL until inspection normalizes actual observations.
- [ ] Implement inspection under the installation lock: hash/copy the master for inspection, snapshot pre-existing documents, read the root tree, traverse selected Smart Object routes, record current document IDs only in trace, and create stable document keys plus qualified **candidate** selectors. Use existing DOM/tool-reported effective bounds in pixel units; read mask/vector metadata and distinguish bounds with/without layer effects in evidence. A shape with unknown effective bounds is unqualified and has `bounds:null`. Read linkage before opening potentially linked children. Use `sourceKind:'unknown'` where linkage is unproven; record it in `unresolvedLinks` and evidence, do not invent a parent-child edge, and block qualification. Static inspection reports have `evidenceStatus:'staticCandidate'` and `capabilities:null`; live reports have `evidenceStatus:'liveObserved'` and an actual `CapabilityReport`. Neither status alone implies qualification. Record parent/child/save behavior and observed ancestor/group states. Close only newly opened inspection documents without save.
- [ ] Rerun the B05 command. Expected PASS for nested child graph, zero vector raster bounds, missing resource, duplicate selector, user-open document preservation and unknown linkage. Save report snapshots as candidates; no `qualificationId` is manufactured. Add a flow assertion that this report and C's validated proposal can form a `QualificationRequest` without any `TemplateProfile`; static-only or unresolved-link requests must later produce a blocked result instead of reaching `render`.
- [ ] Commit with `git add packages/photoshop/src/inspection.ts packages/photoshop/src/types.ts tests/photoshop/inspection.test.ts tests/photoshop/fixtures/scenes.ts docs/photoshop/template-qualification.md` and `git commit -m "feat(photoshop): inspect candidate routes bounds and dependency links"`. Record the task verification results.

### Task B06: Isolate the complete working dependency set

**Files:** Create `packages/photoshop/src/working-copy.ts`, `tests/photoshop/working-copy.test.ts`; modify `docs/photoshop/template-qualification.md`.

- [ ] Write filesystem tests with a PSD placeholder and two nested linked dependencies outside the working directory. Include duplicate basenames from different directories, a symlink escape, a missing link and a changed hash. Assert no Photoshop `saveChild` can be issued until every mutable dependency resolves into the attempt working root or is embedded in the prepared copy.

```typescript
expect(await isolation.assertWritableTarget(originalLinkedPath))
  .toEqual({ allowed:false, code:'LINKED_SOURCE_UNISOLATED' });
expect(await sha256(masterPath)).toBe(originalMasterHash);
expect(await sha256(originalLinkedPath)).toBe(originalLinkHash);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/working-copy.test.ts`. Expected FAIL before closure enforcement.
- [ ] Implement `createWorkingCopy`: verify the incoming master/source hashes and trusted roots; create an exclusive fresh working directory per asset attempt; copy the master. Prefer a prepared, verified self-contained template with embedded resources. Otherwise recursively enumerate all linked dependencies, resolve/canonicalize them, copy with content-addressed collision-safe names, relink only job-owned parents using a qualified existing tool, then re-read the closure and reject any edge outside the work root. Detect cycles with visited resource identity; cycles are blocked unless the backend's proven behavior safely supports them. Unknown/missing linkage or unavailable embed/relink primitives is `LINKED_SOURCE_UNISOLATED`, not a permission to save. Snapshot original dependency hashes for post-run verification. Do not hard-link mutable files or copy only the outer PSD.
- [ ] Rerun B06. Expected PASS for complete nested isolation and all rejection cases. Test UTF-8 names and Windows-style roots through the path utility A supplies; no literal `/Users/...` path enters a portable profile. Master and external-link hashes remain unchanged after a fake child save.
- [ ] Commit with `git add packages/photoshop/src/working-copy.ts tests/photoshop/working-copy.test.ts docs/photoshop/template-qualification.md` and `git commit -m "feat(photoshop): isolate master and linked resource closure"`. Record the task verification results.

### Task B07: Track PSB open/save/close as a document stack

**Files:** Create `packages/photoshop/src/documents.ts`, `tests/photoshop/documents.test.ts`; modify `packages/photoshop/src/types.ts`.

- [ ] Write a root → child PSB → nested PSB fake and an unrelated dirty user document. Test successful save propagation, failed child open, failed save, unexpected active-document changes and reuse of a pre-opened child. Assertions:

```typescript
expect(trace.operations()).toEqual([
  'openDocument','openContents','openContents',
  'saveChild','closeDiscard','saveChild','closeDiscard','closeDiscard'
]);
expect(session.userDocument.dirty).toBe(true);
expect(session.userDocument.closed).toBe(false);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/documents.test.ts`. Expected FAIL on absent owned-document stack.
- [ ] Implement an ownership ledger keyed by actual document ID and process/session identity. After each open, compare before/after document lists, active ID, path, route and parent; require the newly opened job-owned document expected by the request. A reused user document is not owned and must not be saved or closed. Before each mutation assert intended active document and layer. Save the deepest dirty child exactly once, wait for acknowledged save/parent update, then close it without a second save prompt; continue outward. On success discard the outer working root after exports; never save it over the original. Cleanup closes owned documents in reverse depth only after idle certainty. A save timeout is ambiguous and does not trigger another save/close call.
- [ ] Rerun B07. Expected PASS: nested saves update only job copies, user documents remain open/dirty, unsupported non-PSB contents produce a precise capability error, and foreign document activation pauses without closing foreign state. Record explicit ownership proofs and every transition in `document-trace.jsonl`.
- [ ] Commit with `git add packages/photoshop/src/documents.ts packages/photoshop/src/types.ts tests/photoshop/documents.test.ts` and `git commit -m "feat(photoshop): own nested document lifecycle and safe child saves"`. Record the task verification results.

### Task B08: Implement pure cover, contain and stretch calculations

**Files:** Create `packages/photoshop/src/geometry.ts`, `tests/photoshop/geometry.test.ts`.

- [ ] Write table tests for non-origin reference bounds, negative coordinates, fractional coordinates, portrait/landscape/square, one-pixel dimensions and invalid/zero/non-finite bounds. The same asset pixels can have different post-placement size because Photoshop auto-scales; tests pass the measured placed rectangle, not source file dimensions.

```typescript
const reference = { left:100, top:200, right:900, bottom:600 };
const placed = { left:20, top:30, right:220, bottom:430 };
expect(scaleFor(reference, placed, 'cover')).toEqual({ percentX:400, percentY:400 });
expect(scaleFor(reference, placed, 'contain')).toEqual({ percentX:100, percentY:100 });
expect(scaleFor(reference, placed, 'stretch')).toEqual({ percentX:400, percentY:100 });
expect(centerTranslation(reference, {left:-280,top:-570,right:520,bottom:1030}))
  .toEqual({ dx:380, dy:170 });
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/geometry.test.ts`. Expected FAIL until pure functions exist.
- [ ] Implement these exact algorithms, without tool calls:

```text
rw = reference.right - reference.left; rh = reference.bottom - reference.top
pw = measuredPlaced.right - measuredPlaced.left; ph = measuredPlaced.bottom - measuredPlaced.top
require each dimension finite and > 0
cover: s = max(rw/pw, rh/ph); percentX = percentY = 100*s
contain: s = min(rw/pw, rh/ph); percentX = percentY = 100*s
stretch: percentX = 100*rw/pw; percentY = 100*rh/ph
After scale is acknowledged and measured again:
dx = (reference.left + reference.right - afterScale.left - afterScale.right)/2
dy = (reference.top + reference.bottom - afterScale.top - afterScale.bottom)/2
```

`scaleFor(reference, placed, mode)` returns `ScalePlan`; `centerTranslation(reference, afterScale)` returns `Translation`; `checkFit(reference, finalPlaced, originalPlaced, mode, tolerancePx)` returns named check results. Uniform modes preserve aspect ratio within measured pixel tolerance, cover contains the reference rectangle, contain lies within it, stretch matches all four edges. All modes center within tolerance. Initial acceptance tolerance is 0.5 Photoshop pixel per edge/center, confirmed or tightened during live qualification; do not loosen it silently after failures. Do not round intermediate values to integer pixels.
- [ ] Rerun B08. Expected PASS for the table and generated positive rectangles using a fixed random seed. Add a contrasting source size 12000 × 8000 with post-place 600 × 400: a reference 300 × 200 must yield 50%, proving file-resolution scaling is not used.
- [ ] Commit with `git add packages/photoshop/src/geometry.ts tests/photoshop/geometry.test.ts` and `git commit -m "feat(photoshop): calculate measured layer fit for all three modes"`. Record the task verification results.

## Batch 3 — measured placement, template reuse, variants and render transaction

### Task B09: Execute measured transforms without duplicate effects

**Files:** Create `packages/photoshop/src/placement.ts`, `tests/photoshop/placement.test.ts`; modify `packages/photoshop/src/tool-map.ts`.

- [ ] Write one test where place auto-scales a 12000 × 8000 input to 600 × 400 and a 300 × 200 reference therefore needs 50% scaling. Write a second using B08's 200 × 400 placed rectangle, 800 × 400 reference and 400% cover: fake measurements after scale are `{left:-279.75,top:-569.75,right:520.25,bottom:1030.25}`. Translation upstream accepts absolute coordinates. Verify normalization and remeasurement, not assumed anchor math. Add a scale that applies then loses its reply; the trace must contain exactly one scale. For the second test:

```typescript
expect(session.callsFor('readLayers').length).toBeGreaterThanOrEqual(3);
expect(session.callsFor('scale')).toHaveLength(1);
expect(session.callsFor('translate')[0].normalized).toEqual({ dx:379.75, dy:169.75 });
expect(checks.every(check => check.passed)).toBe(true);
```

- [ ] Run `npm run test:photoshop -- tests/photoshop/placement.test.ts`. Expected FAIL before measured placement.
- [ ] Implement `placeAndFit`: resolve reference and read effective bounds; select/place or replace the approved input; read actual resulting layer ID and bounds; validate nonempty bounds; calculate scale via B08; issue exactly one acknowledged transform; read bounds again; compute center delta from **actual** after-scale bounds; normalize that delta to the qualified tool's input semantics; translate; re-read bounds and validate. A bounded correction is allowed only for an acknowledged operation with a measured residual and a documented rounding cause: one additional translation, followed by validation. Unknown acknowledgement, unexplained size error or required second scale blocks/restarts the asset from a fresh copy through A. Never resend the original relative scale/translation after a timeout.
- [ ] Rerun B09. Expected PASS for all modes when supported, no call for unsupported stretch, unexpected layer/document response, extreme source resolution, fractional and negative coordinates, and exactly-once effects. `fitMode` is unchanged from profile in every evidence row.
- [ ] Commit with `git add packages/photoshop/src/placement.ts packages/photoshop/src/tool-map.ts tests/photoshop/placement.test.ts` and `git commit -m "feat(photoshop): fit actual placed bounds with verified transforms"`. Record the task verification results.

### Task B10: Reuse saved clipping and prove shared-object propagation

**Files:** Create `packages/photoshop/src/qualification.ts`, `tests/photoshop/qualification.test.ts`, `tests/photoshop/clipping.test.ts`; modify `packages/photoshop/src/placement.ts`, `docs/photoshop/template-qualification.md`.

- [ ] Write tests for a prepared input directly above its reference, a pixel input requiring one-time preparation, an intervening layer, a wrong clipping base, vector-mask holes, two shared instances and two independent instances. A retained clipping relation must not be toggled a second time. A shared resource is updated once; independently sourced targets are each updated.

```typescript
expect(await ensureClipping(preparedSession)).toEqual({ clipped:true, adjacentToReference:true });
expect(preparedSession.callsFor('setClipping')).toHaveLength(0);
expect(sharedSession.contentWrites('shared-A')).toBe(1);
expect(independentSession.contentWrites('independent-B')).toBe(1);
```

Add public-boundary flow tests using shared live inspection plus a proposal whose candidate IDs resolve in that inspection. Build `QualificationRequest` with those two objects and test-owned absolute `workingTemplatePath`/`evidenceDirectory`; do not pass a `TemplateProfile`. The successful fake scene verifies all mandatory geometry/linkage/sentinel checks and returns `status:'qualified'`, a candidate without `qualificationId`/`profileSha256`, and relative evidence paths. In the prepared-copy case, `result.candidate.template.sha256` matches the newly saved prepared file, differs from the master and its selectors match that new file. Unknown linkage, failed sentinel propagation, unsupported fit or a missing proposal candidate returns `status:'blocked'`, `candidate:null` and explicit errors. Spy on render and require zero calls during every qualification test; only A's subsequent sealing step enables render.

- [ ] Run `npm run test:photoshop -- tests/photoshop/clipping.test.ts tests/photoshop/qualification.test.ts`. Expected FAIL before prepared-template and propagation qualification.
- [ ] Implement `qualify(request, signal)` in `qualification.ts`: validate the shared request schema, matching inspection/proposal IDs, complete proposal, allowed candidate references, live capability evidence and trusted copy/evidence roots; acquire B's existing installation lock; isolate the complete dependency closure; open only the owned qualification copy; resolve routes; run measured fit, prepared clipping and sentinel checks; save/reopen any prepared copy; recompute its hash/selectors; verify original/dependency hashes; clean up owned documents; return a strict `QualificationResult`. All successful mandatory checks plus a validated `TemplateCandidate` are required for `qualified`; otherwise return blocked with no candidate. Reuse B06–B09 lower-level operations and B11's exporter when available; B10 fake tests inject the exporter, so qualification does not call `render` or require its profile precondition. Preserve the lock/recovery barrier on uncertain mutations. Do not assign profile seal fields.

Implement `ensureClipping`: inspect current sibling order/base; move the placed input immediately above the intended reference through a qualified primitive when needed; reread; if already clipped to that reference, do nothing; otherwise use the qualified set operation or fixed allowlisted Action only after asserting its precondition; reread clipped/base/adjacency. Preserve the reference's real alpha/vector mask, including holes; rectangular cropping is not a substitute. An existing clipped pixel `Слой 4` is not passed to Smart Object replace. Prepare a **separate copy** by converting/replacing its upper input once through existing tools or operator-recorded preparation, preserve the base/mask/effects, assign unique technical names where necessary, save and reopen, then requalify new SHA-256 and structural selectors. No preparation operation writes the supplied master.

Qualification uses a distinctive asymmetric sentinel with four colored corners, center cross and transparency; generate it with the pinned image library. Open target through the actual route, update one content resource and save its PSB; switch/export all three variants. Compare the corresponding target regions against baseline and inspect the visible sentinel orientation/coverage. Record actual content resource identity and affected instances. Matching names/bounds is not evidence. If all required instances do not change, enumerate independent targets and repeat deliberately; a mixture of shared/independent resources becomes explicit target routes plus qualified content-equivalence metadata. Deduplicate writes only on proven shared identity, never names. Outer layer transforms/effects remain in place.
- [ ] Rerun B10. Expected PASS: alpha holes remain transparent, input is adjacent to the correct base, no repeated clipping toggle, no new layer accumulation, shared target edited once, independent targets all edited, sentinel must affect each required variant. Store pre/post documents and exported sentinel samples in qualification evidence; static metadata alone cannot pass this task's live gate.
- [ ] Commit with `git add packages/photoshop/src/qualification.ts packages/photoshop/src/placement.ts tests/photoshop/qualification.test.ts tests/photoshop/clipping.test.ts docs/photoshop/template-qualification.md` and `git commit -m "feat(photoshop): qualify prepared clipping and shared content updates"`. Record the task verification results.

### Task B11: Export exactly three verified variant/color states

**Files:** Create `packages/photoshop/src/export.ts`, `tests/photoshop/export.test.ts`; modify `packages/photoshop/src/tool-map.ts`, `docs/photoshop/tool-qualification.md`.

- [ ] Write tests with all three variant groups initially visible, hidden ancestor groups, one export failure, JPEG quality-unit mismatch, wrong ICC profile, wrong dimensions and truncated output. Use Sharp-created synthetic images in temporary directories, not empty fixture files. Assert visibility evidence is exactly `['1']`, `['2']`, `['3']` at each corresponding export and outputs are all under the attempt bundle.
- [ ] Run `npm run test:photoshop -- tests/photoshop/export.test.ts`. Expected FAIL before variant exporter.
- [ ] Implement `exportVariants` sequentially for profile IDs 1,2,3: restore the qualified common/ancestor state; hide all three variant groups, show only the selected one; reread effective ancestor and variant visibility and fail if exactly one is not satisfied. Apply the qualified export policy to a disposable job-owned document/duplicate when conversion or resizing changes document state. Convert to sRGB through a proven existing export setting/Action/tool, **not assign an sRGB label to unchanged pixels**. Qualify rendering intent, embedded ICC profile, RGB/8 conversion, target dimensions and JPEG flatten/background behavior using prepared template/background policy; PNG preserves intended alpha. Export into unique paths in the attempt directory. Map quality 1..100 to the backend's actual units using pinned source/live evidence, e.g. use identity only if the schema really is 1..100; test 1, 50, 100. Do not invent a 0..12 conversion from a tool name. PNG ignores quality as the shared contract says.

After each file acknowledgement, decode with Sharp and check format, width/height, readable pixels, positive bytes, expected color profile and alpha/background policy; compute SHA-256. `VariantArtifact.path` and all evidence paths are relative to the bundle root. Reject symlink/traversal/outside-root results. Write visibility evidence before export; tool success alone never passes a color or visibility check. Leave partial exports in uncommitted attempt staging on failure.
- [ ] Rerun B11. Expected PASS for both JPEG and PNG, all three IDs, common layers retained, color and size errors rejected, correct quality mapping, no duplicate output names and no result containing an absolute machine path. A unsupported sRGB conversion/export dimension policy is a capability failure.
- [ ] Commit with `git add packages/photoshop/src/export.ts packages/photoshop/src/tool-map.ts tests/photoshop/export.test.ts docs/photoshop/tool-qualification.md` and `git commit -m "feat(photoshop): verify three variant exports and sRGB policy"`. Record the task verification results.

### Task B12: Compose one asset transaction behind PhotoshopBackend

**Files:** Create `packages/photoshop/src/backend.ts`, `tests/photoshop/backend.test.ts`; modify `packages/photoshop/src/index.ts`, `docs/photoshop/handoff.md`.

- [ ] Write a full fake-backed `render(request, signal)` test for one asset and three variants, then a second asset. Assert the first working document is discarded before opening a clean second copy, no inserted layers accumulate, source/master/dependency hashes remain unchanged, and three artifact entries pass the shared evidence schema. Inject a failure in variant 2 and assert no successful RenderEvidence is returned.
- [ ] Run `npm run test:photoshop -- tests/photoshop/backend.test.ts`. Expected FAIL before orchestration.
- [ ] Implement the exact order:

```text
validate RenderRequest and profile qualification/hash/tool-schema binding
acquire installation lock; record pre-existing documents
verify source/template and create fresh isolated working dependency set
open owned root copy; verify graph/selectors against qualification
for each proven distinct content resource:
  resolve target route; open child stack; resolve reference and input
  replace/place → measure → fit → measure → verify adjacency/clipping
  save and close each child inside-out, with acknowledgements
activate root; verify required shared-instance propagation observations
for variant 1, 2, 3: set/read visibility → export → decode/hash/check
verify original file/dependency hashes; discard root and owned auxiliaries
write relative traces/checks and strict RenderEvidence; release safe lock
return evidence to A for per-asset fresh review and atomic publication
```

`capabilities`, `inspect`, `qualify`, `render`, `recover` return only shared validated shapes. Wire `PhotoshopBackend.qualify` directly to B10's qualifier with the same lock, operations and exporter, without wrapping it in render. Add a backend test covering live inspection → valid proposal → qualification result → externally supplied A-sealed profile → render; assert render rejects the unsealed candidate. Errors are `DomainError` with stable codes and evidence paths. B performs no retry loop and no SQLite state transition; `attempt` is A's authority. A retries only after B proves cleanup safe and opens another copy. B does not publish, mark an asset complete, call a model, switch backend or consume another asset internally.
- [ ] Rerun B12 plus `npm run test:photoshop` and `npm run check`. Expected PASS for the owned fake suite. Verify each `RenderEvidence.geometry` row uses final pre-clipping measured placement bounds plus clipped/adjacency checks; traces retain all earlier measurements. Verify every referenced relative file exists and is hashable by A's evidence-bundle builder.
- [ ] Commit with `git add packages/photoshop/src/backend.ts packages/photoshop/src/index.ts tests/photoshop/backend.test.ts docs/photoshop/handoff.md` and `git commit -m "feat(photoshop): compose isolated asset render transactions"`. Record the task verification results.

## Batch 4 — recovery, acceptance and Windows handoff

### Task B13: Make timeouts and cancellation conservative

**Files:** Create `packages/photoshop/src/recovery.ts`, `tests/photoshop/recovery.test.ts`; modify `packages/photoshop/src/mcp-client.ts`, `packages/photoshop/src/backend.ts`, `packages/photoshop/src/session-lock.ts`.

- [ ] Write fault tests for lose-reply after place, scale, save-child, export and close; abort during queue wait versus after dispatch; transport death; Photoshop process loss; delayed response after timeout; new foreign document. For every mutation timeout assert exactly one issued mutation and no competing operation while uncertainty persists. Add recovery that sees an owned child still dirty and refuses to claim safe.
- [ ] Run `npm run test:photoshop -- tests/photoshop/recovery.test.ts`. Expected FAIL before the ambiguous-state barrier.
- [ ] Implement an append-only operation journal flushed before dispatch and after acknowledgement. Initial operation ceilings are 15 seconds for metadata reads, 120 seconds for open/place/replace and 180 seconds for save/export; these are failure-detection ceilings, not throughput promises, and live qualification records measured p95 and approved changes. A timer/AbortSignal ending the caller does not imply Photoshop cancelled. Before-dispatch cancellation is safe; after-dispatch mutation timeout becomes `category:'ambiguousState'`, `retryable:false`, with lock retained. No blind retries, close calls or alternate backend while a previous call may execute. Prefer waiting for the matching late acknowledgement and verifying idle/document state through a qualified safe completion/status mechanism. If transport/process death prevents certainty, persist recovery-required state and require the documented operator reconciliation; PID death alone is insufficient proof Photoshop is idle.

`recover(jobId, signal)` reads the journal and lock, verifies host/installation/ownership, establishes idle certainty, inventories actual documents and compares to the ownership ledger. It never replays a mutation. Close/discard only proven-owned work documents in reverse depth after idle certainty, verify original hashes, preserve staged evidence and return `{safe:true,evidencePaths}` only after all invariants hold. Otherwise return safe false with exact outstanding uncertainty. Unknown completion of export does not authorize re-export into the same filename; A can preserve/review a fully valid stage or start a new attempt after safe cleanup.
- [ ] Rerun B13. Expected PASS for every injected phase, including no duplicate scale/save/export effects, lock retained through late operations, safe queued cancel, safe cleanup after acknowledged completion and foreign documents preserved. Timed-out read operations also cannot overlap a potentially busy server; only known completed safe reads may be retried under qualification policy.
- [ ] Commit with `git add packages/photoshop/src/recovery.ts packages/photoshop/src/mcp-client.ts packages/photoshop/src/backend.ts packages/photoshop/src/session-lock.ts tests/photoshop/recovery.test.ts` and `git commit -m "fix(photoshop): recover ambiguous operations without replay"`. Record the task verification results.

### Task B14: Run conformance and failure corpus without Photoshop

**Files:** Create `tests/photoshop/conformance.test.ts`, `tests/photoshop/fixtures/conformance-cases.json`; modify `docs/photoshop/handoff.md`.

- [ ] Encode a data-driven acceptance corpus: cover/contain/stretch × portrait/landscape/square × JPEG/PNG; 500 × 500, 5000 × 5000, 12000 × 8000 and 800 × 1200 source metadata; transparent input; non-origin reference; vector mask with hole; zero/unknown effective bounds; shared and independent objects; duplicate layer names; linked dependencies; Cyrillic filenames; spaces; Windows reserved/case-only filenames handled by A; corrupt input; wrong color; schema drift; cancellation and lost replies at each mutation boundary. Use `assetId` and trusted staging names from core, never source basename as identity.
- [ ] Run `npm run test:photoshop -- tests/photoshop/conformance.test.ts`. Expected initial failure where corpus exposes a missing invariant; do not delete a failing mandatory case or weaken bounds/color thresholds to make it pass.
- [ ] Implement only fixes required by the corpus, in the responsible B module. Assert `n` fake assets produce `3*n` validated staged artifacts, at most one Photoshop operation is in flight, every failed asset has a typed error and owned documents do not leak. A's 10000-asset fake endurance belongs to integration; B supplies an inexpensive deterministic backend and per-phase timings rather than allocating full 396 MiB owner PSD copies in fake tests.
- [ ] Run `npm run test:photoshop` and `npm run check`. Expected PASS. Save actual output and test-seed/version in B14 evidence. Mark live Photoshop, image appearance, real memory and Windows results as untested; fake success is not a production claim.
- [ ] Commit with `git add packages/photoshop/src tests/photoshop/conformance.test.ts tests/photoshop/fixtures/conformance-cases.json docs/photoshop/handoff.md` and `git commit -m "test(photoshop): cover geometry linkage and recovery conformance"`. Record the task verification results.

### Task B15: Qualify the real primary backend and explicit alternate gate

**Files:** Create `tests/photoshop/live.test.ts`, `docs/photoshop/live-acceptance.md`; modify `docs/photoshop/tool-qualification.md`, `docs/photoshop/template-qualification.md`, `docs/photoshop/handoff.md`.

- [ ] Add an explicitly invoked live test controlled by a local `docs/photoshop/live-machine.json` configuration file, excluded from Git by A. Without that file, `npm run test:photoshop -- tests/photoshop/live.test.ts` reports a named blocked/skip reason and produces no Photoshop calls. The local configuration contains selected installation, trusted source/work/evidence roots and selected backend ID; it never stores passwords. On the current Mac the source may resolve to `/Users/tsunanory/Downloads/мокап_готово.psd`; Windows selects its own path. Do not copy the 396 MiB file into the repository.
- [ ] Record the pinned alisaitteke source/package digest, actual LICENSE text, supported installation/runtime and exact schemas. Run the bounded live sequence only on isolated copies: inspect route → verify source kind/dependencies → prove vector effective bounds → prepare retained input/clipping if necessary → sentinel propagation → one asset in each fit mode → each variant JPEG/PNG color/export probe → normal cleanup → original hash checks. Record Photoshop version, OS, permissions/dialog behavior, tool trace, geometry, contact sheets and observed quality mapping. Live tests do not edit arbitrary user documents or dismiss unknown dialogs automatically.
- [ ] Apply this capability decision table, preserving full requirements:

| Evidence | Required decision |
|---|---|
| Primary has qualified ID-safe selection, live bounds, child lifecycle, all fits, clipping and export | Keep alisaitteke only; pin mapping and capability report |
| Primary lacks non-uniform X/Y transform but a specific existing Action safely supports dynamic required values | Qualify that Action's name/set/digest, preconditions and all corpus cases; never assume a recorded fixed scale supports arbitrary assets |
| Any mandatory primary operation remains unavailable | Record exact failed capability; qualify `dcc-mcp/dcc-mcp-photoshop` as an explicit alternate in an isolated session with primary disconnected |
| DCC existing tools or static allowlisted `batch_play` descriptor composition supplies the operation | Implement a separately selected adapter mapping using the same state machine, lock and conformance tests; no LLM-generated descriptors or new JSX/UXP plugin baseline |
| Neither existing route satisfies a requirement | Full release is blocked with the concrete evidence; do not silently omit the requirement or write a new Photoshop scripting framework |

If alternate code is required, create `packages/photoshop/src/dcc-tool-map.ts` and `tests/photoshop/dcc-tool-map.test.ts`, register it through `tool-map.ts`, and record source/license/schema digest exactly as for primary. Run `npm run test:photoshop -- tests/photoshop/dcc-tool-map.test.ts tests/photoshop/conformance.test.ts`, then the live corpus. Changing backend invalidates template qualification; close/reconcile primary, release its safe lock, and select DCC explicitly. Never start both against Photoshop.

- [ ] Re-run `npm run test:photoshop -- tests/photoshop/live.test.ts` on the qualified machine. Expected actual PASS only after every mandatory primitive is proven; otherwise record blocked capability and keep fake results separate. Optional Joonas acceleration remains off: before copying, executing, embedding or redistributing its source, record exact source commit, license or specific permission and behavior qualification. Absence of LICENSE is not permission, including local use. If authorized and later selected, it must preserve per-asset isolation, three exports, evidence, timeout/recovery and review gates; its hooks cannot execute arbitrary generated scripts. No Joonas dependency is needed to finish this baseline.
- [ ] Commit B15 code/documentation with `git add tests/photoshop docs/photoshop packages/photoshop/src` and `git commit -m "test(photoshop): qualify live backend template and full fit support"`. Record the task verification results. Record blocked live gates honestly rather than marking the task complete from fake tests.

### Task B16: Windows qualification and integration handoff

**Files:** Create `tests/photoshop/windows-paths.test.ts`; modify `docs/photoshop/live-acceptance.md`, `docs/photoshop/handoff.md`, `docs/photoshop/tool-qualification.md`.

- [ ] Add Windows path/case/Unicode fixtures and run `npm run test:photoshop -- tests/photoshop/windows-paths.test.ts`. Expected first failure for any unsupported normalization/transport boundary. Use A's canonical-root implementation; B must not create a competing portable-path format. Include `C:\\NE PSD\\шаблоны\\мокап_готово.psd`, a long asset path under an approved root, case-only input basenames and a dependency path on another volume. These are test inputs, not default production paths.
- [ ] With D's packaged runtime on Windows 11 x64, run `npm run test:photoshop` in the pinned developer checkout and the packaged-app live backend diagnostics. Verify bundled Node launches the pinned MCP offline; application user permissions and Photoshop automation access work without an installed npm; only one installed app instance controls Photoshop. Repeat B15's live qualification on Windows, including all three fit modes, real vector bounds, all three variants, color/profile output, original/dependency hashes, user-open documents, cancellation and recovery. macOS qualification does not pre-approve Windows.
- [ ] Execute a 100-asset real corpus through A's integrated job coordinator with B's phase timing traces and C's per-asset fresh review. Record per-phase median/p95, peak Photoshop/system RAM, temporary disk growth, source/output counts and cleanup; do not claim a throughput rate before measuring. A owns the transaction/publish/resume evidence and 10000-asset fake endurance. D owns installer/upgrade/uninstall. Test B's contribution to a crash after export, timeout during child save and app restart with retained lock; publication cannot occur until A/C's checks/review pass.
- [ ] Record the handoff with exact baseline/final commits, selected backend version/source/tool-schema digest, supported modes, template hash/qualification ID, prepared-template location, dependency manifest, Windows/macOS evidence paths, exact commands/results, operation ceilings, recovery procedure and unresolved blockers. Required final invariants: 3 valid staged artifacts per asset; all modes supported; clipping/geometry correct; shared/independent instances updated; originals unchanged; no user document touched; no duplicate effects; no competing controller; relative evidence paths; no publish/review bypass. Send A every dependency request rather than editing root lockfiles.
- [ ] Commit with `git add tests/photoshop/windows-paths.test.ts docs/photoshop` and `git commit -m "docs(photoshop): record Windows qualification and integration handoff"`. Record the task verification results. Full release remains blocked until the Windows live, integration and review gates actually pass.

## Self-review and completion checklist

- [ ] Coverage: B02 primary reuse/pinning; B03 lock; B04 selectors; B05 actual shape/layer geometry; B06 linked-source safety; B07 nested PSB lifecycle; B08/B09 all fits/post-place measurements; B10 saved clipping and shared propagation; B11 three variants/color exports; B12 transaction boundary; B13 uncertain timeouts/no replay; B14 fake corpus; B15 real template/alternate/license gates; B16 Windows/handoff.
- [ ] Run `rg -n 'T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details' docs/superpowers/plans/2026-09-21-ne-psd/02-photoshop.md`. Expected no matches. Named fixtures and test helpers must be introduced before use, production shapes must remain aligned with contracts, and synthetic schemas must never be described as actual upstream evidence.
- [ ] Every completed implementation task records actual test outputs. Every production asset receives its own fresh runtime review in A/C before publication. Development tests do not substitute for runtime image review.
- [ ] No `.jsx`/`.uxp` source added, no arbitrary script executor in the allowlist, no copied unlicensed Joonas source, no model-selected mutations and no fallback model/backend. New adapter code is limited to deterministic coordination, geometry, safety and evidence around reused primitives.
