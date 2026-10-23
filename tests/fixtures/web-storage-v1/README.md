# Web storage v1 fixtures

Written once by `npm run fixtures:v1` (`tests/fixtures-v1/write.fixtures.ts`) from the editor build
`0.5.22+fbabcfff`, in the same run as `../../native/fixtures/nxsp-v1`. `SHA256SUMS` pins each file. They are
frozen when v0.6.0 is tagged and never changed after it; every later build reads them
(`tests/browser/formats/webStorageV1.spec.ts`, `tests/local/journalV1.test.ts`,
`tests/local/fixturesV1.test.ts`).

| File | Made by | Holds |
| --- | --- | --- |
| `nse-local-data.json` | Context A, step 13: the database and localStorage of a write-back browser after a week of use, dumped by `dumpDatabase` and `dumpLocalStorage` | Chains M (migrated from the old auto save), A (a file's chain with more than 500 entries), F (a fork, its file taken over), I (an imported level), N (deleted), P (a partial open) and Q (an import left pending), with every v1 store; a pending journal and a `saving.*` marker; `legacyRecovery` in its v1 form. Newer-build data added by the script: `zzFixtureChainField` on A, `zzFixtureEntryField` and `x.zzFixtureX` on two of its entries, a later session of P with an entry of the kind `zzFixtureKind` |
| `nse-local-data-download.json` | Context D, at its end: a browser without pickers | A chain bound by a confirmed download (`downloaded`, `confirmed`) with `badChunks` |
| `raw-export.zip` | Context A, step 12: Settings › Local Data › Recovery › Export Raw Data… | The ZIP the editor writes (`dump.json`), as the storage-bug guide loads it |
| `journal-unavailable.json` | Context E: storage unavailable, one edit, the journal written after 10 seconds | A journal (`keep` 0), the raw value of its `journal.*` key |
| `legacy-raw.json` | Context A, step 1: the old auto save the first load migrated | The raw level data a v0.5 build left in `autoSave.levelData` |

Handles are tagged `{ "$handle": "file", "name": … }` in the dumps, as a real Chromium dump holds
them (`raw-export.zip` is the editor's own output and keeps the override's tokens). The pending
journal and `legacyRecovery` in `nse-local-data.json` are the ordinary v1 forms of both values.
