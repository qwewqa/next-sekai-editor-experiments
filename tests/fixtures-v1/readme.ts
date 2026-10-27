// The two folders' README.md files: what each fixture holds and which step made it.

export const nxspReadme = (build: string) => `# \`.nxsp\` v1 fixtures

Written once by \`npm run fixtures:v1\` (\`tests/fixtures-v1/write.fixtures.ts\`) from the editor build
\`${build}\`: the real editor in Chromium on a dev server, driven through a scripted scenario
(\`tests/fixtures-v1\`). Each file is what that build wrote, and \`SHA256SUMS\` pins its bytes.

They are frozen when v0.6.0 is tagged and never changed after it. Every later build opens each one
(\`tests/zip/nxspV1.test.ts\`, \`tests/browser/formats/nxspWriteBackV1.spec.ts\`,
\`tests/local/fixturesV1.test.ts\`), and \`check.yml\` runs the independent checker over them. A gap is
filled by running the writer of the \`v0.6.0\` tag, never a later build's.

The files, with the steps that made them (A1 to A13, B, D and E are the writer's steps and
contexts):

| File | Made by | Holds |
| --- | --- | --- |
| \`full.nxsp\` | B: A6's file, opened in another browser and saved back in place | History over two devices' \`save\` entries; every entry kind but \`init\`; a row \`kept: false\`; one segment copied whole beside the head manifest; a carried \`completeFrom\`; the head's BGM, cover and preview with their bytes, earlier ones as metadata only; level info with a rating; group and stage folders; dynamic stages; a stage style event with a Lane Color set (A3, in the Properties panel); notes at third lanes; elevation; a depth-1 kind node; unknown top-level and \`metadata\` keys |
| \`kept-first.nxsp\` | B: the file on its disk replaced by A10's, then Save and the conflict dialog's Replace | \`revision.replaces\` names the revision the Replace wrote over; the base's \`completeFrom\` is carried |
| \`carried.nxsp\` | D: \`full.nxsp\` opened in a browser without pickers, edited and saved (a download) | The base's \`completeFrom\`, carried |
| \`not-carried.nxsp\` | D: a stored chunk only a row of \`full.nxsp\` needs goes bad, and the next Save finds it | \`completeFrom\` is its own revision; the damaged row \`kept: false\` |
| \`media-not-held.nxsp\` | D: Undo to a state whose BGM, cover and preview this browser does not hold, then Save As… | \`bgm\`, \`metadata.cover\` and \`metadata.preview\` without a file, with \`hash\`, \`size\` and \`type\` |
| \`bgm-unticked.nxsp\` | D: back at the head, Save As… with BGM unticked | No \`bgm\` key while the head records a BGM |
| \`no-history.nxsp\` | A8: a level file opened (chain I), one edit, Save with History unticked | No history |
| \`no-media.nxsp\` | A7: File › New (chain N), one edit, Save As… | History from the new level's \`init\` (\`init\`, \`edit\`, \`save\`); no BGM, cover or preview in any state |

A file's \`project.json\` \`appVersion\` is the build's, which predates the 0.6.0 bump. Readers never compare it. A file's \`revision.device.id\` is per document: an HMAC of the lineage under the browser's own id.
`

export const webReadme = (build: string) => `# Web storage v1 fixtures

Written once by \`npm run fixtures:v1\` (\`tests/fixtures-v1/write.fixtures.ts\`) from the editor build
\`${build}\`, in the same run as \`../../native/fixtures/nxsp-v1\`. \`SHA256SUMS\` pins each file. They are
frozen when v0.6.0 is tagged and never changed after it; every later build reads them
(\`tests/browser/formats/webStorageV1.spec.ts\`, \`tests/local/journalV1.test.ts\`,
\`tests/local/fixturesV1.test.ts\`).

| File | Made by | Holds |
| --- | --- | --- |
| \`nse-local-data.json\` | Context A, step 13: the database and localStorage of a write-back browser after a week of use, dumped by \`dumpDatabase\` and \`dumpLocalStorage\` | Chains M (migrated from the old auto save), A (a file's chain with more than 500 entries), F (a fork, its file taken over), I (an imported level), N (deleted), P (a partial open) and Q (an import left pending), with every v1 store; a pending journal and a \`saving.*\` marker; chain P's binding with \`entry.inexact\` (an append after a recognised own Save). Newer-build data added by the script: \`zzFixtureChainField\` on A, \`zzFixtureEntryField\` and \`x.zzFixtureX\` on two of its entries, a later (continued) session of P with a \`continue\` entry and then one of the kind \`zzFixtureKind\` |
| \`nse-local-data-download.json\` | Context D, at its end: a browser without pickers | A chain bound by a download (\`downloaded\`) with \`badChunks\` |
| \`raw-export.zip\` | Context A, step 12: Settings › Local Data › Export Raw Data | The ZIP the editor writes: \`dump.json\`, then one \`blobs/<n>\` entry per stored file, as the storage-bug guide loads it; its handle rows tagged as a Chromium export writes them |
| \`saving-marker-file.nxsp\` | Context A, step 13: A's file as the last Save wrote it, whose binding was never recorded | The file the \`saving.*\` marker in \`nse-local-data.json\` names: its revision, a document device id derived from this browser's id, and a \`save\` entry last |
| \`journal-unavailable.json\` | Context E: storage unavailable, one edit, the journal written after 10 seconds | A journal (\`keep\` 0), the raw value of its \`journal.*\` key |

Handles are tagged \`{ "$handle": "file", "name": … }\` in the dumps, as a real Chromium dump holds
them (\`raw-export.zip\` is the editor's own output, rebuilt with its handle rows tagged the same way, since the run's override stands for a handle with a plain token). The pending
journal in \`nse-local-data.json\` is the ordinary v1 form.
`
