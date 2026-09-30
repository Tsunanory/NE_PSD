# D-R6b Electron GUI endurance — 2026-09-30

The real installed Electron app, context-isolated preload, development-only fake service and React `JobStore` completed both 10,000-asset GUI tests under Node 22.23.2. The app was launched outside the macOS sandbox because macOS app registration aborts inside it. Each test used a fresh temporary Electron user-data directory, preventing persisted jobs from blocking safe-close at teardown.

| Measurement | Actual result |
| --- | ---: |
| Assets | 10,000 |
| GUI start to connected job ID | 466 ms |
| Renderer animation-frame p95 | 18.6 ms |
| Main RSS before / after | 162,807,808 / 168,460,288 bytes |
| Main RSS increase | 5,652,480 bytes |
| Visible asset DOM rows | ≤50 |
| Active job subscriptions | 1 |
| Final snapshot | completed; 10,000 / 10,000 |
| Last event sequence / event count | 4 / 4 |

The completion case exercised GUI pause and resume, then explicit fake completion. The cancellation case exercised GUI cancel and verified the 10,000-asset cancelled snapshot. Both passed in 10.2 seconds; a second JSON-reporter run passed and supplied the metrics above. `apps/desktop/src/renderer/App.tsx` subscribes before snapshot hydration and exposes the fake start control only when the development bridge provides it. The main IPC additionally gates fake channels on explicit development fake mode and an unpackaged app.

The fake corpus is schema-valid and deterministic. It does not run Photoshop, qualify the requested local model, visually inspect images, or establish Windows performance. Those release gates remain external.
