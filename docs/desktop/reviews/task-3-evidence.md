# Task 3 evidence

Synthetic model fixtures cover offline endpoint, wrong artifact/digest, runtime and chat-template identity, independent schema/tools/vision capabilities, measured capacity and latency, requested Qwen3.8-27B identity, exact Q4/Q6/Q8 lower bounds, text-only review messaging and deferred scheduled Luna. Synthetic evidence is labelled in the renderer and does not establish a real model qualification.

Commands:

- `npm run test:desktop -- tests/desktop/model-setup.test.tsx tests/desktop/model-endpoint.test.ts` — pass after the RED/GREEN cycle; included by the full suite.
- `npm run test:desktop` — pass, 8 files, 19 tests.
- `npm run typecheck -w @ne-psd/desktop` — pass.
- `npm run build -w @ne-psd/desktop` — pass.
- `npm run test:e2e:desktop -- tests/desktop/model-setup.e2e.test.ts` — blocked: Electron process reported `Error: Process failed to launch!`.
