# Coordinated direct dependencies — 2026-09-30

Scope: A-owned manifest and lockfile correction only. No package version upgrade, shared contract change, `node_modules` replacement, or installer qualification is included.

## Accepted lane requests

| Request | Direct dependency added | Reason and compatibility |
| --- | --- | --- |
| B, `docs/photoshop/handoff.md` (B02) | `@ne-psd/photoshop` → `@modelcontextprotocol/sdk: 1.30.0` | `mcp-client.ts` imports the SDK client and stdio transport directly. The same exact SDK version was already present in the root lockfile and declared by intelligence. This makes clean-install resolution independent of hoisting. No public contract or runtime API migration is requested. |
| C, `docs/intelligence/task-3-dependency-request.md` (C3 item 1) | `@ne-psd/intelligence` → `zod: 4.6.5` | C uses Zod schema generation and parsing at its runtime transport boundary. The same exact Zod version was already locked and directly declared by contracts. This supplies a valid package declaration without introducing a second Zod version. C's separate blocked-proposal schema request is handled through the shared-contract process, not this dependency commit. |

`packages/photoshop/package.json`, `packages/intelligence/package.json`, and the two corresponding workspace entries in `package-lock.json` were changed together. The resolved SDK and Zod package records, including their existing integrity values, did not change. No root manifest or other package entry changed.

## Verification and lane migration

The shared Node toolchain in `toolchain-2026-09-30.md` ran:

```sh
PATH=/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin:$PATH \
npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund \
  --cache=/private/tmp/ne-psd-npm-cache
```

Result: `up to date`; lockfile diff is confined to the two direct dependency entries. A programmatic check confirmed each manifest pin equals its workspace-lock pin and the already resolved `node_modules` version: SDK `1.30.0`, Zod `4.6.5`, both with SHA-512 integrity records. `npm ls @modelcontextprotocol/sdk zod` for the B and C workspaces exited 0. `git diff --check` passed. Full suites and `npm ci` were deferred because parallel A workers are running RED tests and own the current core `node_modules` state.

After adopting this coordinated commit, B and C should install from the lock under the pinned Node 22.23.2/npm 10.9.8 toolchain in their own worktrees, then run their focused tests and typechecks. C must rebuild contracts before intelligence when its separate shared-schema change lands. This commit alone does not accept that schema change or C4's decoder request; `sharp: 0.35.4` is already directly declared by B and the package is already locked, while C4's consumer contract remains separate.

## Security assessment, read-only

The saved `docs/qualification/npm-audit-evidence.json` is dated 2026-09-21 and records 13 vulnerable package nodes (12 high, 1 critical), with no automatic fix. Every one of those 13 package versions remains present at the same version in the current lockfile after this change. This is evidence of unresolved **known** findings, not a fresh count of all current advisories. In particular, the saved report lists Electron `41.0.0` and `electron-builder` `26.0.12` as direct roots, with `tar` `6.2.1` critical in builder/rebuild paths. The saved report marks release blocked pending security review; that remains the only supported security status here.

A fresh read-only `npm audit` was attempted on 2026-09-30. Automatic approval review rejected the registry request because it could disclose dependency metadata, including private package names, without explicit authorization for that destination. The command was not run and no current clean audit is claimed. No alternate network route was used.

Minimal follow-on security packet: review fixed releases for the two direct roots, using the historical audit's candidates `electron 41.10.7` and `electron-builder 26.15.3` as starting points; update only those exact pins and the lockfile once; verify whether their selected tree removes the `tar 6.2.1` and other recorded vulnerable nodes (the historical report calls for `tar >=7.5.21`). Add a narrowly scoped override only if a reviewed compatible tree still needs one. Run an authorized fresh audit, package/build checks, Electron native-module ABI smoke, installer tests, and Windows qualification before changing release status. The candidate versions are historical suggestions, not a verified 2026-09-30 remediation or security acceptance.
