# D-R2 controlled setup components — 2026-09-30

Status: component packet complete; shared SetupWizard/main controller wiring belongs to the integration packet.

The PSD, input and output pickers invoke passed native-picker callbacks. A cancelled picker leaves the previous label visible. Assets show accepted stable IDs and per-file rejection reasons, with 50-row pages so a 10,000-image folder does not create 10,000 DOM rows. Output format, dimensions, JPEG quality and sRGB come from the frozen `OutputSpec`; invalid edits do not produce a new spec. PNG disables the JPEG quality input while retaining its value.

Selector details show the full nested document route and segment fingerprints, parent/embedded/linked relationships, observed group state and role hints. Target, reference and each variant are controlled selections with an explicit confirmation action. Fit controls explain cover, contain and stretch, disable unqualified modes, and offer explicit confirmation. Qualification displays only a complete three-image set matching the supplied profile digest. Production blocks synthetic previews; `allowSynthetic` permits all-three synthetic previews only in an explicitly enabled fake development flow and labels that flow as synthetic. The view never generates preview bytes or qualification evidence.

## Checks

From `/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/desktop`, using pinned Node 22.23.2/npm 10.9.8:

- RED: `npm run test:desktop -- tests/desktop/setup-components.test.tsx` exited 1: all five initial assertions failed on missing controlled behavior.
- GREEN: same focused command exited 0: 1 file, 6 tests, including 10,000-asset bounded rendering and synthetic-only dev preview regression.
- `npm run typecheck -w @ne-psd/desktop` exited 0.
- `npm run build -w @ne-psd/desktop` exited 0 after removing a renderer runtime import of the Node-backed contracts root. `OutputSpec` remains type-only; the small UI input guard does not replace main's frozen schema validation.

The tests use frozen contract fixtures and synthetic image data. They do not establish live Photoshop preview correctness or installed Windows behavior. The actual callback wiring, path selection, qualification and start admission must remain in main/SetupWizard with trusted service results. The existing legacy props remain supported until that wiring lands.
