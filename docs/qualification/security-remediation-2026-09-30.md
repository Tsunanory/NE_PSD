# Electron dependency security remediation — 2026-09-30

Status: **blocked before lockfile update**. No dependency pin or lock entry was changed by this packet. The saved 2026-09-21 audit still marks release security review blocked; this document does not accept risk or claim a clean current audit.

## Evidence available without uploading the project dependency inventory

- `docs/qualification/npm-audit-evidence.json` recorded 13 vulnerable package nodes (12 high, 1 critical) on 2026-09-21. A read-only comparison on 2026-09-30 found all 13 at the same versions in the current lockfile. That comparison establishes persistence of the **known** findings; it cannot discover newer advisories or prove a candidate fix.
- The two direct roots remain exact `electron: 41.0.0` and `electron-builder: 26.0.12` in `package.json`. The saved report identifies their transitive `extract-zip: 2.0.1` and `tar: 6.2.1` paths, plus builder/rebuild helper findings. `tar: 6.2.1` is the saved critical finding.
- Individual public npm metadata for `electron@41.10.7` and `electron-builder@26.15.3` was fetched without submitting a project manifest. Both versions exist. Electron declares Node `>= 22.12.0`; builder declares Node `>=14.0.0`, so both admit the pinned development Node `22.23.2`. This only checks published package metadata, not Electron's embedded Node/native ABI or Windows packaging.
- Published tarball integrity fields: Electron `sha512-AqIiefddlf5i+HYCGatr8VlBuEbWJpad4/yloBFYcMB2r57j7xhW1ogiJ+BfA5kxQyfmSs5yjwy54Me+wJn1jw==`; builder `sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==`. These are registry metadata; their tarballs were not installed or independently executed.
- Builder 26.15.3 declares exact `app-builder-lib`, `builder-util`, and `dmg-builder` 26.15.3 plus `builder-util-runtime` 9.7.0. Electron 41.10.7 declares `@electron/get` `^5.0.0` and `@electron-internal/extract-zip` `^1.0.1`. The actual resolved transitive tree still needs a generated lockfile and inspection.

## Reviewable dependency change once registry access is authorized

Change only the two root devDependency pins:

```diff
-    "electron": "41.0.0",
-    "electron-builder": "26.0.12",
+    "electron": "41.10.7",
+    "electron-builder": "26.15.3",
```

Under the pinned Node 22.23.2/npm 10.9.8, generate the single root lockfile with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and a task-local cache. Do not replace the moving core worktree's `node_modules`. Inspect the diff for only the necessary resolution changes and verify manifest/lock exact pins, integrity records, package engines, and removal of the saved vulnerable versions. In particular, verify the resolved `tar` tree against the saved report's `>=7.5.21` target. If a compatible builder still selects a vulnerable transitive version, investigate a **narrow** override against its actual API/engine constraints before adding it; no blind override is proposed. Commit root manifest, generated lockfile, and updated evidence together.

The exact candidate versions came from the older audit's suggestions. A fresh, authorized audit is required after resolution to establish current advisories; zero vulnerabilities must not be inferred from these two pins. The former Electron 41.0.0 native-module smoke in `runtime-lock.json` does not qualify 41.10.7. Rebuild native modules in an isolated checkout, rerun desktop/package tests, inspect installer contents, and have D qualify install/update/uninstall and native loading on Windows. Preserve the prior runtime-lock result as historical until those gates pass.

## Blocked network actions

1. A fresh read-only `npm audit` was attempted on 2026-09-30. Automatic approval review rejected it because the npm registry request could disclose the project's dependency metadata, including private package names, without explicit authorization for that destination. It did not run. No current audit result exists.
2. The lockfile-only npm update was attempted with `--ignore-scripts --no-audit --no-fund`. Automatic approval review rejected it for the same project-metadata disclosure risk. It did not run. An offline attempt with a separate temporary cache failed `ENOTCACHED`; offline lookups in the existing local npm cache also lacked these two candidate versions. No indirect network route was used after rejection.

The remaining approval is specific: allow npm to send the project's dependency metadata to `registry.npmjs.org` for lockfile resolution and, separately, for a fresh audit. Until then, the existing pins and release security gate remain unchanged.
