# Foundation dependency evidence

Generated for Foundation Task 1 correction round on 2026-09-22. The selected runtime is Node.js 22.23.2 with its bundled npm 10.9.8. Every registry dependency below is an exact pin and its `resolved` and `integrity` values are copied from the checked-in `package-lock.json`. The lockfile was generated under the selected runtime with npm's `--legacy-peer-deps` resolver because npm 10.9.8 otherwise fails in Arborist while resolving the optional Vitest browser peer; the choice is explicit and reproducible.

## Runtime selection

| Runtime | Selection | Evidence | Status |
|---|---|---|---|
| Node.js | 22.23.2 | Official release index and SHA-256 `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6` for the verified darwin-arm64 archive | Executed with the selected binary |
| npm | 10.9.8 | Bundled with Node.js 22.23.2 | Executed with the selected runtime |
| Engine enforcement | Node.js `22.23.2`; npm `10.9.8`; `.npmrc` `engine-strict=true` | Root and workspace manifests | Checked in |
| Electron | 41.0.0 | [npm package metadata](https://registry.npmjs.org/electron/41.0.0) | Pinned; darwin-arm64 native rebuild proven |

Node.js 22.23.2 is the selected LTS patch. The archive was checksum-verified before use. The workspace and every package manifest use exact Node 22.23.2 engines; npm strict-engine enforcement is checked in at the repository root.

## Direct dependency ledger

The table includes every registry dependency declared by the root or workspace manifests and every local workspace package in the root workspaces list. `OS/CPU` is the package-level restriction recorded by the lockfile; platform-specific optional packages remain in the lockfile for cross-platform installation.

| Package | Version | License | Engines | OS/CPU | Resolved | Integrity |
|---|---:|---|---|---|---|---|
| `@alisaitteke/photoshop-mcp` | 1.7.19 | MIT | `>=18.0.0` | any | `https://registry.npmjs.org/@alisaitteke/photoshop-mcp/-/photoshop-mcp-1.7.19.tgz` | `sha512-UEsZLBCuSh0TqVpKul6n2BVu3DW/G1gJ6oD8LwLAzBL7eaLTwtay3oSPDf/YHCL8ypvzXQlJEzwsaveCzEzXuA==` |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | `>=18` | any | `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz` | `sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==` |
| `@ne-psd/contracts` | 0.1.0 | private | `22.23.2` | any | `packages/contracts` | n/a (workspace link) |
| `@ne-psd/core` | 0.1.0 | private | `22.23.2` | any | `packages/core` | n/a (workspace link) |
| `@ne-psd/desktop` | 0.1.0 | private | `22.23.2` | any | `apps/desktop` | n/a (workspace link) |
| `@ne-psd/intelligence` | 0.1.0 | private | `22.23.2` | any | `packages/intelligence` | n/a (workspace link) |
| `@ne-psd/photoshop` | 0.1.0 | private | `22.23.2` | any | `packages/photoshop` | n/a (workspace link) |
| `@types/node` | 24.10.1 | MIT | not declared | any | `https://registry.npmjs.org/@types/node/-/node-24.10.1.tgz` | `sha512-GNWcUTRBgIRJD5zj+Tq0fKOJ5XZajIiBroOF0yvj2bSU1WvNdYS/dn9UxwsujGW4JX06dnHyjV2y9rRaybH0iQ==` |
| `@types/react` | 19.2.7 | MIT | not declared | any | `https://registry.npmjs.org/@types/react/-/react-19.2.7.tgz` | `sha512-MWtvHrGZLFttgeEj28VXHxpmwYbor/ATPYbBfSFZEIRK0ecCFLl2Qo55z52Hss+UV9CRN7trSeq1zbgx7YDWWg==` |
| `@types/react-dom` | 19.2.3 | MIT | not declared | any | `https://registry.npmjs.org/@types/react-dom/-/react-dom-19.2.3.tgz` | `sha512-jp2L/eY6fn+KgVVQAOqYItbF0VY/YApe5Mz2F0aykSO8gx31bYCZyvSeYxCHKvzHG5eZjc+zyaS5BrBWya2+kQ==` |
| `@vitejs/plugin-react` | 5.1.2 | MIT | `^20.19.0 or >=22.12.0` | any | `https://registry.npmjs.org/@vitejs/plugin-react/-/plugin-react-5.1.2.tgz` | `sha512-EcA07pHJouywpzsoTUqNh5NwGayl2PPVEJKUSinGGSxFGYn+shYbqMGBg6FXDqgXum9Ou/ecb+411ssw8HImJQ==` |
| `better-sqlite3` | 12.9.0 | MIT | `20.x or 22.x or 23.x or 24.x or 25.x` | any | `https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.9.0.tgz` | `sha512-wqUv4Gm3toFpHDQmaKD4QhZm3g1DjUBI0yzS4UBl6lElUmXFYdTQmmEDpAFa5o8FiFiymURypEnfVHzILKaxqQ==` |
| `electron` | 41.0.0 | MIT | `>=12.20.55` | any | `https://registry.npmjs.org/electron/-/electron-41.0.0.tgz` | `sha512-U7QueSj1cFj9QM0Qamgh/MK08662FVK555iMfapqU7mcAmIm4A8bZuZptpjMXrT4JNAMGjgWu9sOeO1+RPCJNw==` |
| `electron-builder` | 26.0.12 | MIT | `>=14.0.0` | any | `https://registry.npmjs.org/electron-builder/-/electron-builder-26.0.12.tgz` | `sha512-cD1kz5g2sgPTMFHjLxfMjUK5JABq3//J4jPswi93tOPFz6btzXYtK5NrDt717NRbukCUDOrrvmYVOWERlqoiXA==` |
| `playwright` | 1.63.0 | Apache-2.0 | `>=20` | any | `https://registry.npmjs.org/playwright/-/playwright-1.63.0.tgz` | `sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==` |
| `react` | 19.3.0 | MIT | `>=0.10.0` | any | `https://registry.npmjs.org/react/-/react-19.3.0.tgz` | `sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog==` |
| `react-dom` | 19.3.0 | MIT | not declared | any | `https://registry.npmjs.org/react-dom/-/react-dom-19.3.0.tgz` | `sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q==` |
| `sharp` | 0.35.4 | Apache-2.0 | `>=20.9.0` | any | `https://registry.npmjs.org/sharp/-/sharp-0.35.4.tgz` | `sha512-n++8XWcj+jCOr2IOl7h8LbKnGBDY4aPbmprMONBNFdn0ImXqpGVv5zliDs0V9HbmbCQLpbuo2ej9rAoOQTvMDA==` |
| `typescript` | 7.0.2 | Apache-2.0 | `>=16.20.0` | any | `https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz` | `sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==` |
| `vite` | 7.3.6 | MIT | `^20.19.0 or >=22.12.0` | any | `https://registry.npmjs.org/vite/-/vite-7.3.6.tgz` | `sha512-4XP60spRGjSZFf1qYH+dJIkK2znL3zQfl9KkOV9MkkRR/3Dls0dxaBsQPTloEc5BLXWPL9vsOxopxyKoMmDueg==` |
| `vitest` | 4.1.11 | MIT | `^20.0.0 or ^22.0.0 or >=24.0.0` | any | `https://registry.npmjs.org/vitest/-/vitest-4.1.11.tgz` | `sha512-fhACrNXUidIbGSBr5FlbuBkO7VWC1ZyLl0DO4CU2DrQoAPxX84Ysxs+HeGQpii5lZWV1Q4gBZTTu49mF+A6Edw==` |
| `zod` | 4.6.5 | MIT | not declared | any | `https://registry.npmjs.org/zod/-/zod-4.6.5.tgz` | `sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==` |

## Native and platform qualification

`sharp@0.35.4` retains platform-specific optional packages in the lockfile for darwin-arm64, darwin-x64, win32-x64, win32-arm64 and supported Linux architectures. `npm ci` on another platform may omit non-host binaries while preserving the same lock.

`better-sqlite3@12.9.0` is the single application SQLite driver. The selected Node 22.23.2 host smoke test and the Electron 41.0.0 darwin-arm64 rebuild/smoke test are recorded below after execution. Electron 42+ was rejected during foundation because its V8 headers did not compile against this driver; Electron 41.0.0 is the selected compatible pair. Windows x64 remains unqualified.

`@alisaitteke/photoshop-mcp@1.7.19` is pinned to npm `gitHead` `143b69dba18dc5992c56a5d489b6efbfed173e1a`, verified through the GitHub commit API. Its package metadata reports MIT and Node >=18. No Photoshop installation exists on this host, so live PSD behavior remains unqualified.

Vitest 4.1.11 is the selected test runner. Official metadata supports Node 22 and Vite 7; the previous Vitest 5 pin was removed during correction so the manifest, lockfile and compatibility evidence agree.

## Command evidence

The correction-round commands and exact results are appended to the foundation report at `.superpowers/sdd/00-foundation/task-1-report.md`. The required clean-checkout order is: `npm ci`, `npm run build`, `npm run check`, then the five smoke suites. All are run with the selected Node 22.23.2 binary.

## Audit evidence

`npm audit --json` is run against the corrected lockfile under Node 22.23.2. Advisory IDs, affected dependency paths, runtime reachability, remediation status and any release-blocking exceptions are recorded in the foundation report and committed audit evidence; no automatic audit fix is applied.

## External release gates

- Photoshop is not installed on this host; live PSD inspection, qualification and render behavior remain unqualified.
- Windows 11 x64 packaging, installation and Electron/native acceptance remain unqualified.
- No local Qwen artifact, llama.cpp release, chat template or vision qualification is present. `runtime-lock.json` records this without fallback.
