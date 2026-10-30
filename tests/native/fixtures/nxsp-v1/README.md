# `.nxsp` v1 fixtures

Originally written by `npm run fixtures:v1` (`tests/fixtures-v1/write.fixtures.ts`) from the editor build
`0.5.22+5f2c53da`: the real editor in Chromium on a dev server, driven through a scripted scenario
(`tests/fixtures-v1`). `SHA256SUMS` pins the current bytes.

Before the v0.6.0 tag, only the derived `sonolus/` entries were refreshed to the five-entry
level package with empty external SRLs and SHA-1 links for included bytes. Every other
entry retains its original compressed bytes and ZIP metadata, including `project.json` and its
producer, revision and history references. See `docs/format-versioning.md` section 8.

They are frozen when v0.6.0 is tagged and never changed after it. Every later build opens each one
(`tests/zip/nxspV1.test.ts`, `tests/browser/formats/nxspWriteBackV1.spec.ts`,
`tests/local/fixturesV1.test.ts`), and `check.yml` runs the independent writer check over them.
The separate `tests/local/nxsp/legacy-test20f/` corpus retains pre-gzip files under reader checks. A gap is
filled by running the writer of the `v0.6.0` tag, never a later build's.

The files, with the steps that made them (A1 to A13, B, D and E are the writer's steps and
contexts):

| File | Made by | Holds |
| --- | --- | --- |
| `full.nxsp` | B: A6's file, opened in another browser and saved back in place | History over two devices' `save` entries; every entry kind but `init`; a row `kept: false`; one segment copied whole beside the head manifest; a carried `completeFrom`; the head's BGM, cover and preview with their bytes, earlier ones as metadata only; level info with a rating; group and stage folders; dynamic stages; a stage style event with a Lane Color set (A3, in the Properties panel); notes at third lanes; elevation; a depth-1 kind node; unknown top-level and `metadata` keys |
| `kept-first.nxsp` | B: the file on its disk replaced by A10's, then Save and the conflict dialog's Replace | `revision.replaces` names the revision the Replace wrote over; the base's `completeFrom` is carried |
| `carried.nxsp` | D: `full.nxsp` opened in a browser without pickers, edited and saved (a download) | The base's `completeFrom`, carried |
| `not-carried.nxsp` | D: a stored chunk only a row of `full.nxsp` needs goes bad, and the next Save finds it | `completeFrom` is its own revision; the damaged row `kept: false` |
| `media-not-held.nxsp` | D: Undo to a state whose BGM, cover and preview this browser does not hold, then Save As… | `bgm`, `metadata.cover` and `metadata.preview` without a file, with `hash`, `size` and `type` |
| `bgm-unticked.nxsp` | D: back at the head, Save As… with BGM unticked | No `bgm` key while the head records a BGM |
| `no-history.nxsp` | A8: a level file opened (chain I), one edit, Save with History unticked | No history |
| `no-media.nxsp` | A7: File › New (chain N), one edit, Save As… | History from the new level's `init` (`init`, `edit`, `save`); no BGM, cover or preview in any state |

A file's `project.json` `appVersion` is the build's, which predates the 0.6.0 bump. Readers never compare it. A file's `revision.device.id` is per document: an HMAC of the lineage under the browser's own id.
