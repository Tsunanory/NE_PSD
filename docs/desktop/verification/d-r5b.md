# D-R5b packaged runtime integration — 2026-09-30

Status: local integration code and synthetic checks complete; Windows vendor and live acceptance blocked.

The builder recipe places the vendor tree under `resources/bundle`, and the blocked/ready manifest plus verifier at `resources/runtime-manifest.json` and `resources/runtime-manifest.mjs`. `loadRuntimeManifest` uses an explicit absolute resources path. `verifyPackagedResources` imports the shipped verifier and hashes the entire bundle before launch. `launchPackagedMcp` spawns the fixed absolute `bundle/runtime/node.exe` with exactly one absolute `bundle/runtime/mcp.cjs` argument, `shell:false`, and only allowlisted environment variables. It does not accept renderer commands. The standalone MCP Node ABI and Electron main native ABI remain distinct; the Windows native smoke script exercises both when run on the installed package.

`checkPrerequisites` accepts caller-supplied live probes for connected qualified Photoshop controller and verified license, reachable qualified model artifact, verified runtime bundle, and output storage. A running Photoshop process alone cannot satisfy its license check. `inspectOutputDirectory` checks available bytes and a disposable write/rename, returning the measured free bytes. The main/index/UI integration must supply the qualified probe implementations and report the returned messages; these hooks do not themselves establish a Photoshop license or model artifact.

`apps/desktop/package.json` now includes `dev:fake` (explicit `NODE_ENV=development`, `NE_PSD_DEV_FAKE=1`, and built-file renderer), `dist:win`, and `verify:bundle`. R1 confirmed the development guard. Root dependency pins and lockfiles remain under A. A's pending security packet proposes a different Electron pin; reconcile the manifest, builder and actual native ABI only after A's coordinated lock commit. No new dependency was installed here.

RED: the two focused test files initially failed on missing prerequisite hooks and old runtime manifest handling. A subsequent test exposed POSIX absolute paths being interpreted as Windows paths; the path rule was corrected.

GREEN with pinned Node 22.23.2/npm 10.9.8 under `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin`:

- `npm run test:desktop -- tests/desktop/runtime-resolution.test.ts tests/desktop/prerequisites.test.ts tests/desktop/packaging.test.ts`: 3 files, 24 tests passed.
- `npm run build -w @ne-psd/desktop`: Vite and TypeScript passed at the earlier snapshot. This is macOS development evidence, with concurrent desktop changes present.
- Latest `npm run typecheck -w @ne-psd/desktop`: failed in concurrently edited `src/renderer/jobs/JobView.tsx` on `selectedAssetId` and `handlers` optional-property types. This file is outside D-R5b ownership; the focused packaging suite remains green.

Serial wiring for R2/R4: call `verifyPackagedResources(process.resourcesPath)` before creating production services; use `launchPackagedMcp` for the selected standalone MCP child; supply qualified controller/model/output probes to `checkPrerequisites`; show its messages and output free-space report in setup. `startDesktop('production', services)` still requires A's concrete JobService/SetupService; no fake service is permitted in production. The packaging path and these hooks are not yet called by index/UI. Real Windows packaging, native smoke, installation, offline rendering and signatures remain blocked by vendor inputs, Windows host, Photoshop/model qualification and signing evidence.
