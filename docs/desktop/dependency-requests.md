# Desktop dependency request for A integration

`apps/desktop/package.json` now declares two exact direct dependencies:

| Package | Version | Manifest location | Consumer |
|---|---:|---|---|
| `esbuild` | `0.28.2` | `devDependencies` | The desktop `build` script bundles the CommonJS Electron preload. A transitive installation is not a dependable build contract. |
| `sharp` | `0.35.4` | `dependencies` | Main-process setup decodes every qualification preview and verifies its image format, dimensions, and SHA-256 before confirmation. |

Both versions are already present in the current root lockfile and local installed tree through other workspaces, but the root lockfile's `apps/desktop` workspace entry still omits both direct edges as of 2026-09-30. A owns the root lockfile. In the coordinated integration commit, record those edges while preserving the desktop build script and dependencies against A's security pins. Run a clean `npm ci` with pinned Node `22.23.2`, then desktop typecheck, build, tests, and bundle verification. Installed-tree checks do not establish a clean install or packaged Windows runtime.
