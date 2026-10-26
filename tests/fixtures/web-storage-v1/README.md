# Web storage v1 fixtures

Written once by `npm run fixtures:v1` (`tests/fixtures-v1/write.fixtures.ts`) from the editor build
`0.5.22+0d503931`, in the same run as `../../native/fixtures/nxsp-v1`. `SHA256SUMS` pins each file. They are
frozen when v0.6.0 is tagged and never changed after it; every later build reads them
(`tests/browser/formats/webStorageV1.spec.ts`, `tests/local/journalV1.test.ts`,
`tests/local/fixturesV1.test.ts`).

| File | Made by | Holds |
| --- | --- | --- |
| `nse-local-data.json` | Context A, step 13: the database and localStorage of a write-back browser after a week of use, dumped by `dumpDatabase` and `dumpLocalStorage` | Chains M (migrated from the old auto save), A (a file's chain with more than 500 entries), F (a fork, its file taken over), I (an imported level), N (deleted), P (a partial open) and Q (an import left pending), with every v1 store; a pending journal and a `saving.*` marker; chain P's binding with `entry.inexact` (an append after a recognised own Save). Newer-build data added by the script: `zzFixtureChainField` on A, `zzFixtureEntryField` and `x.zzFixtureX` on two of its entries, a later (continued) session of P with a `continue` entry and then one of the kind `zzFixtureKind` |
| `nse-local-data-download.json` | Context D, at its end: a browser without pickers | A chain bound by a confirmed download (`downloaded`, `confirmed`) with `badChunks` |
| `raw-export.zip` | Context A, step 12: Settings › Local Data › Export Raw Data | The ZIP the editor writes: `dump.json`, then one `blobs/<n>` entry per stored file, as the storage-bug guide loads it; its handle rows tagged as a Chromium export writes them |
| `saving-marker-file.nxsp` | Context A, step 13: A's file as the last Save wrote it, whose binding was never recorded | The file the `saving.*` marker in `nse-local-data.json` names: its revision, a document device id derived from this browser's id, and a `save` entry last |
| `journal-unavailable.json` | Context E: storage unavailable, one edit, the journal written after 10 seconds | A journal (`keep` 0), the raw value of its `journal.*` key |

Handles are tagged `{ "$handle": "file", "name": … }` in the dumps, as a real Chromium dump holds
them (`raw-export.zip` is the editor's own output, rebuilt with its handle rows tagged the same way, since the run's override stands for a handle with a plain token). The pending
journal in `nse-local-data.json` is the ordinary v1 form.
