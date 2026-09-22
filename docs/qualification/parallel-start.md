# Foundation parallel start

Status: `implemented-and-fake-tested`. The corrected contract baseline is commit `7a641915104eabb643e3f261674f38bd6b69217d`. No production asset batch or scheduled job was run.

## Exact lane map

| Task | Branch | Absolute worktree | Owner paths | Launch prompt | Plan |
|---|---|---|---|---|---|
| A | `build/core` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/core` | `packages/core/`, `tests/core/`, `tests/integration/`, `docs/qualification/`, root manifests/lock/CI | `docs/superpowers/launch/01-core.txt` | `docs/superpowers/plans/2026-09-21-ne-psd/01-core-integration.md` |
| B | `build/photoshop` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/photoshop` | `packages/photoshop/`, `tests/photoshop/`, `docs/photoshop/` | `docs/superpowers/launch/02-photoshop.txt` | `docs/superpowers/plans/2026-09-21-ne-psd/02-photoshop.md` |
| C | `build/intelligence` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/intelligence` | `packages/intelligence/`, `tests/intelligence/`, `docs/intelligence/` | `docs/superpowers/launch/03-intelligence.txt` | `docs/superpowers/plans/2026-09-21-ne-psd/03-intelligence-review.md` |
| D | `build/desktop` | `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/desktop` | `apps/desktop/`, `tests/desktop/`, `packaging/`, `docs/desktop/` | `docs/superpowers/launch/04-desktop.txt` | `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md` |

All four lane HEADs are byte-identical to the baseline commit. Root `master` owns coordination metadata; lane branches do not receive root-only handoff commits. Coordination metadata is root-only because a commit cannot contain its own SHA.

## Verification

Runtime: Node `v22.23.2`, npm `10.9.8`, PATH `/private/tmp/node-v22.23.2-darwin-arm64/bin`. Each lane completed `npm ci`, `npm run build`, `npm run check`, `npm run test:contracts` (5 files, 40 tests), and `git diff --check`.

Shared observer anchor: `/Users/tsunanory/Desktop/Engines/NE_PSD/skill-observations/observation-log/`. No Photoshop installation, Windows 11 x64 packaging, exact local Qwen3.8-27B artifact/runtime/vision qualification, qualified visual review, or critical audit/security acceptance was performed. Fake evidence does not satisfy those live gates. No cron, launchd, heartbeat, Task Scheduler, or production job exists in this release.
