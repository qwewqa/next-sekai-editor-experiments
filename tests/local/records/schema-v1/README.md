# `schema-v1` vectors

Frozen with Formats v1 (§1.6.11.1). Each file is `{ "record": <form>, "value": <JSON form> }`, read with `JSON.parse` (so `1e400` reads as `Infinity`). `accepted/` must pass the v1 schema and `rejected/` must fail it; `tests/local/records/schema.test.ts` runs both. A later build that tightens `schema.ts` so a v0.6.0 value no longer passes, or loosens it so a broken one does, fails CI. Never edit these files.

`header` values are checked whole (form and id rules), `root` and `node` values with their validity rules.
