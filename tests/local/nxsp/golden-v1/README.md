# `.nxsp` v1: the builder golden

Frozen with Formats v1. `tests/local/nxsp/golden.test.ts` builds a fixed chain with fixed `{ now, newId, device, appVersion }`: a first session (an import, a row whose state the file does not hold, `kept: false`, an edit, a BGM change, a Save) and a second that writes back to the first file (a continue, an edit, a cover change, a Save that appends). Every later build must plan exactly this. Never edit these files once v0.6.0 ships.

- `store.json`: the chunks' stored forms (raw DEFLATE), inputs, so a pako change never changes a plan. The test checks each inflates to its record's canonical bytes.
- `plan-1.json`, `plan-2.json`: the two plans, with deflated parts inflated, JSON parts as parsed values and binary parts (`chunks.bin`'s new chunks, media) in base64. `plan-2.json`'s copies name the source `golden`, which is `write-1.nxsp`.
- `write-1.nxsp`, `write-2.nxsp`: the files the plans execute to. The test compares entry by entry (names, methods, CRCs, sizes, uncompressed bytes), so a pako change doesn't fail it; CI runs the independent checker over them:

```
uv run python -I tools/nxsp_check.py tests/local/nxsp/golden-v1/write-1.nxsp tests/local/nxsp/golden-v1/write-2.nxsp
```

Written by `NSE_WRITE_GOLDEN=1 npx tsx --test tests/local/nxsp/golden.test.ts`. Never again once v0.6.0 ships.

`plan-2.json` and `write-2.nxsp` were regenerated before v0.6.0 shipped, because `nse.continue` dropped its `source` field. This follows the owner ruling of 2026-10-19: until Stage 1 ships, codecs and formats change in place at v1, as nothing has shipped. No other operation in the golden chain changed shape.

The format freeze package regenerated all four files before v0.6.0 shipped (the same ruling): `project.json` gained `patch` (0, after `minor`), and each `save` entry gained `appVersion` (the app version that wrote that Save). Nothing else in the chain changed shape. The policy for changing a format after the ship is `docs/format-versioning.md`.
