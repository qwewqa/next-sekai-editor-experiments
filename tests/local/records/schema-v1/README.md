# `schema-v1` vectors

Frozen with Formats v1. Each file is `{ "record": <form>, "value": <JSON form> }`, read with `JSON.parse` (so `1e400` reads as `Infinity`). `accepted/` must pass the v1 schema and `rejected/` must fail it; `tests/local/records/schema.test.ts` runs both. A later build that tightens `schema.ts` so a v0.6.0 value no longer passes, or loosens it so a broken one does, fails CI. Never edit these files.

`header` values are checked whole (form, id rules and folder links), `root` and `node` values with their validity rules. A `snapshot` value is `{ "root": <hash>, "records": { <hash>: <JSON form> } }`: every record it reaches, by the hash of its canonical bytes, decoded from the root as a reader decodes a stored snapshot.

The rules these pin beside `fields-v1.json`'s types:

- **References:** a field with `ref` names an id of that header map: a note's `groupId` and `stageId`, a time scale's `groupId`, a stage event's `stageId`, a group's `folderId` (in `groupFolders`), a stage's (in `stageFolders`), and a folder's (in the folder map holding it). A snapshot whose records name an id its header lacks is invalid (`snapshot-*-missing-*`, `header-*-missing`, `header-*-in-*`). A field with `acyclic` (a folder's `folderId`) never loops within its map: a folder that is its own parent, or whose parent chain comes back to it, is invalid in either folder map (`header-*-own-parent`, `header-*-cycle`); nesting of any depth without a loop reads (`header-folder-chains`).
- **Integers:** `id` and `uint` are judged by value, any spelling: `1.0`, `1e0` and `1E0` are the id 1, `-0` is the `uint` 0 and never an id, and nothing past `2^53 − 1` is one (`*-integer-spellings`, `folder-negative-zero-id`, `folder-id-past-safe`). The writer spells integers only as plain digits, so a chunk spelled otherwise is other bytes with another hash: it reads under its own hash, never under the canonical one (`chunkVerify.test.ts`). A JSON parser that yields floats for `1.0` (Python, serde_json's `Value`) checks integrality on the value.
- **Empty body chunks** read as no records (`snapshot-empty-chunk`). The writer never makes one.
- **The kind order** is `fields-v1.json`'s `kindOrder` array. JSON object key order means nothing: a reader that keeps none (serde_json without `preserve_order`) still reads every table, and takes no order from `kinds` or `enums`.
