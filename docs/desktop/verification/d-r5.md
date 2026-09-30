# D-R5 packaging packet — 2026-09-30

Status: implementation and synthetic fixture checks complete; Windows qualification blocked.

Owned changes: strict manifest and offline file inventory validator; staged resource preparation with atomic rename; bundle verification; Windows x64 PE/ABI, hash, size, path, package closure, license/evidence and all-fit resource rejection; Electron builder/NSIS recipe; native smoke performing temporary SQLite and Sharp operations; PowerShell acceptance, path, offline and signature probes. The manifest remains `blocked` with missing vendor/native/fit/qualification/signing evidence. No Windows installer was built or claimed qualified.

RED: `npm run test:desktop -- tests/desktop/packaging.test.ts` failed on missing strict module before implementation (Node 25 diagnostic run).

GREEN using `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin` (Node 22.23.2, npm 10.9.8):

- `npm run test:desktop -- tests/desktop/packaging.test.ts tests/desktop/runtime-resolution.test.ts tests/desktop/prerequisites.test.ts`: 3 files, 16 tests passed.
- `npm run typecheck -w @ne-psd/desktop`: passed. Concurrent D-R1 edits were present; this is a snapshot, not integration acceptance.
- `node packaging/prepare-resources.mjs`: exit 2, blocked manifest lists missing vendor/native/fit/qualification/signing evidence.
- `node packaging/verify-bundle.mjs`: exit 2, same blocked manifest.
- `node packaging/native-smoke.mjs`: exit 2, Windows x64/ready-manifest/consumer/module-root required.

Synthetic tests prove local validation behavior only. Real native operations, NSIS installation, Windows PowerShell scripts, Photoshop, model, offline rendering, signatures and real PSD remain unexecuted. Windows release gate stays blocked. The acceptance script writes observed command outputs and exits nonzero on missing evidence; its offline probe cannot claim zero outbound traffic or render completion from a launch alone.

Serial integration required after D-R1 owns `apps/desktop/`: load manifest relative to the packaged application/resources, validate it, derive absolute `resources/runtime/node.exe` and `resources/runtime/mcp.cjs`, and spawn with a fixed argument array, `shell:false` and controlled environment. No renderer-supplied command or working-directory resolution. Add package scripts `dist:win` (prepare resources, then electron-builder NSIS x64 with `packaging/electron-builder.yml`) and `verify:bundle` (run `packaging/verify-bundle.mjs`); A owns the shared dependency/lockfile change for electron-builder. A/B must supply verified Windows vendor binaries, full production dependency tree, source/redistribution licenses, fit resources, and qualification records. The two native smoke invocations require the installed Electron ABI and standalone Node ABI separately.
