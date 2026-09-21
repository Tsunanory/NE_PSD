# Foundation dependency evidence

Generated for Foundation Task 1 on 2026-09-22. Package metadata was read from the npm registry with exact versions; repository metadata and the Photoshop MCP source commit were checked through the official GitHub API. The host is macOS 26.6.1 arm64. Photoshop is not installed on this host, so Photoshop behavior and Windows packaging remain external qualification gates.

## Runtime selection

| Runtime | Selection | Evidence | Status |
|---|---|---|---|
| Node.js | 22.23.2 | [official release index](https://nodejs.org/dist/index.json); [SHASUMS256.txt](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt) | Selected; host currently exposes Node 25.9.0, so Node 22 execution is pending |
| npm | 11.12.1 | `npm --version` on the foundation host | Observed; lockfile is generated with this npm |
| Electron | 41.0.0 | [npm package metadata](https://registry.npmjs.org/electron/41.0.0) | Pinned; Electron-hosted native rebuild is proven on darwin-arm64 |

Node 22.23.2 is the latest Node 22 release in the official index at the time of this record. It satisfies the selected package engines: Vitest 5.0.1 requires Node 22.12.0 or newer, Vite 7.3.6 and the React plugin require Node 22.12.0 or newer, and better-sqlite3 12.9.0 explicitly supports Node 22.x. Electron 41.0.0 declares Node >=12.20.55 and is selected because its native ABI rebuild is compatible with the pinned SQLite driver.

## npm packages

All versions are exact pins. The `integrity` values are npm registry `dist.integrity` values and are also expected in `package-lock.json` after `npm ci`.

| Package | Version | License | Engines | Source | Integrity |
|---|---:|---|---|---|---|
| `typescript` | 7.0.2 | Apache-2.0 | `>=16.20.0` | [npm](https://registry.npmjs.org/typescript/7.0.2) / [GitHub](https://github.com/microsoft/TypeScript) | `sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==` |
| `zod` | 4.6.5 | MIT | not declared | [npm](https://registry.npmjs.org/zod/4.6.5) / [GitHub](https://github.com/colinhacks/zod) | `sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==` |
| `vitest` | 5.0.1 | MIT | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | [npm](https://registry.npmjs.org/vitest/5.0.1) / [GitHub](https://github.com/vitest-dev/vitest) | `sha512-iA95lQbKEkvrtTkdAgnWbXfbipWiiWe/hDl2P5tMi6WFwD76G0NxXAGp/M9EOcYupeGJRr6wppMc7CoA41TQjg==` |
| `playwright` | 1.63.0 | Apache-2.0 | `>=20` | [npm](https://registry.npmjs.org/playwright/1.63.0) / [GitHub](https://github.com/microsoft/playwright) | `sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==` |
| `electron` | 41.0.0 | MIT | `>=12.20.55` | [npm](https://registry.npmjs.org/electron/41.0.0) / [GitHub](https://github.com/electron/electron) | `sha512-U7QueSj1cFj9QM0Qamgh/MK08662FVK555iMfapqU7mcAmIm4A8bZuZptpjMXrT4JNAMGjgWu9sOeO1+RPCJNw==` |
| `vite` | 7.3.6 | MIT | `^20.19.0 \|\| >=22.12.0` | [npm](https://registry.npmjs.org/vite/7.3.6) / [GitHub](https://github.com/vitejs/vite) | `sha512-4XP60spRGjSZFf1qYH+dJIkK2znL3zQfl9KkOV9MkkRR/3Dls0dxaBsQPTloEc5BLXWPL9vsOxopxyKoMmDueg==` |
| `react` | 19.3.0 | MIT | `>=0.10.0` | [npm](https://registry.npmjs.org/react/19.3.0) / [GitHub](https://github.com/facebook/react) | `sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog==` |
| `react-dom` | 19.3.0 | MIT | not declared | [npm](https://registry.npmjs.org/react-dom/19.3.0) / [GitHub](https://github.com/facebook/react) | `sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q==` |
| `sharp` | 0.35.4 | Apache-2.0 | `>=20.9.0` | [npm](https://registry.npmjs.org/sharp/0.35.4) / [GitHub](https://github.com/lovell/sharp) | `sha512-n++8XWcj+jCOr2IOl7h8LbKnGBDY4aPbmprMONBNFdn0ImXqpGVv5zliDs0V9HbmbCQLpbuo2ej9rAoOQTvMDA==` |
| `better-sqlite3` | 12.9.0 | MIT | `20.x \\|\\| 22.x \\|\\| 23.x \\|\\| 24.x \\|\\| 25.x` | [npm](https://registry.npmjs.org/better-sqlite3/12.9.0) / [GitHub](https://github.com/WiseLibs/better-sqlite3) | `sha512-wqUv4Gm3toFpHDQmaKD4QhZm3g1DjUBI0yzS4UBl6lElUmXFYdTQmmEDpAFa5o8FiFiymURypEnfVHzILKaxqQ==` |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | `>=18` | [npm](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.30.0) / [GitHub](https://github.com/modelcontextprotocol/typescript-sdk) | `sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==` |
| `@alisaitteke/photoshop-mcp` | 1.7.19 | MIT | `>=18.0.0` | [npm](https://registry.npmjs.org/@alisaitteke/photoshop-mcp/1.7.19) / [GitHub](https://github.com/alisaitteke/photoshop-mcp/tree/143b69dba18dc5992c56a5d489b6efbfed173e1a) | `sha512-UEsZLBCuSh0TqVpKul6n2BVu3DW/G1gJ6oD8LwLAzBL7eaLTwtay3oSPDf/YHCL8ypvzXQlJEzwsaveCzEzXuA==` |
| `@types/node` | 24.10.1 | MIT | not declared | [npm](https://registry.npmjs.org/@types/node/24.10.1) / [GitHub](https://github.com/DefinitelyTyped/DefinitelyTyped) | `sha512-GNWcUTRBgIRJD5zj+Tq0fKOJ5XZajIiBroOF0yvj2bSU1WvNdYS/dn9UxwsujGW4JX06dnHyjV2y9rRaybH0iQ==` |
| `@types/react` | 19.2.7 | MIT | not declared | [npm](https://registry.npmjs.org/@types/react/19.2.7) / [GitHub](https://github.com/DefinitelyTyped/DefinitelyTyped) | `sha512-MWtvHrGZLFttgeEj28VXHxpmwYbor/ATPYbBfSFZEIRK0ecCFLl2Qo55z52Hss+UV9CRN7trSeq1zbgx7YDWWg==` |
| `@types/react-dom` | 19.2.3 | MIT | not declared | [npm](https://registry.npmjs.org/@types/react-dom/19.2.3) / [GitHub](https://github.com/DefinitelyTyped/DefinitelyTyped) | `sha512-jp2L/eY6fn+KgVVQAOqYItbF0VY/YApe5Mz2F0aykSO8gx31bYCZyvSeYxCHKvzHG5eZjc+zyaS5BrBWya2+kQ==` |
| `@vitejs/plugin-react` | 5.1.2 | MIT | `^20.19.0 \|\| >=22.12.0` | [npm](https://registry.npmjs.org/@vitejs/plugin-react/5.1.2) / [GitHub](https://github.com/vitejs/vite-plugin-react) | `sha512-EcA07pHJouywpzsoTUqNh5NwGayl2PPVEJKUSinGGSxFGYn+shYbqMGBg6FXDqgXum9Ou/ecb+411ssw8HImJQ==` |
| `electron-builder` | 26.0.12 | MIT | `>=14.0.0` | [npm](https://registry.npmjs.org/electron-builder/26.0.12) / [GitHub](https://github.com/electron-userland/electron-builder) | `sha512-cD1kz5g2sgPTMFHjLxfMjUK5JABq3//J4jPswi93tOPFz6btzXYtK5NrDt717NRbukCUDOrrvmYVOWERlqoiXA==` |

## Native and platform qualification

`sharp@0.35.4` publishes optional prebuilt packages for darwin-arm64, darwin-x64, win32-x64, win32-arm64 and the supported Linux architectures. The root lockfile must retain the platform-specific optional entries; `npm ci` on another platform may omit the non-host binaries while preserving the same lock.

`better-sqlite3@12.9.0` is the single application SQLite driver. Its upstream engine declaration covers Node 22 and its native build scripts support `node-gyp rebuild` and Electron runtime rebuilds. The Node host smoke test and the Electron 41.0.0 rebuild command are recorded after installation. A successful npm install alone is not accepted as Electron ABI proof. Electron 42+ was rejected during qualification because its V8 headers require an API newer than this driver; Electron 41.0.0 is the selected compatible pair.

`@alisaitteke/photoshop-mcp@1.7.19` is pinned to npm `gitHead` `143b69dba18dc5992c56a5d489b6efbfed173e1a`, verified through the GitHub commit API. Its repository metadata reports MIT and the package engine is Node >=18. No Photoshop installation exists on this host, so only package qualification is recorded here; live Photoshop behavior remains unqualified.

## Command evidence

The final clean installation and checks were run after the manifests and lockfile settled:

```text
npm ci                                      exit 0
npm run build                               exit 0
npm run check                               exit 0
npm run test:contracts                      1 test passed
npm run test:core                           1 test passed
npm run test:photoshop                      1 test passed
npm run test:intelligence                   1 test passed
npm run test:desktop                        1 test passed
```

`npm ci` emitted expected EBADENGINE warnings because the current host is Node 25.9.0 while the selected workspace engine is Node 22.23.2. It exited 0. npm reported 14 transitive audit findings (13 high, 1 critical) in the current dependency graph; no audit fix was applied because automatic upgrades would change the pinned foundation set. This remains a dependency-review concern for the next release gate.

Native driver proof on this darwin-arm64 host:

```text
node -e '<better-sqlite3 in-memory query>'  -> version 12.9.0, value 42, Node v25.9.0, ABI 141
CXXFLAGS='-isystem /opt/homebrew/opt/llvm/include/c++/v1 -isysroot ...' \
  npm rebuild better-sqlite3 --runtime=electron --target=41.0.0 \
  --dist-url=https://electronjs.org/headers --build-from-source -> exit 0
electron --version                         -> v41.0.0
ELECTRON_RUN_AS_NODE=1 Electron -e '<better-sqlite3 in-memory query>'
                                            -> Electron 41.0.0, embedded Node 24.14.0,
                                               module ABI 145, value 41
```

The initial Electron 44.4.3 and Electron 42.0.0 attempts were rejected because their V8 headers require the tagged `v8::External` API that better-sqlite3 12.9.0 does not compile against. Electron 41.0.0 is the selected compatible version and the direct Electron smoke query passed. This is a macOS arm64 ABI proof; Windows x64 remains an acceptance gate.

## Explicit gates

- The selected Node 22 patch is not the host runtime; install or run it before claiming Node 22 execution.
- The Photoshop MCP package is source-pinned but Photoshop is unavailable on this host; no live PSD capability is claimed.
- Windows x64 packaging and Electron runtime acceptance are not proven by macOS npm/build checks.
- No local Qwen artifact, llama.cpp release, chat template, or vision qualification is present. `runtime-lock.json` records this as `unqualified`, with no fallback.
