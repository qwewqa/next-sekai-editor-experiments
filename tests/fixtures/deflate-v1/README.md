# `deflate-v1` vectors

Frozen with Formats v1 (§1.6.11.1, the strict end check). A chunk's stored form is one raw DEFLATE stream (RFC 1951) that must end exactly at its last byte. `vectors.json` classifies each file: `valid` ones inflate to `canonical.bin` (a one-slide chunk's canonical bytes), and `damage` ones must be refused: one trailing byte, truncated by one byte, two concatenated streams, and a stream whose last block isn't final (a sync flush with no final block). The JS reader test (`tests/local/records/chunkVerify.test.ts`) and the apps' `cargo test` classify them identically.

Made once with `pako` 3.0.1: `deflateRaw` at its default level and at level 0, and `Deflate({ raw: true }).push(bytes, Z_SYNC_FLUSH)` for the non-final stream. Never edit these files.
