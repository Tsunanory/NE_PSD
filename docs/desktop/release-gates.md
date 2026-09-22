# Release gates

Blocked gates:

- Windows 11 x64 install/upgrade/uninstall and offline acceptance.
- Exact bundled Node/MCP/native runtime resources, hashes, architecture and licenses.
- Photoshop installation/controller and live template qualification.
- Exact Qwen3.8-27B artifact, runtime, chat template, capability, benchmark and visual-review evidence.
- Authenticode signature and timestamp evidence.
- Real Electron/Playwright GUI smoke.

Implementation gaps before a production claim: native file-picker IPC/cancellation wiring, live model endpoint IPC/profile binding, complete deterministic job event/restart scripts, per-operation response schemas, and full JSON runtime-manifest/hash/architecture validation. These are not disguised as external qualification passes.

Passed development gates are fake/unit behavior only. No SmartScreen reputation claim is made. No scheduler is created; future scheduled work remains explicitly Luna-only with no fallback.
