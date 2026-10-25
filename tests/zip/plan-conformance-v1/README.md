# The plan conformance set, v1

Frozen with Formats v1: the same plan gives the same bytes on every platform. The web executor (`tests/zip/planConformance.test.ts`) runs every case, and any other writer of the format must reproduce them. Never edit these files once v0.6.0 ships.

Each `<case>/` holds:

- `plan.json`: the `WritePlan`, each `bytes` part's data as `{ "$u8": "<standard base64, padded>" }`, each copy's `source` naming a file in the case, and `modified`.
- The sources: `source.nxsp` where the plan copies.
- `pinned.json`: each source's `inspect` result, `{ fingerprint, size, entries }`, `entries` being the central directory with each entry's `dataOffset` read from its local header. The fingerprint is a literal: `zip:<size>:0:<cd>`.
- `hook.json`, when present: `{ "change": "<source>", "to": "<file>", "fingerprint": "<literal>" }`, a source whose bytes change between `inspect` and the copy: the executor reads `to`'s bytes in its place, and reading the source's fingerprint again gives `fingerprint`. An executor reads a source's fingerprint before it reports any check that depends on the source's bytes (an entry index, a `dataOffset`, a method, a planned CRC or size of an entry with copies), so a changed source is a `conflict`, never a plan error.
- `expected.nxsp`, the exact bytes, or `expected-error.json`, `{ "code": "io" | "conflict" | "plan" }`.

**Pass criteria:** an executor produces `expected.nxsp` byte for byte or fails with the expected code; its `inspect` of every source gives `pinned.json`; every `expected.nxsp` passes `uv run python -I tools/nxsp_check.py`.

The cases: `fresh` and `append` (the builder golden's two writes); appends onto `write-1.nxsp` rewritten as other tools write it: `source-deflated-descriptors` (DEFLATE throughout, data descriptors with and without their signature, so `chunks.bin` and the media are `inflate` copies), `source-local-extra` (local extra fields that differ from the central directory's), `source-zip64` (ZIP64 extra fields and end record) and `source-comment-signature` (an archive comment holding an end-record signature); and the failures: `fail-crc-mismatch`, `fail-inflate-trailing`, `fail-inflate-truncated` and `fail-bomb` (a deflated `chunks.bin` inflating past its declared size) are damage in the source (`io`); `fail-changed-bytes` (the source rewritten after `inspect` with a longer `project.json`, so every copy's `dataOffset` moved) is a `conflict`; `fail-method-mismatch`, `fail-wrong-crc`, `fail-too-many-entries` (65,535 entries), `fail-method8-two-parts`, `fail-method8-inflate` and `fail-dataoffset-mismatch` are plan errors.

Written by `NSE_WRITE_GOLDEN=1 npx tsx --test tests/zip/planConformance.test.ts`, from the builder golden (`tests/local/nxsp/golden-v1/`).
