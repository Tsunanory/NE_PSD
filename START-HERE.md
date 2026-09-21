# Next action

Open [the foundation launch prompt](docs/superpowers/launch/00-foundation.txt), copy its text, and paste it into a new Codex task in this `NE_PSD` folder. About one minute of setup for you.

This folder contains plans, prompts and source evidence. Application code has not been built. Photoshop installation is not required to start foundation or the four independent builds; live template validation and final Windows acceptance wait for Photoshop.

1. Run foundation once. It freezes contracts, installs pinned tooling, creates a tested Git baseline and prepares four worktrees.
2. Open four tasks using the worktree paths recorded in `docs/qualification/parallel-start.md`. Paste the matching [core](docs/superpowers/launch/01-core.txt), [Photoshop](docs/superpowers/launch/02-photoshop.txt), [Qwen/review](docs/superpowers/launch/03-intelligence.txt) and [desktop/Windows](docs/superpowers/launch/04-desktop.txt) launch prompts. They can run together.
3. Let the core/integration task combine the tested branches. Once Photoshop and a Windows host are available, it runs the live acceptance gates.

Every task invokes task-observer. During Windows jobs, a fresh reviewer session inspects each finished variant before the three exports are published. This reviewer belongs to the running application, not the development process.

| Read when needed | File |
|---|---|
| Decisions and exact shared interfaces | [Design and contract](docs/superpowers/specs/2026-09-21-ne-psd-design.md) |
| Separate build plans | [Foundation](docs/superpowers/plans/2026-09-21-ne-psd/00-foundation.md), [A](docs/superpowers/plans/2026-09-21-ne-psd/01-core-integration.md), [B](docs/superpowers/plans/2026-09-21-ne-psd/02-photoshop.md), [C](docs/superpowers/plans/2026-09-21-ne-psd/03-intelligence-review.md), [D](docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md) |
| How concurrent workers avoid conflicts | [Parallel build rules](docs/superpowers/parallel-build.md) |
| Source findings and limits | [Research](docs/research/deep-research-report.md), [source status](docs/research/source-status.md) |

The label `Qwen3.8-27B` still needs an exact downloadable artifact and runtime qualification. Q4/Q6/Q8 run the same feature set and tests. Lower quantization does not reduce the requirements. Automatic image checking requires qualified vision: the requested Qwen if supported, otherwise an explicitly configured vision reviewer while Qwen remains the brain. Human approval is a manual exception mode; text-only checks cannot certify appearance.
