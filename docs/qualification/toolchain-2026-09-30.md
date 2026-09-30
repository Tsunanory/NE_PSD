# Shared macOS development toolchain — 2026-09-30

Status: **qualified for macOS arm64 development**. This is not Windows, Electron, Photoshop, or product release qualification.

## Location and provenance

- Shared bin directory: `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin`
- Node executable: `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin/node`
- npm executable: `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin/npm`
- Source: official `https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.xz`, downloaded on 2026-09-30. This single extracted copy is outside the four lane worktrees. No global Node installation or shell configuration was changed.
- Archive SHA-256: `5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1`. The downloaded archive matched both `docs/qualification/runtime-lock.json` and the corresponding entry in the official `https://nodejs.org/dist/v22.23.2/SHASUMS256.txt` fetched on 2026-09-30.
- Extracted `bin/node` SHA-256: `18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572`; `lib/node_modules/npm/bin/npm-cli.js` SHA-256: `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7`.

## Executed verification

From the core worktree with this absolute toolchain: `node -v` returned `v22.23.2`; `npm -v` returned `10.9.8`; `process.versions.modules` returned `127`; `process.platform`/`process.arch` returned `darwin`/`arm64`.

Core's existing `better-sqlite3@12.9.0` binary initially failed to load: it was built for Node ABI 141. It was rebuilt in the ignored core `node_modules` against the pinned Node headers. The host Command Line Tools did not locate the C++ standard headers by default, so the rebuild used the installed macOS SDK path explicitly. A subsequent in-memory SQLite smoke test passed:

```json
{"node":"v22.23.2","abi":"127","sqlite":"12.9.0","value":42}
```

This checks the native SQLite baseline **in core only**. Other worktrees have separate `node_modules` and must rebuild their native modules if their ABI differs. The existing Electron ABI 145 result in `runtime-lock.json` is historical foundation evidence and was not rerun here.

## Use from any lane worktree

```sh
export PATH=/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin:$PATH
node -v
npm -v
node -p 'process.versions.modules'
```

Run all project npm commands in that shell. Do not treat a check under the host Node 25/npm 11 as the pinned baseline. If `better-sqlite3` reports an ABI mismatch in a lane, rebuild it **from that lane's worktree** with the pinned toolchain:

```sh
npm_config_nodedir=/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64 \
npm_config_cache=/private/tmp/ne-psd-npm-cache \
CXXFLAGS='-isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk -isystem /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1' \
CFLAGS='-isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk' \
LDFLAGS='-isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk' \
npm rebuild better-sqlite3 --workspace=@ne-psd/core
```

The last command is for core's workspace. Use the native dependency's actual workspace when another lane needs a rebuild. No root manifests or lockfiles were changed by this recovery.

## Scope and routing

The interactive continuation used an explicitly accepted `gpt-6-sol` worker assignment under the owner's 2026-09-30 override. No separate runtime model telemetry was exposed; this records the accepted assignment, not an independently measured model identity. No scheduled job was added or changed. Any future scheduled digest or token-intensive job remains pinned to `gpt-5.6-luna` in both scheduling and invocation, with no fallback.
