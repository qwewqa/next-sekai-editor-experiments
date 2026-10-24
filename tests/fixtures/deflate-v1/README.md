# `deflate-v1` vectors

Frozen with Formats v1 (the strict end check). A chunk's stored form is one raw DEFLATE stream (RFC 1951) that must end exactly at its last byte. `vectors.json` classifies each file: `valid` ones inflate to `canonical.bin` (the canonical bytes of one slide record, a slide of one note), and `damage` ones must be refused:

- **End of stream:** one trailing byte, truncated by one byte, two concatenated streams, and a stream whose last block isn't final (a sync flush with no final block).
- **Malformed bitstreams:** the reserved block type 3, a stored block whose `NLEN` isn't the complement of `LEN`, a fixed-Huffman match whose distance reaches before the start, the fixed literal/length code 286 (which no stream may use), and a dynamic block whose code-length code set is over-subscribed (four codes of length 1) or incomplete (one code of length 2).

The JS reader test (`tests/local/records/chunkVerify.test.ts`) and the apps' `cargo test` classify them identically.

Made once: the valid and end-of-stream files with `pako` 3.0.1 (`deflateRaw` at its default level and at level 0, and `Deflate({ raw: true }).push(bytes, Z_SYNC_FLUSH)` for the non-final stream); the malformed ones written bit by bit, each refused by zlib (`zlib.decompressobj(-15)`) and by `pako`. Never edit these files.
