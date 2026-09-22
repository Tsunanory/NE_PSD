# Foundation parallel start

Status: `implemented-and-fake-tested`; four isolated development worktrees are ready. No production asset batch was run.

## Baseline

The finalized foundation baseline F is:

```text
641b024f534b12d2b7f8c725ed6ad05fcd1c8155
```

F is the documentation-finalization commit after Task 3 implementation `3f052457c7502c4716e0e14c1c1ca9960b17364f` and runtime-proof correction `61b142812cb3e1d192b94fe3ddd5cf6a0354f3bc`. The four worktree branches below remain exactly at F. Root `master` receives this later metadata commit and therefore will advance beyond F; no worktree branch is moved.

## Worktree map

| Track | Branch | Absolute worktree | HEAD | Owner paths |
|---|---|---|---|---|
| A | `build/core` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/core` | F | `packages/core/`, `tests/core/`, `tests/integration/`, `docs/qualification/`, root manifests/lock/config, CI |
| B | `build/photoshop` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/photoshop` | F | `packages/photoshop/`, `tests/photoshop/`, `docs/photoshop/` |
| C | `build/intelligence` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/intelligence` | F | `packages/intelligence/`, `tests/intelligence/`, `docs/intelligence/` |
| D | `build/desktop` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/desktop` | F | `apps/desktop/`, `tests/desktop/`, `packaging/`, `docs/desktop/` |

All worktrees are sibling directories under the ignored project-local `.worktrees/` directory. None is nested in another worktree. An unrelated detached Codex-managed worktree exists outside this project-local layout and was not modified.

## Installation and fixture verification

Runtime for every command: Node `v22.23.2`, npm `10.9.8`, from `/private/tmp/node-v22.23.2-darwin-arm64/bin`. Each install used the single committed `package-lock.json` and its own cache under `/private/tmp/ne-psd-task4-cache-{core,photoshop,intelligence,desktop}`.

| Worktree | `npm ci` | build prerequisite | `npm run test:contracts` |
|---|---|---|---|
| core | exit 0 | `npm run build`, exit 0 | exit 0; 5 files, 33 tests |
| photoshop | exit 0 | `npm run build`, exit 0 | exit 0; 5 files, 33 tests |
| intelligence | exit 0 | `npm run build`, exit 0 | exit 0; 5 files, 33 tests |
| desktop | exit 0 | `npm run build`, exit 0 | exit 0; 5 files, 33 tests |

Fresh worktrees do not contain ignored `dist/` output, so the build prerequisite was run before the contract suite. The first sandboxed install attempt reported registry `ENOTFOUND`; the same locked `npm ci` succeeded after the required network-permission escalation. No manifest or lockfile was changed in any worktree.

## Launch prompts and shared protocol

- Foundation reference: `docs/superpowers/launch/00-foundation.txt` and `docs/superpowers/plans/2026-09-21-ne-psd/00-foundation.md`.
- A: `docs/superpowers/launch/01-core.txt`, plan `docs/superpowers/plans/2026-09-21-ne-psd/01-core-integration.md`.
- B: `docs/superpowers/launch/02-photoshop.txt`, plan `docs/superpowers/plans/2026-09-21-ne-psd/02-photoshop.md`.
- C: `docs/superpowers/launch/03-intelligence.txt`, plan `docs/superpowers/plans/2026-09-21-ne-psd/03-intelligence-review.md`.
- D: `docs/superpowers/launch/04-desktop.txt`, plan `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md`.

All Mac worktrees use the shared observer anchor `/Users/tsunanory/Desktop/Engines/NE_PSD/skill-observations/observation-log/`. Root contracts and the lockfile are frozen; shared changes go through A. B owns the only Photoshop installation lock. No worktree may mutate the source PSD or original assets. No scheduled, cron, launchd, heartbeat or Task Scheduler job exists in this release.

## Remaining gates

The worktrees establish only Mac contract and fake-backed development readiness. Photoshop installation/controller behavior, Windows 11 x64 packaging and live execution, exact local Qwen3.8-27B artifact/runtime/vision qualification, qualified visual review, and critical audit/security acceptance remain external gates. No fake evidence is presented as Photoshop, Windows or Qwen qualification.
