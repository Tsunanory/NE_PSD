# D3 recovery report

Date: 2026-09-22  
Branch: `build/desktop`

## Checkout

- Starting HEAD: `4201baf8dc9ae92e598de39b79f78b3609d6bdb0`
- Starting status: only `AGENTS.md`, `docs/superpowers/launch/04-desktop.txt`, and `docs/superpowers/plans/2026-09-21-ne-psd/04-desktop-windows.md` were modified.
- Final implementation HEAD: recorded in the implementation commit below.

## RED/GREEN

`npm run test:desktop -- tests/desktop/model-setup.test.tsx tests/desktop/model-endpoint.test.ts` first failed because the model endpoint module was absent; after implementation and inclusion of `.test.tsx` in the Vitest pattern it passed. The final focused behavior is covered by the full suite.

## Implementation

Added main-owned loopback endpoint validation with manual redirect rejection, timeout and response-size limits; exact model evidence state with Qwen3.8-27B identity, artifact/runtime/chat-template/quantization/context/output fields, independent capabilities, benchmark and review-gate status; capacity lower bounds and measured resource display; text-only visual-review blocking; scheduled local-Qwen rejection and explicit scheduled-Luna deferral. Renderer model setup is synthetic and unqualified. No scheduler, download, provider fallback, arbitrary endpoint, prompt or tool path exists.

## Commands and results

- `npm run test:desktop -- tests/desktop/model-setup.test.tsx tests/desktop/model-endpoint.test.ts` — pass after correction.
- `npm run test:desktop` — pass, 8 files, 19 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `npm run test:e2e:desktop -- tests/desktop/model-setup.e2e.test.ts` — blocked; Electron process reported `Error: Process failed to launch!`.

## Files and preservation

Changed only D-owned `apps/desktop/`, `tests/desktop/`, `docs/desktop/`, and this report. The three pre-existing documentation modifications were preserved and excluded. Root manifests, lockfiles, contracts, config.toml and A/B/C paths were untouched.

## External gates

Real Qwen3.8-27B artifact/runtime/vision qualification, benchmark evidence, Windows acceptance, signing, Photoshop and live Electron GUI remain blocked. Synthetic values do not imply qualification.

Observer checkpoint recorded in the shared project log.
