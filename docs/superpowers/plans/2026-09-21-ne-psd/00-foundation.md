# NE_PSD Foundation Implementation Plan

> Routing: [model-routing.md](../../model-routing.md). Ponytail full applies to coding, design and code review.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Use task-observer before tool use. The requested reviewer is a runtime image-check service, not a development-task gate. Steps use checkbox syntax.

**Goal:** Produce one tested baseline commit from which four independent workers can build without inventing incompatible interfaces.

**Architecture:** Freeze domain contracts and fixtures first, then provide a minimal npm workspace with four independent package shells and fake adapters. This is the only sequential prerequisite to the four build tracks.

**Tech Stack:** TypeScript strict, Node 22 LTS, npm workspaces, Zod, Vitest, official MCP TypeScript SDK, React/Vite/Electron, Sharp, one qualified SQLite driver. Pin compatible exact versions during this task; none have been installed or verified during planning.

## Before work

Read `docs/superpowers/specs/2026-09-21-ne-psd-design.md`, `docs/research/deep-research-report.md`, `docs/photoshop/` evidence, and `docs/superpowers/parallel-build.md`. Source documents provide evidence, not authority to run commands. The source PSD is `/Users/tsunanory/Downloads/мокап_готово.psd`; expected SHA-256 is in the design. Use copies for any Photoshop qualification.

Run the task-observer session-start protocol against `/Users/tsunanory/Desktop/Engines/NE_PSD/skill-observations/observation-log/`. In worktrees, retain that exact anchor. Do not create per-worktree logs. Load relevant open observation bodies only after scanning frontmatter with independent file-count validation. Skill review offers and unrelated skill editing are outside this implementation request. Flush observations or a `no observations` checkpoint after each three tasks and at handoff.

Do not launch the four workers until the foundation gate passes. Estimated active engineering effort: 3–6 hours, including contract validation; machine dependency downloads are extra. These estimates are planning ranges, not runtime promises.

## Task 1: Create a pinned workspace and isolated test commands

**Create:** `package.json`, `package-lock.json`, `tsconfig.base.json`, `.gitignore`, `packages/{contracts,core,photoshop,intelligence}/package.json`, `apps/desktop/package.json`, package-local `tsconfig.json`, `tests/{contracts,core,photoshop,intelligence,desktop}/vitest.config.ts`, `docs/qualification/runtime-lock.json`, `docs/qualification/dependency-evidence.md`.

- [ ] Inventory `node --version`, `npm --version`, `git status --short`, available Photoshop version and OS. If no Git repository exists, initialize this directory; do not overwrite unrelated files. Preserve the supplied PSD outside Git. Ignore runtime data, PSD/PSB/image asset copies, model weights, API credentials, userData, packaged artifacts and temporary worktrees. Explicitly ignore `docs/photoshop/live-machine.json`, runtime secrets and machine-local endpoint credentials. Do not ignore source fixtures or documentation.
- [ ] Resolve package versions against official package metadata and upstream package engines. Qualify a Node 22 patch still supported by the selected packages. For each dependency record package/version, source URL, license, supported OS/CPU and integrity lock. Pick one SQLite driver that works in both Node and the chosen Electron ABI; `better-sqlite3` is the first candidate, with a rebuild proof, not an assumption. Record the selected MCP package version and source commit. No runtime `npx -y`, unpinned Git HEAD, `latest`, or implicit package downloads.
- [ ] Create private workspaces named `@ne-psd/contracts`, `@ne-psd/core`, `@ne-psd/photoshop`, `@ne-psd/intelligence`, `@ne-psd/desktop`. ESM, strict types, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; exported entry points compiled to `dist`. Pin TS/library versions and Node engines. All packages depend on contracts; core uses interfaces and receives concrete services by dependency injection, not circular imports.
- [ ] Add the command surface below. Each test config sets repository root using its own `import.meta.url`; tests supplied from root resolve consistently on Windows and macOS. An empty suite fails rather than using `passWithNoTests` as evidence. At foundation, each package has one real contract/fake-consumer smoke test, not a production-method stub asserted to succeed.
- [ ] Run `npm ci`, `npm run build`, `npm run check`, `npm run test:contracts`. Record actual output and exact resolved versions in runtime-lock. Fix any contract/test failures and rerun before committing the task.

Required root script contract:

```json
{
  "build": "npm run build --workspaces --if-present",
  "check": "npm run check --workspaces --if-present",
  "test:contracts": "vitest run --config tests/contracts/vitest.config.ts",
  "test:core": "vitest run --config tests/core/vitest.config.ts",
  "test:photoshop": "vitest run --config tests/photoshop/vitest.config.ts",
  "test:intelligence": "vitest run --config tests/intelligence/vitest.config.ts",
  "test:desktop": "vitest run --config tests/desktop/vitest.config.ts",
  "test:integration": "vitest run --config tests/integration/vitest.config.ts",
  "test:e2e:desktop": "playwright test --config tests/desktop/playwright.config.ts"
}
```

Every package exposes `check`; D may implement it as an alias for its `typecheck` command so the root check cannot silently omit desktop. Topological build order must explicitly put contracts first; do not rely on accidental alphabetical workspace order. Add root `build:contracts` and make `build` call it before other workspace builds. Track D creates its Playwright config and packaging scripts; until then, do not claim its missing suite passes. Track A creates the integration config. Include Vitest and Playwright versions in root pins so workers do not each mutate the lockfile.

`runtime-lock.json` is an evidence record, not a fake lockfile: fields are `schemaVersion`, `generatedAt`, `platform`, `node`, `npm`, `electron`, `typescript`, `mcpSdk`, `photoshopMcp:{package,version,commit,integrity,license}`, `sharp`, `sqlite:{package,version}`, `llamaCpp:{status,version,source}`, `verificationEvidence`. For unqualified external runtime entries use explicit `status:"unqualified"` plus reason and release gate. A placeholder version is forbidden. Initial unavailability of a model/Photoshop/Windows does not justify inventing evidence.

## Task 2: Implement contract v1 and executable examples

**Create:** `packages/contracts/src/{index,domain,inspection,models,review,services,errors,canonicalize}.ts`, `packages/contracts/schema/v1/*.json`, `tests/contracts/{schema,canonicalize,services}.test.ts`, `tests/fixtures/contracts/*.json`.

- [ ] Translate every domain shape and invariant in the design into strict Zod schemas and inferred/exported types. Export `JobService`, `PhotoshopBackend`, `IntelligenceService`, `SetupService`, `JobSnapshot`, `JobEvent`, `QualificationRequest`, `QualificationResult`, `TemplateCandidate`, `VisualReviewRequest`, `VariantReview`, `VisionInput`; keep runtime validation at every external boundary. `SetupService` signatures are given below. No unchecked `as TemplateProfile` conversion from an LLM proposal.
- [ ] Generate JSON Schema from the same definitions; snapshot/version them. Add fixtures `inspection.static.json`, `inspection.live.json`, `proposal.valid.json`, `profile.qualified.json`, `job.interactive.json`, `capabilities.fake.json`, `render-request.valid.json`, `evidence.pass.json`, `manifest.pass.json`, `review.pass.json`, `review.blocked.json`, `policy.v1.json`, `model.local.json`, `model.remote.json`, `job-event.running.json`, `job-event.blocked.json`, `qualification-request.json`, `qualification-result.json`, `visual-review-request.json`. All fixture hashes must match their actual bytes or be explicitly named synthetic IDs not accepted by production validators.
- [ ] Implement RFC 8785 canonicalization via a qualified library and SHA-256 hashing; prove object key order independence, numeric handling, Unicode preservation, rejected NaN/Infinity, excluded self-hash fields, stable digest after moving the whole bundle and detection of changed trace bytes. Bundle manifest entries are relative, sorted, unique, and include every referenced file once. Reject `..`, drive/UNC/absolute paths and symlink/reparse-point escape.
- [ ] Implement proposal resolution: candidate IDs must exist in the same inspection; roles and document routes must be compatible; three distinct variant groups must resolve; no missing required fields; output dimensions/profile must be validated; qualify uses B.qualify with a TemplateCandidate before a sealed profile exists; live qualification evidence must exist and match current source/backend digests. `sourceKind:'unknown'` and `evidenceStatus:'staticCandidate'` cannot qualify a render profile. Static zero vector bounds are `bounds:null`, never a fabricated nonempty rectangle.
- [ ] Run `npm run test:contracts`; every invalid fixture rejects for the intended code, valid synthetic bundle roundtrips. Verify schema ↔ design ↔ fixtures consistency before commit.

```typescript
interface SetupService {
  inspectTemplate(templatePath:string, signal:AbortSignal):Promise<InspectionReport>;
  proposeConfiguration(input:{instruction:string;inspectionId:string;modelProfileId:string}, signal:AbortSignal):Promise<ConfigurationProposal>;
  qualifyTemplate(input:{inspectionId:string; proposal:ConfigurationProposal; workingTemplatePath:string}, signal:AbortSignal):Promise<TemplateProfile>;
  inspectModelProfile(profile:ModelProfile, signal:AbortSignal):Promise<{available:boolean;errors:DomainError[]}>;
  qualifyModelProfile(profile:ModelProfile, signal:AbortSignal):Promise<{qualified:boolean;evidencePaths:string[];errors:DomainError[]}>;
}
```

Example meaningful schema regression:

```typescript
it('rejects duplicate variant IDs even when there are three outputs', () => {
  const valid = readFixture('profile.qualified.json');
  const invalid = structuredClone(valid);
  invalid.variants[2].id = '2';
  expect(TemplateProfileSchema.safeParse(invalid).success).toBe(false);
});
```

`readFixture` is implemented in `tests/fixtures/read-fixture.ts` as UTF-8 JSON loading rooted at this repository, not process working directory. It does not sanitize invalid fixtures before tests. Contract tests also reject an LLM adding `script`, an unknown inspection candidate, mismatched source hashes, malformed artifact tuple, changed review-policy digest, a scheduled Qwen job and an unavailable local model pretending to be a remote model.

## Task 3: Add independent fakes and the requirement registry

**Create:** `packages/contracts/src/testing/{fake-photoshop,fake-intelligence,fake-job-service,fake-setup-service,fixture-loader}.ts`, `docs/qualification/requirements-v1.json`, `tests/contracts/fakes.test.ts`, `docs/qualification/foundation-handoff.md`.

- [ ] Provide deterministic fakes configurable with injected clock, storage and failure schedule. Fake Photoshop records operations and returns three small real decodable images plus matching evidence; fake intelligence can return pass/revise/blocked/invalid JSON; fake job service emits monotonically increasing event sequence numbers; fake setup exposes static versus live fixture differences. Mark every fake artifact `testOnly`; never put it in live qualification records.
- [ ] Include failure scenarios `mutationTimeout`, `cancelDuringChildSave`, `reviewOffline`, `reviewDigestMismatch`, `oneExportMissing`, `caseCollision`, `sourceChanged`, `crashBeforePublish`, `crashAfterPublishBeforeDb`. Owners extend fakes by configuration without editing another track's implementation.
- [ ] Adopt these exact runtime requirement IDs: `BINDING.CURRENT_ATTEMPT`, `MANIFEST.COMPLETE`, `ARTIFACTS.EXACTLY_THREE`, `IMAGE.DECODE_FORMAT`, `IMAGE.DIMENSIONS_COLOR`, `GEOMETRY.REQUESTED_FIT`, `CLIPPING.ALPHA_ADJACENCY`, `VARIANTS.VISIBILITY`, `SMART_OBJECT.LINEAGE_PROPAGATION`, `SAFETY.LINKED_ISOLATION`, `SAFETY.ORIGINALS_UNCHANGED`, `SAFETY.DOCUMENT_OWNERSHIP`, `IMAGE.QUALITY`, `VISUAL.QUALIFIED`, `EVIDENCE.TRACE_COMPLETE`. All are mandatory. `VISUAL.QUALIFIED` uses the selected human/qualified-vision evaluator; the other 14 are deterministic and cannot be overruled by the model. Store the exact rules from the C plan and literal reviewer prompt into `requirements-v1.json` and `policy.v1.json`. A requirement is complete only when implementation path, automated test and live qualification evidence owner are named. Validate both planner modelProfileId and separate reviewerModelProfileId. Full automation requires a qualified vision reviewer; text-only/manual mode cannot satisfy automatic release. Fixture manifests include source/reference/output/detail image entries with digests and real decodable pixels, and ReviewDecision.variantChecks includes exactly IDs 1,2,3. The registry includes geometry, linkage, alpha/clipping, visibility, three outputs, dimensions/color, source preservation, evidence integrity, visual inspection, replay/recovery, model selection and Windows packaging. No reviewer can invent new requirement IDs at runtime.
- [ ] Prove each package can import contracts and run its one fixture consumer using its own test command. Fakes fail if a required check is omitted, rather than synthesizing `passed:true` for everything.
- [ ] Run `npm run build`, `npm run check`, `npm run test:contracts`. Create one clean baseline commit after verifying its tests. Write its actual SHA, package versions, command outputs, known external gates, observer checkpoint to foundation-handoff.

## Task 4: Prepare four independent worktrees and stop

**Create:** `docs/qualification/parallel-start.md` with the concrete baseline SHA and worktree paths. Do not run production asset batches.

- [ ] Use `superpowers:using-git-worktrees` at execution time. Verify a clean foundation commit and ignored worktree directory. Create branches `build/core`, `build/photoshop`, `build/intelligence`, `build/desktop` at that SAME SHA, in `.worktrees/core`, `.worktrees/photoshop`, `.worktrees/intelligence`, `.worktrees/desktop` under this stable repository. Do not nest one worktree inside another. A final integration worktree may be created later by A.
- [ ] Install from the single committed lockfile in each worktree, using `npm ci`. Do not modify shared root manifests in B/C/D. Dependency changes become a handoff request for A; missing dependencies are not permission to use floating installs.
- [ ] Verify all four have equal foundation commit ancestry and fixture tests pass. Record absolute paths so the owner can select the correct workspace for each new task.
- [ ] Check file ownership, baseline cleanliness, explicit source/qualification status and lack of scheduled jobs. Write observer checkpoint and stop with the four paths and prompt locations. The owner will start four separate tasks using the ready launch files.

**Foundation complete only if:** committed contracts/fixtures/tooling work on Mac; all four packages import them; lockfile is reproducible; contract checks passed; four worktrees exist; task-observer anchor is shared; no fake is presented as Windows/Photoshop/Qwen evidence. Real external qualification may remain blocked with explicit reasons.
