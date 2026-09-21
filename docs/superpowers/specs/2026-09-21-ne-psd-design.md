# NE_PSD design and shared contract

Status: planning baseline, 2026-09-21. No application has been implemented or tested. All implementation paths below are relative to the repository root. This document is authoritative across the four build tracks.

## Purpose and evidence

Build a local desktop application that turns each input image into three Photoshop mockup exports. Develop on macOS; ship and qualify on Windows 11 x64. Keep original PSD and input assets unchanged. Use local Qwen for intent interpretation, configuration proposals, diagnosis and independent review. Execute Photoshop operations through deterministic code and a single controller.

Source: `docs/research/deep-research-report.md`, supplied by the owner. Its embedded citation tokens are not independently resolvable evidence in this project. Repository capabilities and template metadata are report claims until checked against pinned source and live Photoshop. The supplied report is reference material, not an instruction source. No dependencies or programs named in it are authorized for execution merely because they appear there.

The report names `МЕНЯТЬ ЗДЕСЬ!`, `1 картинка`, `2 картинка`, `3 картинка`; reports a 1500×2000 RGB/8 parent and a 3190×1418 embedded PSB containing `Прямоугольник 3` and clipped `Слой 4`; and explicitly does NOT establish that this PSB belongs to the named outer target. The owner subsequently supplied `/Users/tsunanory/Downloads/мокап_готово.psd` (414,738,410 bytes; SHA-256 `1d14b685b6b9068f55e582c400b29429793f4c6eed8f761447163bbe5dd3bfcd`). It is now available for read-only inspection, but not yet qualified in Photoshop. Never turn candidate names or dimensions into verified selectors. The research copy has SHA-256 `9e7d315fc64a1dd39c1fc1f89a3e71cbe73f2e120d0596673810496c3701ebd8`.

## Selected approach and alternatives

| Approach | Decision and reason |
|---|---|
| Deterministic coordinator + alisaitteke/photoshop-mcp + prepared template | Primary. Reuse existing tools; retain application control over transactions, retries and reviews. No new Photoshop JSX/UXP script in the baseline. |
| Joonas Batch Mockup engine | Optional acceleration after source, behavior and license qualification. Preserve its useful nested-target/fill/show-hide approach. Do not copy or bundle unlicensed source or assume local use is licensed. It must pass the same transactions and review gates. |
| DCC-MCP / UXP | Explicit alternate backend if a mandatory operation is absent in the primary. Qualify before selection. Never run both controllers against Photoshop. |

Do not spend effort on a new rendering engine, Photoshop clone, cloud mockup renderer, multi-PC farm, plugin marketplace, or arbitrary script generator. Reuse the MCP server, MCP SDK, image decoder, SQLite, inference server, and desktop packaging. New application code is necessary for coordination and review; this is distinct from writing new Photoshop automation scripts. Lack of a ready-made tool is a capability failure, never permission to silently drop a requirement.

## Stack and ownership

TypeScript strict, Node 22 LTS baseline (exact supported patch selected and locked during foundation), npm workspaces, official TypeScript MCP SDK, Zod with generated JSON Schema, Vitest, SQLite through one qualified driver, Sharp for deterministic image inspection, Electron + React + Vite desktop, electron-builder Windows installer. Select and pin compatible Electron/Node/native-module versions during foundation; never use floating `latest` in a shipped invocation. Electron embeds the application runtime; a separately pinned Node runtime launches the MCP child so production does not depend on an installed npm or internet access. macOS is the development platform; Windows is a separate acceptance gate.

| Owner | Exclusive paths after foundation |
|---|---|
| A: core and integration | `packages/core/`, `tests/integration/`, `docs/qualification/`, root manifests/lock/config, `.github/workflows/`, shared contract changes |
| B: Photoshop | `packages/photoshop/`, `tests/photoshop/`, `docs/photoshop/` |
| C: intelligence and review | `packages/intelligence/`, `tests/intelligence/`, `docs/intelligence/` |
| D: desktop and Windows delivery | `apps/desktop/`, `tests/desktop/`, `packaging/`, `docs/desktop/` |

Foundation owner creates `packages/contracts/`, fixtures, root tooling, all four minimal package manifests and an initial lockfile once, then records baseline commit. All four workers branch/worktree from that commit. Each worker uses the committed contracts and fakes, edits only its paths, and records dependency requests in its handoff. A integrates dependency changes sequentially and updates the single root lockfile. Parallel work means parallel development and fake-based tests, NOT parallel Photoshop operations.

## Domain rules

One runtime iteration = one input asset rendered into exactly three finished images. The requested reviewer layer checks those actual images during real Windows work before publication. It is not a system for checking development tasks.

Fit modes are `cover`, `contain`, `stretch`. Default proposal is `cover`, centered, preserving aspect ratio; the operator sees and confirms the mode on template qualification. `contain` allows uncovered reference area; `stretch` deliberately distorts. All three are supported in the product contract, but an unavailable mode is disabled with a precise capability error until an existing Action/backend is qualified. The full-release gate includes all three; no silent substitution. Width/height and movement use measured post-place Photoshop layer bounds, not input file resolution. Pixel-space geometry lives in code. Clipping uses the reference layer's alpha/mask, not a rectangular crop substitute.

Never identify a layer by an unqualified duplicate name or assume layer IDs survive reopening. Qualified selectors contain a document route and a sibling path with name, kind and disambiguating structural fingerprint. Resolve to current document/layer IDs on every new working instance. Fail on zero or multiple matches. The template profile is bound to PSD SHA-256, qualification evidence and backend/tool-schema digest.

Use a fresh mutable working copy derived from the immutable source per asset. Close only documents opened by this job, inner-to-outer. Saving a child PSB is allowed only when its parent is a job-owned copy. Shared embedded content propagation across all three variants must be proven with a distinctive sentinel image; independent targets must be enumerated and updated deliberately. Linked Smart Objects must be embedded or their complete dependency set copied/relinked inside the working directory before mutation; a copy of the parent PSD alone does not isolate linked files.

## Frozen contract v1

Foundation translates these normative shapes into Zod schemas, exported TypeScript types and versioned JSON fixtures. Reject unknown keys at trust boundaries. JSON numbers are finite; rectangles require right>left and bottom>top. Paths are canonical absolute host paths checked against explicit allowed roots; portable profiles store file references relative to their selected root and resolve on the receiving OS. No macOS path, document ID or unverified layer name may silently become a Windows default.

```typescript
type FitMode = 'cover' | 'contain' | 'stretch';
type VariantId = '1' | '2' | '3';
type Rect = { left:number; top:number; right:number; bottom:number };
type FileRef = { rootId:string; relativePath:string; sha256:string };
type LayerSegment = { name:string; kind:'group'|'smartObject'|'pixel'|'shape'; fingerprint:string };
type LayerSelector = { documentRoute:LayerSegment[][]; layerPath:LayerSegment[] };
type Variant = { id:VariantId; group:LayerSelector };
type OutputSpec = { format:'jpeg'|'png'; quality:number; colorSpace:'sRGB'; width:number; height:number };
type TemplateProfile = {
  schemaVersion:1; profileId:string; template:FileRef; profileSha256:string;
  backendId:'alisaitteke'|'dcc'; toolSchemaSha256:string;
  targets:Array<{ target:LayerSelector; reference:LayerSelector; input:LayerSelector|null }>;
  variants:[Variant,Variant,Variant]; fitMode:FitMode; output:OutputSpec;
  qualificationId:string;
};
type Asset = { assetId:string; source:FileRef; sourceBytes:number };
type JobSpec = {
  schemaVersion:1; jobId:string; profile:TemplateProfile; assets:Asset[];
  outputRootId:string; modelProfileId:string; reviewerModelProfileId:string; reviewPolicySha256:string;
  trigger:'interactive'|'scheduled'; maxAttempts:2;
};
type CapabilityReport = {
  backendId:'alisaitteke'|'dcc'; version:string; sourceCommit:string;
  toolSchemaSha256:string; supportedFitModes:FitMode[];
  platform:'darwin'|'win32'; photoshopVersion:string; evidencePaths:string[];
};
type RenderRequest = {
  schemaVersion:1; jobId:string; asset:Asset; profile:TemplateProfile;
  attempt:1|2; stagingDirectory:string;
};
type VariantArtifact = {
  variantId:VariantId; path:string; sha256:string; bytes:number;
  width:number; height:number; format:'jpeg'|'png'; colorSpace:'sRGB';
};
type RenderEvidence = {
  schemaVersion:1; jobId:string; assetId:string; attempt:1|2;
  profileSha256:string; sourceSha256:string; toolSchemaSha256:string;
  geometry:Array<{ target:LayerSelector; reference:Rect; placed:Rect;
    fitMode:FitMode; clipped:boolean; adjacentToReference:boolean }>;
  visibility:Array<{ variantId:VariantId; visibleVariantIds:VariantId[] }>;
  artifacts:[VariantArtifact,VariantArtifact,VariantArtifact];
  checks:Array<{ id:string; passed:boolean; evidencePath:string }>;
  documentTracePath:string; toolTracePath:string;
};
type ReviewDecision = {
  schemaVersion:1; reviewId:string; jobId:string; assetId:string; attempt:1|2;
  evidenceSha256:string; sessionId:string; promptSha256:string;
  modelId:string; modelProvenance:ModelProvenance; reviewerVersion:string; reviewPolicySha256:string;
  verdict:'pass'|'revise'|'blocked';
  variantChecks:[VariantReview,VariantReview,VariantReview];
  checks:Array<{ requirementId:string; result:'pass'|'fail'|'unknown'; evidenceRefs:string[]; reason:string }>;
  findings:Array<{ severity:'critical'|'major'|'minor'; code:string; evidenceRefs:string[]; message:string }>;
};
type VariantReview = { variantId:VariantId; verdict:'pass'|'fail'|'unknown'; evidenceRefs:string[]; reason:string };
type ModelProfile = {
  profileId:string; provider:'local-qwen'|'local-vision'|'codex'|'luna'; modelId:string;
  provenance:ModelProvenance; endpoint:string; quantization:string|null;
  contextTokens:number; maxOutputTokens:number;
  capabilities:{ jsonSchema:boolean; vision:boolean; tools:boolean };
};
type ModelProvenance =
  | { kind:'local'; artifactSha256:string; runtimeVersion:string; chatTemplateSha256:string }
  | { kind:'remote'; provider:'codex'|'luna'; modelId:string; revision:string|null; qualificationEvidencePath:string };
type InspectionReport = {
  schemaVersion:1; inspectionId:string; evidenceStatus:'staticCandidate'|'liveObserved'; template:FileRef; capabilities:CapabilityReport|null;
  documents:Array<{ documentKey:string; parentKey:string|null; viaLayer:LayerSelector|null;
    sourceKind:'root'|'embedded'|'linked'|'unknown'; source:FileRef|null; width:number; height:number;
    colorMode:string; bitDepth:number }>;
  candidates:Array<{ candidateId:string; documentKey:string; selector:LayerSelector;
    bounds:Rect|null; visible:boolean; clipped:boolean; belowCandidateId:string|null;
    roleHints:Array<'target'|'reference'|'input'|'variant'> }>;
  observedVariantStates:Array<{ candidateId:string; visible:boolean }>;
  unresolvedLinks:string[]; evidencePaths:string[];
};
type ConfigurationProposal = {
  schemaVersion:1; inspectionId:string; status:'proposed'|'blocked';
  targets:Array<{ targetCandidateId:string; referenceCandidateId:string; inputCandidateId:string|null }>;
  variants:Array<{ id:VariantId; groupCandidateId:string }>;
  fitMode:FitMode; output:OutputSpec|null; missingFields:string[];
  facts:Array<{ claim:string; evidenceRefs:string[] }>; explanation:string;
};
type EvidenceBundleManifest = {
  schemaVersion:1; jobId:string; assetId:string; attempt:1|2;
  files:Array<{ relativePath:string; sha256:string; bytes:number; role:'renderEvidence'|'artifact'|'trace'|'check'|'humanAttestation'|'imageInput' }>;
  visionInputs:VisionInput[];
};
type VisionInput = {
  id:string; role:'source'|'reference'|'output'|'detail'; relativePath:string;
  sha256:string; width:number; height:number; variantId:VariantId|null;
  derivedFromSha256:string; crop:Rect|null;
};
type ReviewPolicy = {
  schemaVersion:1; policyId:string; policySha256:string; promptSha256:string;
  requirements:Array<{ id:string; description:string; mandatory:boolean; evaluator:'deterministic'|'model'|'human' }>;
  visualGate:'qualifiedVisionReviewer'|'humanPerAsset';
};
type TemplateCandidate = Omit<TemplateProfile,'profileSha256'|'qualificationId'>;
type QualificationRequest = {
  schemaVersion:1; inspection:InspectionReport; proposal:ConfigurationProposal;
  workingTemplatePath:string; evidenceDirectory:string;
};
type QualificationResult = {
  status:'qualified'|'blocked'; candidate:TemplateCandidate|null;
  checks:Array<{id:string;passed:boolean;evidencePath:string}>;
  evidencePaths:string[]; errors:DomainError[];
};
type VisualReviewRequest = {
  requestId:string; jobId:string; assetId:string; attempt:1|2;
  preAttestationContentSha256:string; profileSha256:string; sourceSha256:string;
  toolSchemaSha256:string; reviewPolicySha256:string;
  artifacts:[VariantArtifact,VariantArtifact,VariantArtifact];
  contactSheet:{relativePath:string;sha256:string};
};
type DomainError = {
  code:string; category:'validation'|'capability'|'transient'|'ambiguousState'|'review'|'cancelled';
  message:string; retryable:boolean; evidencePaths:string[];
};
```

`targets` must be nonempty, variants must be exactly IDs 1,2,3 with distinct group selectors, quality 1..100, hashes lowercase 64-hex. JPEG quality mapping to backend units must be verified. PNG ignores quality but retains the schema field. `profileSha256` and `policySha256` are SHA-256 of canonical JSON excluding their own field; foundation implements RFC 8785 canonicalization using a pinned library and conformance fixtures. `evidenceSha256` is SHA-256 of the canonical EvidenceBundleManifest: it includes `render-evidence.json` plus artifact, trace, deterministic-QA and required human-attestation file digests. No digest refers to itself. The reviewer response is stored separately and is not included in its own input evidence. Recompute hashes before and after review; any content change invalidates the review. `sourceBytes` and artifact bytes are positive integers. Unqualified profiles cannot satisfy TemplateProfile: save their candidate form separately, with no qualificationId, and never accept them for rendering.

Every evidence/artifact path in RenderEvidence and the bundle manifest is a relative path confined to the asset attempt directory. Only RenderRequest.stagingDirectory is absolute. Resolve paths through a trusted bundle root; reject traversal and symlink escape. This preserves evidence validity after whole-directory publication. Inspection evidence paths are rooted in the separate qualification directory. Remote model weights hashes are unavailable: use tagged remote provenance and record whether a stable revision was exposed; never invent a weights hash. Local Qwen requires a real artifact digest and chat-template digest.

```typescript
interface PhotoshopBackend {
  capabilities(signal:AbortSignal):Promise<CapabilityReport>;
  inspect(templatePath:string, signal:AbortSignal):Promise<InspectionReport>;
  qualify(request:QualificationRequest, signal:AbortSignal):Promise<QualificationResult>;
  render(request:RenderRequest, signal:AbortSignal):Promise<RenderEvidence>;
  recover(jobId:string, signal:AbortSignal):Promise<{ safe:boolean; evidencePaths:string[] }>;
}
interface IntelligenceService {
  propose(input:{ instruction:string; inspection:InspectionReport; modelProfileId:string }, signal:AbortSignal):Promise<ConfigurationProposal>;
  review(input:{ evidence:RenderEvidence; manifest:EvidenceBundleManifest; policy:ReviewPolicy }, modelProfileId:string, signal:AbortSignal):Promise<ReviewDecision>;
  inspectModelProfile(profile:ModelProfile, signal:AbortSignal):Promise<{available:boolean;errors:DomainError[]}>;
  qualifyModelProfile(profile:ModelProfile, signal:AbortSignal):Promise<{qualified:boolean;evidencePaths:string[];errors:DomainError[]}>;
}
interface SetupService {
  inspectTemplate(templatePath:string, signal:AbortSignal):Promise<InspectionReport>;
  proposeConfiguration(input:{instruction:string;inspectionId:string;modelProfileId:string}, signal:AbortSignal):Promise<ConfigurationProposal>;
  qualifyTemplate(input:{inspectionId:string;proposal:ConfigurationProposal;workingTemplatePath:string}, signal:AbortSignal):Promise<TemplateProfile>;
  inspectModelProfile(profile:ModelProfile, signal:AbortSignal):Promise<{available:boolean;errors:DomainError[]}>;
  qualifyModelProfile(profile:ModelProfile, signal:AbortSignal):Promise<{qualified:boolean;evidencePaths:string[];errors:DomainError[]}>;
}
interface JobService {
  validate(spec:JobSpec):Promise<{ valid:boolean; errors:DomainError[] }>;
  start(spec:JobSpec):Promise<{ jobId:string }>;
  pause(jobId:string):Promise<void>;
  resume(jobId:string):Promise<void>;
  cancel(jobId:string):Promise<void>;
  retryFailed(jobId:string):Promise<{jobId:string}>;
  visualReview(jobId:string, assetId:string):Promise<VisualReviewRequest|null>;
  submitVisualAttestation(requestId:string, decision:'approve'|'reject', notes:string):Promise<void>;
  snapshot(jobId:string):Promise<JobSnapshot>;
  subscribe(jobId:string, listener:(event:JobEvent)=>void):()=>void;
}
type AssetStatus = 'queued'|'rendering'|'reviewing'|'readyToCommit'|'complete'|'failed'|'blocked'|'cancelled';
type JobSnapshot = { jobId:string; state:'ready'|'running'|'pausing'|'paused'|'completed'|'failed'|'blocked'|'cancelled'; total:number; complete:number; failed:number; blocked:number; assets:Array<{assetId:string;status:AssetStatus;attempt:number;error:DomainError|null}> };
type JobEvent = { schemaVersion:1; jobId:string; sequence:number; timestamp:string; kind:'snapshot'|'assetStatus'|'review'|'error'; snapshot:JobSnapshot };
```

Inspection and proposals are non-executable data. Static inspection may have capabilities:null and sourceKind:unknown; liveObserved requires a non-null verified CapabilityReport. Neither status alone means qualified: the sentinel, geometry, linked isolation and visual qualification gates still apply. A blocked proposal may have output:null only when missingFields names the unresolved output fields; proposed status requires a complete OutputSpec. Proposals cite only candidate IDs in the supplied inspection, never arbitrary generated paths, scripts or MCP calls. The application resolves IDs to selectors, validates completeness, and performs qualification before creating TemplateProfile. Model output cannot change a qualification result. Foundation exports these interfaces and their Zod schemas from `@ne-psd/contracts`; no runtime boundary may accept an unchecked cast.

`PhotoshopBackend.qualify` is the separate pre-profile live workflow: B qualifies a candidate on owned copies under its single lock and returns evidence plus the prepared template FileRef if preparation changed bytes. It must not fabricate a qualified profile merely to call render. A validates all mandatory qualification checks and evidence, records the qualification, then computes the final profile hash and qualificationId. Rendering accepts only that sealed profile. `SetupService.proposeConfiguration` resolves a persisted inspection and delegates to C; model inspection/qualification also delegate to C's named methods.

Human visual acceptance has a complete submission boundary: core creates and persists a one-shot VisualReviewRequest over staged artifacts and a content digest before attestation. D displays all three artifacts and the contact sheet, then submits an explicit operator approve/reject through typed IPC. Main supplies the local actor identity to core through trusted composition, never model-generated text. Core verifies the request is current, rehashes content, records attestation and only then creates the final evidence manifest for C. Repeat identical submissions are idempotent; conflicting or stale submissions reject. `retryFailed` returns the new jobId so D subscribes to that successor; the prior job and its evidence remain readable.

## Execution, publication and recovery

Track B owns the single OS-visible lock per Photoshop installation; track A owns only the job queue and never creates a competing installation lock. Single process-level lock per Photoshop installation with PID/host/start identity and conservative stale-owner handling. One in-flight Photoshop operation. Never replay a timed-out mutation: uncertain document state pauses the job, requires recovery and starts a fresh working copy. Lock remains held while Photoshop may still be executing; a timed-out MCP child or dead host is not proof Photoshop is idle. Operator recovery is preferable to corrupting another document.

Asset state is persisted in SQLite; append evidence as files with digests. Stable asset ID = digest of normalized relative input path plus source digest, not basename alone. Transaction key includes asset digest, template/profile digest, fit/export policy, backend version and reviewer/prompt policy digest. Changed source/template/policy invalidates reuse. Duplicate names, case-only differences, Unicode and Windows reserved names must never overwrite files.

Export three files to a fresh attempt staging directory. Decode, inspect geometry/visibility, run fresh-session review and validate its decision. A pass cannot override a failed mandatory deterministic check. Commit by same-volume rename of the whole staged asset directory containing all three outputs, evidence and a committed manifest, then mark SQLite complete. Consumers only see/consume committed directories. A crash after rename but before the database update is reconciled from validated directory manifest; a crash earlier leaves uncommitted staging. Never claim three independent file renames are atomic. Output example: `outputs/<jobId>/cat--<assetId-prefix>/cat__1.jpg`, `cat__2.jpg`, `cat__3.jpg`.

Transient safe failures get one retry on a fresh working copy. Review `revise` retries only an allowlisted, deterministic correction with a known cause; no speculative Photoshop edits. Invalid/missing/unknown evidence, failed review service, unsupported model or ambiguous Photoshop state becomes blocked. Confirmed unrecoverable asset failures are recorded and processing can continue only after cleanup is proven. Review backlog is durable and can resume without rerendering intact staged evidence. Cancel is honored at safe boundaries; do not force-kill Photoshop.

## Model and review policy

The owner's requested label is `Qwen3.8-27B`. Its exact release, weights, license, inference compatibility and vision capability have not been verified. Preserve the requested label; do not silently substitute another Qwen generation or model. Resolve and pin the actual local model ID, artifact SHA-256, quantization and chat template during model qualification. Prefer GGUF + a pinned llama.cpp server when the selected artifact is compatible; otherwise qualify an explicit local runtime rather than guessing flags.

Q4/Q5/Q6 and Q8 are capacity configurations, not feature tiers. Rough weights-only lower bounds for 27B are 13.5/16.9/20.3/27.0 decimal GB; actual quantized metadata, KV cache, runtime, GPU offload, Photoshop working copies, image decode and desktop need additional measured memory. RAM does not substitute for GPU VRAM bandwidth. Benchmark peak RSS/VRAM, latency and context with representative assets. Qualify Q4/Q6/Q8 against the same acceptance corpus; choose Q8/add RAM if the smaller quantization fails. Never shorten essential instructions or remove acceptance checks to fit hardware. Allow one loaded model and sequential stateless requests so a fresh session does not mean loading duplicate weights.

Interactive user-launched batches may use local Qwen. Interactive Codex is an explicit owner-selected alternative, never an automatic fallback. Any future digest or token-intensive scheduled job must pin `gpt-5.6-luna` in both scheduler and invocation, following the owner's global policy. No fallback. If Luna is unavailable, record the error and defer. This release creates no timers, cron, launchd, Task Scheduler entries, Codex heartbeats or scheduled monitoring. Windows startup is a foreground UI launcher only, never a model job. A scheduled trigger selecting Qwen must be rejected.

Production review happens for EVERY asset transaction before publication, even when a whole folder was launched at once. Each review uses a new request/session ID, a distinct versioned reviewer system prompt, no builder/planner history, and an immutable evidence packet. The reviewer has no Photoshop, filesystem-write, shell or network tools. A fresh context on the same Qwen weights is independent context, not independent model judgment; deterministic checks remain authoritative. Automated result review requires actual image inputs to a qualified vision-capable reviewer. Prefer the requested Qwen for both roles if its exact artifact supports and passes image-review qualification. Otherwise retain Qwen as planner/brain and explicitly configure a separately qualified local vision model or owner-selected Codex vision endpoint for image review; never switch automatically. The local-vision provider is permitted only for this explicitly selected reviewer role. JobSpec.modelProfileId identifies the brain/planner profile and reviewerModelProfileId separately pins the image reviewer. They may be equal only when that artifact passes vision qualification. Both resolved profile/provenance digests participate in transaction identity; validate every ReviewDecision against reviewerModelProfileId, never implicitly against the planner. A text-only Qwen cannot satisfy automated visual acceptance. humanPerAsset is an explicit manual/test mode, not fulfillment of the fully automatic Windows release gate. Never report visual correctness from text-only evidence.

EvidenceBundleManifest.visionInputs contains digested, explicitly typed actual image inputs; each path also exists in files with role imageInput or artifact. derivedFromSha256 and crop bind resized/tiled views to their original pixels. The multimodal request must transmit those image bytes through the runtime's qualified image API, not merely text paths/base64 strings. Each result packet includes the source design image, the qualified template/reference views, all three full exports and needed detail crops, with a rubric for source identity, intended fit/crop, clipping/edges, visibility and preservation of template effects. The reviewer must return exactly one VariantReview for each ID 1,2,3; set-level pass requires all three to pass plus all mandatory deterministic checks. A failed/unknown image blocks publication of that asset set and enters a durable correction/exception queue. A new attempt gets a new context and new evidence. Other assets may continue when Photoshop cleanup is proven. The user correction excludes any mandatory per-development-task reviewer layer; normal testing remains part of implementation.

## Release definition

Release requires three correct exports per input; qualified template linkage and geometry; every artifact actually image-reviewed by the qualified vision path for automated release; crash-safe resume; collision-safe filenames; unchanged source/master/linked originals; usable local Qwen setup; no unsupported fallback; responsive UI with pause/resume/cancel/retry; offline runtime after setup; and installation/upgrade/uninstall plus live Photoshop qualification on Windows. macOS fake tests do not count as Windows or Photoshop proof.

Performance criteria are measured rather than invented: record per-phase median/p95, 100-asset real run, 10,000-asset fake endurance, peak RAM/VRAM/disk and resume behavior. No throughput promise precedes hardware benchmarking. All acceptance failures remain visible; a missing real PSD, Photoshop, exact Qwen artifact or Windows host blocks the corresponding qualification gate, not the independently testable implementation tracks.
