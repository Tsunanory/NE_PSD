# Source and verification status

Planning date: 2026-09-21. The planning documents distinguish owner instructions from source-document recommendations.

| Evidence | Observed status |
|---|---|
| Shared ChatGPT URL | Conversation readable; embedded research panels failed to load. The supplied Markdown supersedes this access blocker. |
| Original report | `/Users/tsunanory/Downloads/deep-research-report.md`; copied byte-for-byte to this directory; 49,884 bytes; SHA-256 `9e7d315fc64a1dd39c1fc1f89a3e71cbe73f2e120d0596673810496c3701ebd8`. |
| Actual PSD | `/Users/tsunanory/Downloads/мокап_готово.psd`; 414,738,410 bytes; SHA-256 `1d14b685b6b9068f55e582c400b29429793f4c6eed8f761447163bbe5dd3bfcd`. Read-only static inspection completed; details and the reproducible parser are in `../photoshop/2026-09-21-static-psd-inspection.md`. Source was not modified. |
| Photoshop qualification | Pending installed Photoshop and access to its running session. Static descriptors do not establish effective vector bounds, precise linkage or render correctness. |
| Dependency/model/Windows qualification | Planned; not performed during document preparation. No repository tool count, model capability or OS compatibility is claimed freshly verified. |

## What the report contributes

The plan adopts the report's primary alisaitteke/photoshop-mcp route and its primitives: open/edit Smart Object, place, bounds-based scale/move, explicit stack ordering, clipping, group visibility, export/save/close and recorded Actions. It rejects the generic batch recipe as a complete solution because the report describes one JPEG per asset, whereas the requirement is three variants plus internal Smart Object processing.

The prepared-placeholder template strategy is retained. Joonas nestedTarget/fill/showLayers/hideLayers is an optional acceleration route subject to explicit license and behavior qualification. DCC/UXP is an alternate adapter candidate, not a second simultaneous controller. The narrower ajfonthemove and Layer-1-dependent xKeNcHii projects and service renderers are not selected for this arbitrary Photoshop hierarchy. Marketplace plugins are not accepted as complete solutions without verified support for reference-layer bounds, alpha clipping and all three states.

The report's source citation tokens and shell snippets are retained as evidence. They are not instructions to execute them. Foundation must retrieve authoritative package/source/license metadata and pin actual revisions before installation or integration. Report source URLs remain discoverable in the copied file; absence of a license is not permission to redistribute or use unlicensed source.

## Requirement traceability

| Owner requirement / research finding | Planned location |
|---|---|
| Three outputs for every asset, lower-layer fit and clipping | B tasks and core artifact/review gate |
| Reuse existing tooling, avoid new Photoshop scripting | B capability qualification, prepared template, optional existing Actions, explicit backend gate |
| Develop on Mac, final Windows | D packaging/live acceptance and A release matrix |
| Local Qwen3.8-27B Q4–Q6, Q8 without feature cuts | C artifact/capacity/quality qualification; common acceptance corpus |
| Precise prompts and instructions | Shared schemas, requirement registry, complete planner, runtime-image-reviewer and diagnostic prompt templates |
| New reviewer session at every runtime iteration; inspect finished images | C vision-capable runtime reviewer, per-variant verdicts and A publication gate |
| Several independently buildable parts | Foundation then A/B/C/D worktrees and fixed path ownership |
| task-observer in every task | Each launch prompt, shared observer anchor, checkpoints/handoff |

The PSD remains outside Git. Runtime instructions will refer to an operator-selected file root on Windows, never assume the Mac Downloads path exists there.
