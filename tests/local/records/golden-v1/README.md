# Snapshot encoding v1: golden vectors

Frozen with Formats v1. Every later build encodes the golden chart and the edge chart (`tests/local/records/charts.ts`) to exactly these records, with root `v` 1 at `levelVersion` 1; `tests/local/records/golden.test.ts` checks it. Never edit these files once v0.6.0 ships.

- `snapshot.json`: the root, the header chunk, the kind nodes (each kind's depth-0 nodes before its depth-1 node) and the body chunks, by hash.
- `records/<hash>.canonical`: each record's canonical bytes, exactly; they are its JSON form. The file's name is its hash.
- `edge/`: the edge chart, the same way. Its `headerVariants` are header chunks of the same chart with other level info and BGM forms (rating unset, empty level info, a BGM with a duration).

Besides the field lists, the golden chart has a stage in a stage folder and a nested folder (a stage's and a folder's `folderId`), and the edge chart has two BPMs at one beat and two time scales at one beat on one group, each stored in the reverse of byte order, and 73 camera events, so an event kind over 64 records splits by window.

**Text a reader must accept:** the edge header holds a lone surrogate, written `"\ud83d"` as `QuoteJSONString` writes it. A non-JS reader that parses records must accept lone-surrogate escapes. serde_json refuses them into a `String`, which is fine while Rust only inflates and hashes records (Part 3, 3.4.7); Python's `json` accepts them.

**Independent check.** The hashes were recomputed with a separate tool over the files, and each must equal the file's name:

```
uv run python -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()[:32])" <file>
```

To read a record with field names, use the debug viewer: `inspectRecord(form, JSON.parse(text))` from `src/local/records/inspect.ts`, or `inspectSnapshot`.

Written by `NSE_WRITE_GOLDEN=1 npx tsx --test tests/local/records/golden.test.ts`, with the `records/` folders emptied first so no stale file stays; last before v0.6.0. Never again once it ships.
